# StaySync Backend Schema & Event Model

## PostgreSQL / Cloud SQL tables

Defined in `database/schema.sql`, applied by `database/migrate.js`.

| Table | Primary key | Key columns | Purpose & constraints |
|---|---|---|---|
| **`users`** | `id` | `email` (UNIQUE), `password_hash`, `salt`, `role`, `full_name` | Accounts. Salted scrypt hashes. `role` is checked against `customer` / `staff`. |
| **`sessions`** | `id` | `user_id` (FK), `token_hash` (UNIQUE), `expires_at` | Active sessions. Only the SHA-256 hash of the bearer token is stored. |
| **`products`** | `id` | `sku` (UNIQUE), `name`, `description`, `category`, `unit_price_cents`, `stock_quantity`, `status` | Fashion catalogue across six categories. `stock_quantity >= 0`; `status` is `ACTIVE` or `OUT_OF_STOCK` and is staff-owned. Imagery is not stored: a plate is resolved by product id from `public/img/`. |
| **`orders`** | `id` | `user_id` (FK), `status`, `total_cents`, `created_at`, `updated_at` | Lifecycle `PENDING → PAID → FULFILLED`, or `CANCELLED`. `total_cents` is computed server-side. |
| **`order_items`** | `id` | `order_id` (FK, CASCADE), `product_id` (FK, RESTRICT), `quantity`, `unit_price_cents` | One row per product. `unit_price_cents` snapshots the price at order time. |
| **`payment_attempts`** | `id` | `order_id` (FK), `status`, `amount_cents`, `provider_reference` | Audit of every attempt, `APPROVED` or `FAILED`. No instrument details. |
| **`outbox_events`** | `id` | `event_type`, `aggregate_id`, `payload` (JSONB), `published_at` | Transactional outbox decoupling commits from Pub/Sub dispatch. |
| **`idempotency_records`** | `key` | `request_hash`, `response_status`, `response_body` (JSONB) | Replay store for `Idempotency-Key` on order creation and payment. |

### Indexes

| Index | Purpose |
|---|---|
| `idx_sessions_token_hash` | Session lookup on every authenticated request. |
| `idx_orders_user` | Order history, newest first. |
| `idx_order_items_order` | Hydrating order lines. |
| `idx_products_category` | Category filter. |
| `idx_outbox_unpublished` | Partial index; the worker's poll only scans unpublished rows. |

---

## Transactional functions

`database/functions.sql` holds the operations that must be atomic. They exist in the database rather
than the application because PostgREST cannot hold a transaction across HTTP requests, and the HTTP
transport would otherwise lose the locking guarantee. Both database transports call them, so there
is one implementation of the rules.

| Function | Returns | Notes |
|---|---|---|
| `create_order(p_user_id, p_items jsonb)` | `{kind:'created', orderId}` or a rejection | Validates the payload, merges duplicate lines, locks rows `FOR UPDATE` in id order, prices from the locked rows. |
| `pay_order(p_order_id, p_user_id, p_role)` | `{kind:'paid', paymentId, amountCents, providerReference}` | Ownership and state checks; payment audit row and outbox event in the same transaction. |
| `cancel_order(p_order_id, p_user_id, p_role)` | `{kind:'cancelled'}` | Restores stock in one `UPDATE … FROM order_items`. |
| `fulfil_order(p_order_id)` | `{kind:'fulfilled'}` | `PAID → FULFILLED` only. |

Rejection kinds: `invalid_items`, `product_not_found`, `product_unavailable`, `insufficient_stock`,
`not_found`, `forbidden`, `invalid_state`.

All four pin `search_path = public, pg_temp`, so a caller cannot shadow the referenced tables.

---

## Row Level Security

RLS is enabled on all eight tables with **no policies defined**. The effect is deny-all for every
key except the secret one:

| Key | Reach |
|---|---|
| Publishable / anon | Nothing. Verified: catalogue returns 0 rows, `create_order` returns `401 permission denied`. |
| Secret (service_role) | Full, bypassing RLS. Server-side only, never sent to a browser. |
| `staysync_app` (driver role) | Full, via `BYPASSRLS`, for the Cloud SQL path. |

This is also why the Supabase linter reports `rls_enabled_no_policy` at INFO level on these tables —
that is the intended deny-all state, not a gap.

---

## Integrity rules

1. **Row-level locking** — order creation locks every referenced product with
   `SELECT … FOR UPDATE` in a stable id order before validating or decrementing stock. Concurrent
   orders for the last units cannot oversell.
2. **Server-side pricing** — `total_cents` and each `unit_price_cents` come from the locked product
   rows, never from the request body.
3. **Line merging** — repeated `productId` entries in one request are summed before the stock check,
   so a split payload cannot exceed available stock.
4. **Stock restoration** — cancelling a `PENDING` or `PAID` order returns every reserved unit in one
   `UPDATE … FROM order_items`, inside the same transaction as the status change.
5. **Status independence** — `status` reflects only a staff decision to withdraw a product. Selling
   out hides a product from the catalogue through `stock_quantity > 0`, leaving `product_unavailable`
   and `order_stock_conflict` as separate, meaningful signals.
6. **Outbox atomicity** — `PAID` and `CANCELLED` transitions write their event in the same
   transaction, so an event cannot be lost or emitted for an uncommitted change.
7. **Zero-PII logging** — logs reference synthetic identifiers (`requestId`, `orderId`, `userId`)
   and never names, emails, passwords or tokens.

---

## Outbox event envelope

```json
{
  "id": "uuid",
  "eventType": "order.confirmation.requested | order.cancelled",
  "aggregateId": "orderId",
  "payload": {
    "orderId": "uuid",
    "status": "PAID",
    "totalCents": 8800
  },
  "publishedAt": null,
  "createdAt": "ISO-8601"
}
```

The worker marks `published_at` only after it has handled the event, so an interrupted run
redelivers rather than drops. A payload carrying `simulateRetry: true` produces
`confirmation_retry_scheduled` (202) and leaves the row unpublished.
