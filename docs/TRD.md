# StaySync Technical Requirements Document (TRD)

## Target cloud architecture

```text
              Customer & Staff Web UI (six pages, vanilla HTML/CSS/ES modules, SVG plates)
                                         │
                                         ▼
                     Cloud Run: StaySync Order API (Node.js 20+)
                                         │
                 ┌───────────────────────┴───────────────────────┐
                 │                                               │
                 ▼                                               ▼
     Cloud SQL for PostgreSQL                          Pub/Sub Topic
     (users, sessions, products, orders,      (order.confirmation.requested,
      order_items, payment_attempts,                 order.cancelled)
      outbox_events, idempotency_records)                        │
                 │                                               ▼
                 │                                    Cloud Run: Confirmation Worker
                 │                                               │
                 └───────────────────────┬───────────────────────┘
                                         │
                                         ▼
                 ┌───────────────────────────────────────────────┐
                 │       GCP OBSERVABILITY & TELEMETRY           │
                 │  • Cloud Logging: structured jsonPayload      │
                 │  • Cloud Monitoring: Cloud Run & DB metrics   │
                 │  • Cloud Billing: BigQuery export             │
                 └───────────────────────────────────────────────┘
```

---

## Service responsibilities & telemetry

| Service | Technology | Role | Metrics emitted |
|---|---|---|---|
| **Order API** | Cloud Run (Node.js) | Catalogue, orders, payments, auth, fulfilment. | Request rate, 2xx/4xx/5xx counts, container CPU & memory, response latency. |
| **Database** | Cloud SQL (PostgreSQL) | ACID persistence, row-level locking (`FOR UPDATE`), outbox. | Active connections, DB CPU, memory, disk I/O, transaction latency. |
| **Worker** | Cloud Run (Node.js) | Drains the outbox, simulates downstream notification. | Backlog depth, ack latency, retry counts, `confirmation_sent`. |
| **Event broker** | Cloud Pub/Sub | Decouples confirmation from the request cycle. | Publish rate, delivery latency, unacked message count. |

---

## Database transports

The app reaches the same Postgres three ways, selected by environment in `getStore()`:

| Transport | Selected when | Port | Purpose |
|---|---|---|---|
| Supabase PostgREST | `SUPABASE_URL` + `SUPABASE_SECRET_KEY` | 443 | Works where outbound 5432 is blocked. Takes precedence. |
| `pg` driver | `DATABASE_URL` | 5432 | The Cloud SQL path on GCP. |
| In-memory | neither | — | Zero-config tests and local runs. |

### Why the transactional logic is in SQL

PostgREST cannot hold a transaction across HTTP requests, so it cannot issue
`BEGIN … SELECT FOR UPDATE … COMMIT`. Without that, the HTTP transport could oversell stock under
concurrency. The four transactional operations therefore live in database functions
(`database/functions.sql`) and both database transports call them:

| Function | Guarantees |
|---|---|
| `create_order(user_id, items jsonb)` | Merges duplicate lines, locks products in stable id order, validates status and stock, prices from the locked rows, writes order, items and decrements. |
| `pay_order(order_id, user_id, role)` | Locks the order, checks ownership and state, writes the payment audit row and the outbox event in the same transaction. |
| `cancel_order(order_id, user_id, role)` | Locks the order, restores every reserved unit, stages the cancellation event. |
| `fulfil_order(order_id)` | Locks the order and advances `PAID → FULFILLED`. |

Each returns a `jsonb` discriminated result (`kind`), which the store maps to an HTTP response.
`search_path` is pinned on all four so a caller cannot shadow the tables they reference.

### Email domain verification

Registration resolves the email's domain before creating an account: an MX record, falling back to
an A record per RFC 5321 §5.1. A domain with neither is refused with
`422 EMAIL_DOMAIN_UNREACHABLE`. The check runs **after** format and password validation, so
malformed input never costs a DNS lookup.

What this does and does not prove: it confirms the **domain** can receive mail, not that the
**mailbox** exists. Catching that needs a confirmation email, which requires a mail provider and is
out of scope. The function is injected via `createStaySyncApp({ checkEmailDomain })` so tests run
offline and deterministically.

Operational note: this adds a DNS round trip to registration and assumes outbound DNS is available.
Cloud Run permits this by default; a locked-down VPC egress configuration would not.

### Sign-in rate limiting

Five failed sign-ins for one email address within fifteen minutes lock that address for the
remainder of the window. Subsequent attempts are refused with `429 TOO_MANY_ATTEMPTS` and a
`Retry-After` header **before the store is consulted**, so a brute-force burst cannot drive database
load. A successful sign-in clears the counter; the lockout is per address, not global, so one
account under attack cannot deny service to others.

The throttle is an in-process `Map`, so on Cloud Run each instance counts separately and the
effective limit is attempts × instances. That ceiling is noted in the code; a shared store would be
needed for a hard global limit.

### Access control

Row Level Security is enabled on all eight tables with **no policies**, so the anon/publishable key
can reach nothing; `EXECUTE` on the order functions is revoked from `PUBLIC`. The server uses the
secret (service_role) key, which bypasses RLS and is server-side only. On Cloud SQL the driver role
holds `BYPASSRLS`.

## Data model

```
users 1──* sessions
users 1──* orders 1──* order_items *──1 products
orders 1──* payment_attempts
outbox_events        (aggregate_id → orders.id, no FK: events outlive their aggregate)
idempotency_records  (standalone, keyed by the client-supplied Idempotency-Key)
```

See `docs/BACKEND_SCHEMA.md` for columns and constraints.

---

## API surface

### Platform
* `GET /health` — pings the database. `200 healthy` with the storage engine, or `503 degraded`
  naming the failed dependency. Emits `health_checked` or `health_degraded`.

