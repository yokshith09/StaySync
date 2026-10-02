# StaySync Application & User Flows

## Page map

```text
/              Shop            catalogue with imagery, search, category filter, add to order
/signin        Sign in         sign in or create a customer account
/cart          Your order      review lines, place order, simulated payment
/orders        Your orders     history, receipt, pay, cancel
/operations    Fulfilment      [staff] order queue, fulfil, stock control
/scenarios     Scenario lab    [demo] fourteen controlled telemetry scenarios, self-signing session
```

Navigation is rendered once in `public/shared.js`; the fulfilment link appears only for `staff`.

---

## Customer journey

1. **Browse** — `/` lists active, in-stock clothing with its product plate. Search matches name,
   description or SKU; category chips filter the collection.
2. **Add** — items go to a client-side cart in `localStorage`. Nothing is reserved yet.
3. **Review** — `/cart` shows each line and a server-independent preview total.
4. **Place order** — `POST /api/orders` with an `Idempotency-Key`. The server prices the order from
   the catalogue, locks the product rows, validates stock and reserves it. The order is `PENDING`
   and the catalogue's visible stock drops immediately.
5. **Pay** — choose Approved, provider rejection (502) or slow response. On approval the order moves
   to `PAID` and a confirmation event is staged in the outbox.
6. **Receipt** — `/orders` opens the itemised receipt and keeps the full history.
7. **Cancel** — a `PENDING` or `PAID` order can be cancelled, returning every reserved unit.

```
browse → cart → PENDING ──pay──> PAID ──staff──> FULFILLED
                   │              │
                   └──cancel──────┴──> CANCELLED  (stock returned)
```

---

## Staff journey

1. Sign in as `staff@staysync.internal`; the Fulfilment link appears.
2. Review the queue — every order, newest first, with status, lines and total.
3. Mark a `PAID` order fulfilled. Attempting this on a `PENDING` order returns 409.
4. Adjust stock, or withdraw a product. A withdrawn product leaves the catalogue at once and
   rejects new orders with `PRODUCT_UNAVAILABLE`, even though it still has stock.

---

## Demo operator journey

Seven of the fourteen scenarios place real orders and therefore need a real account. The lab holds
no credentials and performs no sign-in of its own: if you are not signed in, those scenarios refuse
to run and tell you to sign in first. The remaining seven (database timeout, auth failure,
unauthorized desk, route scan, traffic burst, and the read-only load shapes) run without a session.

This is deliberate — there is no login bypass anywhere in the application, including here.

---

## Operational scenarios & diagnostic signals

| Scenario | Trigger | Outcome | Event | Severity |
|---|---|---|---|---|
| Catalogue browse | `GET /api/products` | Products listed | `product_catalog_listed` | `INFO` |
| Order placed | `POST /api/orders` | Stock reserved | `order_created` | `INFO` |
| Stock contention | Concurrent orders for the last units | 409 Insufficient stock | `order_stock_conflict` | `WARNING` |
| Withdrawn product | Order a staff-withdrawn item | 409 Unavailable | `product_unavailable` | `WARNING` |
| Payment approved | `POST /api/payments` | 201, outbox staged | `payment_approved` | `INFO` |
| Payment failure | `x-demo-scenario: payment_failure` | 502, order stays pending | `payment_provider_rejected` | `ERROR` |
| Slow payment | `x-demo-scenario: slow_payment` | 201 above the latency threshold | `payment_slow` | `WARNING` |
| Database timeout | `x-demo-scenario: database_timeout` | 503 | `database_timeout` | `ERROR` |
| Degraded dependency | `GET /health` with the database down | 503 degraded | `health_degraded` | `ERROR` |
| Auth failure | Wrong password | 401 | `auth_login_failed` | `WARNING` |
| Brute force | Six+ failed sign-ins for one address | 429 | `auth_rate_limited` | `WARNING` |
| Unauthorized access | Customer hits the desk | 403 | `auth_unauthorized_access` | `WARNING` |
| Idempotent replay | Same `Idempotency-Key` twice | 201, stored response | `idempotent_replay` | `INFO` |
| Key reuse | Same key, different body | 422 | `idempotency_key_conflict` | `WARNING` |
| Cancellation | `POST /api/orders/:id/cancel` | 200, stock returned | `order_cancelled` | `INFO` |
| Fulfilment | `PATCH /api/orders/:id/fulfil` | 200 | `order_fulfilled` | `INFO` |
| Worker dispatch | Outbox drained | Confirmation sent | `confirmation_sent` | `INFO` |
| Worker retry | `simulateRetry` payload | 202, row left unpublished | `confirmation_retry_scheduled` | `WARNING` |
| Route scanning | Requests to paths that do not exist | 404 | `route_not_found` | `WARNING` |
| Validation storm | Burst of malformed order payloads | 422 | `order_invalid` | `WARNING` |
| Order churn | Five orders placed and cancelled | 201 / 200 | `order_created`, `order_cancelled` | `INFO` |
| Traffic burst | 20 concurrent catalogue reads | All 200 | `product_catalog_listed` ×20 | `INFO` |
| Mixed baseline | Blended browsing, search, orders and one failure | mixed | mixed severities | `INFO`/`WARNING`/`ERROR` |

---

## Demo narrative

The final demo tells one story rather than touring screens:

1. Show the storefront and a healthy order completing normally.
2. Run the payment rejection scenario — a 502 with the order correctly left unpaid.
3. Show the event arriving in Cloud Logging, found by `event = "payment_provider_rejected"`.
4. Show the dashboard turning those lines into an error trend and a per-service view.
5. Cross the alert threshold and show the resulting alert.
6. Run the traffic burst and show Cloud Run CPU, concurrency and database connections respond.
7. Show the cost view, stating its billing-export freshness explicitly.
8. Show one optimization recommendation with its supporting evidence.
9. Close on the problem solved, the KPIs demonstrated, and the limits.
