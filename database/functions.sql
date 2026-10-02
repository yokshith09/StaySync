-- StaySync transactional order logic.
--
-- These functions hold the row-locking rules that stop stock being oversold.
-- They exist as SQL functions rather than as application code because the HTTP
-- transport (PostgREST) cannot hold a transaction across requests: a REST
-- client could not run BEGIN / SELECT FOR UPDATE / COMMIT. Keeping the logic
-- here means the pg driver and the HTTP transport get identical guarantees
-- from one implementation.
--
-- search_path is pinned on every function: a mutable search_path lets a caller
-- shadow the tables these bodies reference.

CREATE OR REPLACE FUNCTION create_order(p_user_id varchar, p_items jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order_id varchar := gen_random_uuid()::varchar;
  v_total int := 0;
  v_line record;
  v_product record;
  v_count int;
BEGIN
  IF jsonb_typeof(p_items) <> 'array' THEN
    RETURN jsonb_build_object('kind', 'invalid_items');
  END IF;

  -- Duplicate product lines are merged below, so a split payload cannot slip
  -- past the stock check by spreading one product across several entries.
  SELECT count(*) INTO v_count
    FROM (SELECT item->>'productId' AS pid FROM jsonb_array_elements(p_items) AS item GROUP BY 1) g;

  IF v_count = 0 OR v_count > 20 THEN
    RETURN jsonb_build_object('kind', 'invalid_items');
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_items) AS item
     WHERE item->>'productId' IS NULL
        OR jsonb_typeof(item->'quantity') <> 'number'
        OR (item->>'quantity')::numeric <> floor((item->>'quantity')::numeric)
        OR (item->>'quantity')::int < 1
        OR (item->>'quantity')::int > 99
  ) THEN
    RETURN jsonb_build_object('kind', 'invalid_items');
  END IF;

  -- Lock every referenced row up front, in a stable id order, before any
  -- mutation. The stable order is what keeps concurrent orders from deadlocking.
  PERFORM 1 FROM products
   WHERE id IN (SELECT item->>'productId' FROM jsonb_array_elements(p_items) AS item)
   ORDER BY id ASC
     FOR UPDATE;

  FOR v_line IN
    SELECT item->>'productId' AS product_id, SUM((item->>'quantity')::int) AS quantity
      FROM jsonb_array_elements(p_items) AS item
     GROUP BY 1 ORDER BY 1
  LOOP
    SELECT * INTO v_product FROM products WHERE id = v_line.product_id;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('kind', 'product_not_found', 'productId', v_line.product_id);
    END IF;
    IF v_product.status <> 'ACTIVE' THEN
      RETURN jsonb_build_object('kind', 'product_unavailable', 'productId', v_product.id, 'name', v_product.name);
    END IF;
    IF v_product.stock_quantity < v_line.quantity THEN
      RETURN jsonb_build_object('kind', 'insufficient_stock', 'productId', v_product.id,
                                'name', v_product.name, 'available', v_product.stock_quantity);
    END IF;

    -- Priced from the locked row, never from the request body.
    v_total := v_total + v_product.unit_price_cents * v_line.quantity;
  END LOOP;

  INSERT INTO orders (id, user_id, status, total_cents) VALUES (v_order_id, p_user_id, 'PENDING', v_total);

  FOR v_line IN
    SELECT item->>'productId' AS product_id, SUM((item->>'quantity')::int) AS quantity
      FROM jsonb_array_elements(p_items) AS item
     GROUP BY 1 ORDER BY 1
  LOOP
    INSERT INTO order_items (id, order_id, product_id, quantity, unit_price_cents)
    SELECT gen_random_uuid()::varchar, v_order_id, p.id, v_line.quantity, p.unit_price_cents
      FROM products p WHERE p.id = v_line.product_id;

    UPDATE products SET stock_quantity = stock_quantity - v_line.quantity WHERE id = v_line.product_id;
  END LOOP;

  RETURN jsonb_build_object('kind', 'created', 'orderId', v_order_id);
END;
$$;