### Authentication
* `POST /api/auth/register` — `{ name, email, password }`. Email must be well formed **and its
  domain must publish an MX or A record**; password ≥ 8 characters. `201 auth_register_success`,
  `409 auth_register_duplicate`, `422 auth_register_invalid`,
  `422 auth_register_domain_unreachable`.
* `POST /api/auth/login` — `{ email, password }`. Sets an HttpOnly session cookie and returns a
  bearer token. `200 auth_login_success`, `401 auth_login_failed`, `429 auth_rate_limited`
  (with a `Retry-After` header).
* `POST /api/auth/logout` — revokes the session. `200 auth_logout`.
* `GET /api/auth/me` — `200 auth_profile_viewed` or `401 auth_unauthenticated`.

### Catalogue
* `GET /api/products?q=&category=` — active, in-stock products only. `200 product_catalog_listed`.
  Honours `x-demo-scenario: database_timeout` → `503 database_timeout`.
* `GET /api/categories` — `200 product_categories_listed`.
* `GET /api/products/all` — *[staff]* full inventory including withdrawn and sold-out.
  `200 product_inventory_listed` or `403 auth_unauthorized_access`.
* `PATCH /api/products/:id/stock` — *[staff]* `{ stockQuantity?, status? }`.
  `200 product_stock_updated`, `422 product_stock_invalid`, `404 product_stock_missing`.

### Orders
* `POST /api/orders` — *[session]* `{ items: [{ productId, quantity }] }`, honours `Idempotency-Key`.
  Prices server-side and reserves stock. `201 order_created`, `409 order_stock_conflict`,
  `409 product_unavailable`, `422 order_invalid`, `401 auth_unauthenticated`.
* `GET /api/orders/my` — *[session]* `200 order_history_retrieved`.
* `GET /api/orders/:id` — *[owner or staff]* `200 order_viewed`, `404 order_not_found`,
  `403 auth_unauthorized_access`.
* `POST /api/orders/:id/cancel` — *[owner or staff]* returns reserved stock.
  `200 order_cancelled`, `409 order_cancel_invalid_state`.
* `GET /api/orders` — *[staff]* fulfilment queue. `200 orders_listed` or `403 auth_unauthorized_access`.
* `PATCH /api/orders/:id/fulfil` — *[staff]* `PAID → FULFILLED`.
  `200 order_fulfilled`, `409 order_fulfil_invalid_state`.

### Payments
* `POST /api/payments` — *[owner or staff]* `{ orderId }`, honours `Idempotency-Key`.
  `201 payment_approved`, `502 payment_provider_rejected`, `201 payment_slow`,
  `409 payment_invalid_state`. Scenarios: `x-demo-scenario: payment_failure | slow_payment`.

### Worker
* `POST /pubsub/confirmations` — Pub/Sub push receiver. `200 confirmation_sent`,
  `200 cancellation_notice_sent`, `202 confirmation_retry_scheduled`, `400` on an unparseable message.

---

## Idempotency

`POST /api/orders` and `POST /api/payments` accept `Idempotency-Key`. The request hash is
`sha256(method + path + body)`.

| Condition | Result |
|---|---|
| Key unseen | Handler runs; a successful response is stored against the key. |
| Key seen, same body | Stored response replayed verbatim. Emits `idempotent_replay`. |
| Key seen, different body | `422 IDEMPOTENCY_KEY_REUSED`. Emits `idempotency_key_conflict`. |

Only successful responses are stored, so a failed attempt can be retried with the same key.

---

## Concurrency

Order creation runs in one transaction:

1. Client lines are merged per product and sorted by id — a stable lock order prevents deadlocks.
2. `SELECT … FROM products WHERE id = ANY($1) ORDER BY id ASC FOR UPDATE` locks every row up front.
3. Status and stock are validated against the locked rows.
4. The order, its items and the stock decrements are written, then committed.

Cancellation locks the order, restores every reserved unit in a single `UPDATE … FROM`, and stages
the outbox event in the same transaction.

`status` is staff-owned and independent of stock: selling out removes a product from the catalogue
without changing its status, so `order_stock_conflict` and `product_unavailable` stay distinct signals.

---

## Structured logging contract

One line of JSON per request to `stdout`, which Cloud Run parses into `jsonPayload`:

```json
{
  "timestamp": "2026-10-02T08:20:00.123Z",
  "severity": "INFO | WARNING | ERROR",
  "event": "stable_event_name",
  "component": "platform | auth | catalog | orders | payments | operations | confirmation-worker",
  "entryPoint": "http | pubsub | poller",
  "requestId": "uuid",
  "route": "/api/...",
  "statusCode": 200,
  "responseTimeMs": 14,
  "environment": "development | production",
  "message": "Safe diagnostic summary"
}
```

Written at a single exit point in `src/app.js`, so no route can return without emitting its event.
A test asserts every field is present on every line and that no credential appears in the output.

**Privacy guarantee**: no passwords, session tokens, authorization headers, payment instruments or
personal data are ever written.

---

## Deployment

* **Pipeline** — `cloudbuild.yaml`: `npm ci` → `npm test` → Cloud Buildpacks image → deploy
  `staysync-api` (public, port 8081) and `staysync-worker` (private, port 8082). Both run from one
  image, differing only in the entrypoint.
* **Credentials** — `DATABASE_URL` (or `SUPABASE_URL` + `SUPABASE_SECRET_KEY`) is mounted from
  Secret Manager; Cloud SQL is attached with `--add-cloudsql-instances`.
* **Zero Dockerfile** — Buildpacks handle runtime packaging and OS patching.
* **Migration** — `node database/migrate.js` applies `schema.sql`, then `functions.sql`, then seeds
  the demo accounts. Run once against the instance; it is not part of the deploy pipeline.