CREATE OR REPLACE FUNCTION pay_order(p_order_id varchar, p_user_id varchar, p_role varchar)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order record;
  v_payment_id varchar := gen_random_uuid()::varchar;
  v_reference varchar := 'sim_' || left(replace(gen_random_uuid()::varchar, '-', ''), 12);
BEGIN
  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('kind', 'not_found'); END IF;
  IF p_role <> 'staff' AND v_order.user_id <> p_user_id THEN
    RETURN jsonb_build_object('kind', 'forbidden');
  END IF;
  IF v_order.status <> 'PENDING' THEN
    RETURN jsonb_build_object('kind', 'invalid_state', 'currentStatus', v_order.status);
  END IF;

  UPDATE orders SET status = 'PAID', updated_at = CURRENT_TIMESTAMP WHERE id = p_order_id;

  INSERT INTO payment_attempts (id, order_id, status, amount_cents, provider_reference)
  VALUES (v_payment_id, p_order_id, 'APPROVED', v_order.total_cents, v_reference);

  -- Staged in the same transaction as the state change, so the event cannot be
  -- lost or emitted for a change that never committed.
  INSERT INTO outbox_events (id, event_type, aggregate_id, payload)
  VALUES (gen_random_uuid()::varchar, 'order.confirmation.requested', p_order_id,
          jsonb_build_object('orderId', p_order_id, 'status', 'PAID', 'totalCents', v_order.total_cents));

  RETURN jsonb_build_object('kind', 'paid', 'paymentId', v_payment_id,
                            'amountCents', v_order.total_cents, 'providerReference', v_reference);
END;
$$;

CREATE OR REPLACE FUNCTION cancel_order(p_order_id varchar, p_user_id varchar, p_role varchar)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order record;
BEGIN
  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('kind', 'not_found'); END IF;
  IF p_role <> 'staff' AND v_order.user_id <> p_user_id THEN
    RETURN jsonb_build_object('kind', 'forbidden');
  END IF;
  IF v_order.status NOT IN ('PENDING', 'PAID') THEN
    RETURN jsonb_build_object('kind', 'invalid_state', 'currentStatus', v_order.status);
  END IF;

  UPDATE orders SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE id = p_order_id;

  -- One statement returns every reserved unit to its product.
  UPDATE products p SET stock_quantity = p.stock_quantity + oi.quantity
    FROM order_items oi WHERE oi.order_id = p_order_id AND oi.product_id = p.id;

  INSERT INTO outbox_events (id, event_type, aggregate_id, payload)
  VALUES (gen_random_uuid()::varchar, 'order.cancelled', p_order_id,
          jsonb_build_object('orderId', p_order_id, 'status', 'CANCELLED'));

  RETURN jsonb_build_object('kind', 'cancelled');
END;
$$;

CREATE OR REPLACE FUNCTION fulfil_order(p_order_id varchar)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order record;
BEGIN
  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('kind', 'not_found'); END IF;
  IF v_order.status <> 'PAID' THEN
    RETURN jsonb_build_object('kind', 'invalid_state', 'currentStatus', v_order.status);
  END IF;

  UPDATE orders SET status = 'FULFILLED', updated_at = CURRENT_TIMESTAMP WHERE id = p_order_id;
  RETURN jsonb_build_object('kind', 'fulfilled');
END;
$$;

-- ---------------------------------------------------------------------------
-- Access control.
--
-- On Supabase these tables are reachable over HTTPS through PostgREST, so RLS
-- is enabled with no policies: the publishable/anon key can read and write
-- nothing. The server holds the secret key, which bypasses RLS and never
-- reaches a browser. On Cloud SQL, where only the driver connects, this is
-- simply belt and braces.
-- ---------------------------------------------------------------------------

ALTER TABLE users               ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions            ENABLE ROW LEVEL SECURITY;
ALTER TABLE products            ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders              ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items         ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_attempts    ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_records ENABLE ROW LEVEL SECURITY;

REVOKE EXECUTE ON FUNCTION create_order(varchar, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pay_order(varchar, varchar, varchar) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION cancel_order(varchar, varchar, varchar) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION fulfil_order(varchar) FROM PUBLIC;
