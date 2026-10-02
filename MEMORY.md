# StaySync — Master Project Memory & Full Context Reference

**Last Updated:** 2 October 2026  
**Repository Location:** `E:\StaySync`  
**Git Branch:** `master`  
**Runtime:** Node.js v20+ (ESM, zero external runtime dependencies, `pg` for PostgreSQL / Cloud SQL)  
**Test Suite:** 33 passing automated tests (`node --test`)

---

## 1. Executive Context & Problem Statement

### Cognizant Hackathon — Use Case 2: NPN GCP Track
* **Title:** *GCP Application Log Monitoring, Resource Usage & Cost Optimization Platform*
* **Document Reference:** Use Case 2 Product Document v1.0 (1 October 2026), sections 1, 7, 9, 13, 14, 15.
* **Core Problem:** A cloud application generates large volumes of operational events. Critical errors can be buried in normal noise, performance bottlenecks go unnoticed, and cloud resource consumption runs decoupled from cloud spend.
* **Solution Architecture:**
  1. **Demo Source Application (StaySync):** A controlled fashion store with full order management, deployed on GCP, continuously generating structured operational logs, database transactions, queue activity, and load.
  2. **GCP Centralized Logging:** Cloud Logging captures structured JSON entries.
  3. **GCP Cloud Monitoring:** Gathers real-time infrastructure metrics (Cloud Run CPU/memory, Cloud SQL active backend connections, Pub/Sub lag).
  4. **GCP Cloud Billing to BigQuery:** Ingests cost data at periodic cadence.
  5. **Observability & Cost Platform (Phase 2):** Developer-facing dashboard surfacing error trends, threshold-based alerts, slow endpoint latency, resource spikes, and advisory cost-saving recommendations (right-sizing, idle cleanup).

### Role of StaySync in the Deliverable
StaySync is the **controlled demo source application** specified in Section 7 of the Hackathon document. It is **not** the monitoring dashboard. It creates the authentic workload, concurrency contention, latency spikes, and failure scenarios that the Phase 2 monitoring dashboard ingests and evaluates.

The storefront is a fashion retailer: fourteen clothing pieces across Outerwear, Knitwear, Shirting, Trousers, Dresses and Accessories, each with an illustrated SVG product plate in `public/img/` drawn in the design-system palette. The imagery is deliberately illustrative rather than photographic so the catalogue carries no external image dependency or licensing question.

---

## 2. Complete Architecture & System Flow

```text
               Customer & Staff Web UI (6 pages, Vanilla HTML5 / CSS3 / ES Modules)
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

## 3. Technology Stack & Design Decisions

* **Language & Runtime:** Pure Node.js (ESM). No bulky web frameworks (Express/Fastify) — uses Web-standard `fetch`, `Request`, and `Response` with `node:http`.
* **Security & Auth:** Zero external crypto libraries (no bcrypt, no jsonwebtoken). Uses native `node:crypto`:
  * Password hashing via `crypto.scryptSync` with cryptographic salt.
  * Constant-time verification with `crypto.timingSafeEqual`, length-guarded so a malformed stored hash yields 401 rather than 500.
  * Session management via HttpOnly cookies carrying SHA-256 hashed bearer tokens. No token in browser storage.
  * Email is the sign-in identifier: trimmed, lowercased and format-validated on both registration and login.
  * **Failed-login throttle:** five failures for one address within 15 minutes returns `429 TOO_MANY_ATTEMPTS` with `Retry-After`, refused *before* the store is consulted. Success clears the counter; the lockout is per address, not global. In-process `Map`, so on Cloud Run the effective limit is attempts x instances — ceiling noted in code.
  * **Email domain verification at registration:** the domain must publish an MX record, or an A record per RFC 5321 §5.1, before an account is created. This rejects fabricated domains without needing a mail provider or a confirmation email. It proves the domain is real, *not* that the specific mailbox exists — a typo inside a real provider (`dusername@gmail.com`) still gets through. Injectable via `createStaySyncApp({ checkEmailDomain })` so the test suite never touches DNS.
  * **No login bypass exists anywhere.** The sign-in form has no prefilled credentials and no one-click fill; the scenario lab holds no credentials and never authenticates on the user's behalf.
* **Database Layer:** Three transports behind one interface in `src/store.js`, selected by `getStore()`:
  * **Supabase PostgREST (HTTPS, port 443):** the local default. Chosen when `SUPABASE_URL` + `SUPABASE_SECRET_KEY` are set, and takes precedence, because this network blocks outbound 5432.
  * **PostgreSQL / Cloud SQL (`pg` driver, port 5432):** chosen when `DATABASE_URL` is set. The GCP deployment path.
  * **In-Memory Store:** chosen when neither is set. Zero-config testing (`npm test` passes in ~2 seconds without a database).
* **Transactional Logic in SQL:** PostgREST cannot hold a transaction across HTTP requests, so it cannot run `BEGIN / SELECT FOR UPDATE / COMMIT`. The four transactional operations therefore live in database functions (`database/functions.sql`) — `create_order`, `pay_order`, `cancel_order`, `fulfil_order` — and **both** database transports call them. One implementation, identical locking guarantees. `search_path` is pinned on all four.
* **Hosted Database:** Supabase Postgres 17 (`staysync-orders`, `ap-south-1`) with a least-privilege `staysync_app` role for the driver path.
* **Access Control:** RLS enabled on all eight tables with **no policies**, so the publishable/anon key reaches nothing; `EXECUTE` on the order functions revoked from `PUBLIC`. The server holds the secret (service_role) key, which bypasses RLS and is never sent to a browser.
* **CI/CD Pipeline:** `cloudbuild.yaml` automated via **Google Cloud Buildpacks** (`gcr.io/buildpacks/builder:google-22`). No Dockerfile needed; builds, tests, and deploys both API and Worker services.

---

## 4. Complete Data Model (PostgreSQL / Cloud SQL)

Managed via `database/schema.sql` and `database/migrate.js`:

```text
users 1 ──< sessions
users 1 ──< orders 1 ──< order_items >── 1 products
orders 1 ──< payment_attempts
outbox_events (aggregate_id → orders.id)
idempotency_records (key = client Idempotency-Key)
```

| Table | Primary Key | Key Columns | Purpose & Constraints |
|---|---|---|---|
| **`users`** | `id` (VARCHAR) | `email` (UNIQUE), `password_hash`, `salt`, `role`, `full_name`, `created_at` | Account store. Roles: `customer` or `staff`. |
| **`sessions`** | `id` (VARCHAR) | `user_id` (FK), `token_hash` (UNIQUE), `expires_at`, `created_at` | Active sessions. Stored as SHA-256 hashes of tokens. |
| **`products`** | `id` (VARCHAR) | `sku` (UNIQUE), `name`, `description`, `category`, `unit_price_cents`, `stock_quantity`, `status` | Catalogue. `stock_quantity >= 0`; `status`: `ACTIVE` or `OUT_OF_STOCK`. |
| **`orders`** | `id` (VARCHAR) | `user_id` (FK), `status`, `total_cents`, `created_at`, `updated_at` | Lifecycle: `PENDING → PAID → FULFILLED`, or `CANCELLED`. Priced server-side. |
| **`order_items`**| `id` (VARCHAR) | `order_id` (FK), `product_id` (FK), `quantity`, `unit_price_cents` | Order line items with price snapshot. |
| **`payment_attempts`**| `id` (VARCHAR)| `order_id` (FK), `status`, `amount_cents`, `provider_reference`, `created_at` | Audit of all attempts (`APPROVED`, `FAILED`). No card details. |
| **`outbox_events`** | `id` (VARCHAR) | `event_type`, `aggregate_id`, `payload` (JSONB), `published_at`, `created_at` | Transactional outbox decoupling API from Pub/Sub. |
| **`idempotency_records`**| `key` (VARCHAR)| `request_hash`, `response_status`, `response_body` (JSONB), `created_at` | Deduplication store for `Idempotency-Key`. |

---

## 5. Complete API Surface (All Endpoints)

All error responses strictly adhere to `{ "error": { "code": "STRING", "message": "String" } }`.

### 1. Platform & Health
* `GET /health`: Pings storage dependency. Returns `200 healthy` or `503 degraded` with dependency details.

### 2. Authentication
* `POST /api/auth/register`: `{ name, email, password }` → Creates customer account, issues session cookie.
* `POST /api/auth/login`: `{ email, password }` → Authenticates, returns user profile, sets HttpOnly session cookie.
* `POST /api/auth/logout`: Revokes active session.
* `GET /api/auth/me`: Returns profile of authenticated session or 401.

### 3. Product Catalogue
* `GET /api/products?q=&category=`: Public listing of active, in-stock products. Supports `x-demo-scenario: database_timeout` (503).
* `GET /api/categories`: Returns distinct product categories.
* `GET /api/products/all`: *[Staff Only]* Full inventory including withdrawn and out-of-stock items.
* `PATCH /api/products/:id/stock`: *[Staff Only]* `{ stockQuantity, status }`. Updates inventory and availability.

### 4. Orders & Checkout
* `POST /api/orders`: *[Active Session]* `{ items: [{ productId, quantity }] }`. Supports `Idempotency-Key`. Server prices items and atomically reserves stock under row lock (`SELECT ... FOR UPDATE`).
* `GET /api/orders/my`: *[Active Session]* Returns order history of current user.
* `GET /api/orders/:id`: *[Owner or Staff]* Returns itemized order details.
* `POST /api/orders/:id/cancel`: *[Owner or Staff]* Cancels order, restoring reserved stock to inventory.
* `GET /api/orders`: *[Staff Only]* Fulfilment desk queue across all customers.
* `PATCH /api/orders/:id/fulfil`: *[Staff Only]* Advances status from `PAID` to `FULFILLED`.

### 5. Payments
* `POST /api/payments`: *[Owner or Staff]* `{ orderId }`. Supports `Idempotency-Key` and `x-demo-scenario: payment_failure | slow_payment`. Records audit record, confirms payment, and stages outbox confirmation event.

### 6. Pub/Sub Confirmation Worker
* `POST /pubsub/confirmations`: Pub/Sub push receiver processing outbox events (`order.confirmation.requested`, `order.cancelled`).

---

## 6. Structured Logging & Telemetry Contract

Every request writes exactly one JSON string to `stdout`. Cloud Run automatically transforms this into structured `jsonPayload` in GCP Cloud Logging:

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

### Complete Telemetry Catalog

Every event name the application can emit. The Phase 2 dashboard is built against this list, so it
is kept exhaustive — the `ERROR` and `WARNING` rows are the ones alert thresholds attach to.

**Platform**

| Event Name | Component | Severity | HTTP | Trigger Scenario |
|---|---|---|---|---|
| `health_checked` | `platform` | `INFO` | `200` | Regular health check ping |
| `health_degraded` | `platform` | `ERROR` | `503` | Database dependency unreachable |
| `route_not_found` | `platform` | `WARNING` | `404` | Unknown route |
| `unhandled_server_error` | `platform` | `ERROR` | `500` | Uncaught error in the HTTP adapter |

**Authentication**

| Event Name | Component | Severity | HTTP | Trigger Scenario |
|---|---|---|---|---|
| `auth_register_success` | `auth` | `INFO` | `201` | Customer signs up |
| `auth_register_duplicate` | `auth` | `WARNING` | `409` | Email already exists |
| `auth_register_invalid` | `auth` | `WARNING` | `422` | Bad email or password under 8 chars |
| `auth_login_success` | `auth` | `INFO` | `200` | Valid sign in |
| `auth_login_failed` | `auth` | `WARNING` | `401` | Wrong password or unknown user |
| `auth_rate_limited` | `auth` | `WARNING` | `429` | Six+ failed sign-ins for one address in 15 min |
| `auth_login_invalid` | `auth` | `WARNING` | `422` | Missing email or password |
| `auth_logout` | `auth` | `INFO` | `200` | Session revoked |
| `auth_profile_viewed` | `auth` | `INFO` | `200` | Session validated |
| `auth_unauthenticated` | `auth`/`orders` | `INFO`/`WARNING` | `401` | Action attempted without a session |
| `auth_unauthorized_access`| `operations`/`orders`| `WARNING` | `403` | Role or ownership check refused |

**Catalogue**

| Event Name | Component | Severity | HTTP | Trigger Scenario |
|---|---|---|---|---|
| `product_catalog_listed` | `catalog` | `INFO` | `200` | Browsing shop or traffic burst |
| `product_categories_listed` | `catalog` | `INFO` | `200` | Category chips loaded |
| `product_inventory_listed` | `operations` | `INFO` | `200` | Staff opens full inventory |
| `product_stock_updated` | `operations` | `INFO` | `200` | Staff adjusts stock or availability |
| `product_stock_invalid` | `operations` | `WARNING` | `422` | Negative stock or bad status value |
| `product_stock_missing` | `operations` | `WARNING` | `404` | Stock update on an unknown product |
| `database_timeout` | `catalog` | `ERROR` | `503` | `x-demo-scenario: database_timeout` |

**Orders**

| Event Name | Component | Severity | HTTP | Trigger Scenario |
|---|---|---|---|---|
| `order_created` | `orders` | `INFO` | `201` | Order placed, stock reserved |
| `order_stock_conflict` | `orders` | `WARNING` | `409` | Stock contention on the last units |
| `product_unavailable` | `orders` | `WARNING` | `409` | Ordering a staff-withdrawn product |
| `order_invalid` | `orders` | `WARNING` | `422` | Malformed or empty item list |
| `order_product_missing` | `orders` | `WARNING` | `404` | Item references an unknown product |
| `order_viewed` | `orders` | `INFO` | `200` | Single order retrieved |
| `order_history_retrieved` | `orders` | `INFO` | `200` | Customer opens order history |
| `order_not_found` | `orders` | `WARNING` | `404` | Lookup, payment or cancel on an unknown order |
| `order_cancelled` | `orders` | `INFO` | `200` | Order cancelled, stock returned |
| `order_cancel_invalid_state` | `orders` | `WARNING` | `409` | Cancel attempted on a terminal order |
| `orders_listed` | `operations` | `INFO` | `200` | Staff opens the fulfilment queue |
| `order_fulfilled` | `operations` | `INFO` | `200` | Staff marks an order fulfilled |
| `order_fulfil_invalid_state` | `operations` | `WARNING` | `409` | Fulfil attempted on an unpaid order |

**Payments & idempotency**

| Event Name | Component | Severity | HTTP | Trigger Scenario |
|---|---|---|---|---|
| `payment_approved` | `payments` | `INFO` | `201` | Order paid, outbox staged |
| `payment_provider_rejected`| `payments` | `ERROR` | `502` | `x-demo-scenario: payment_failure` |
| `payment_slow` | `payments` | `WARNING` | `201` | `x-demo-scenario: slow_payment` (>100ms) |
| `payment_invalid` | `payments` | `WARNING` | `422` | Missing `orderId` |
| `payment_invalid_state` | `payments` | `WARNING` | `409` | Order already paid or cancelled |
| `idempotent_replay` | `orders` | `INFO` | stored | Repeat request with a known `Idempotency-Key` |
| `idempotency_key_conflict` | `orders` | `WARNING` | `422` | Key reused with a different body |

**Worker**

| Event Name | Component | Severity | HTTP | Trigger Scenario |
|---|---|---|---|---|
| `confirmation_sent` | `confirmation-worker`| `INFO` | `200` | Confirmation dispatched |
| `cancellation_notice_sent` | `confirmation-worker`| `INFO` | `200` | Cancellation notice dispatched |
| `confirmation_retry_scheduled` | `confirmation-worker`| `WARNING` | `202` | Downstream delay; row left unpublished |
| `outbox_poll_failed` | `confirmation-worker`| `ERROR` | `500` | Poller could not reach the database |

---

## 7. Web Application Pages (`public/`)

1. **Shop (`/`)**: Fashion catalogue with product plates, live search, category filtering, stock badges, and add-to-cart.
2. **Sign In (`/signin`)**: Unified sign-in and registration with quick demo-account buttons.
3. **Your Order (`/cart`)**: Review lines, server-side preview totals, place order, and simulate payments.
4. **Your Orders (`/orders`)**: Customer order history, printable itemized receipt, pay or cancel.
5. **Fulfilment Desk (`/operations`)**: Staff-only order queue, status progression, and stock quantity/availability controls.
6. **Scenario Lab (`/scenarios`)**: Interactive UI for running 14 controlled diagnostic scenarios. It holds **no credentials and performs no sign-in of its own** — scenarios that place real orders refuse to run unless a real session already exists. There is no login bypass anywhere in the application.

---

## 8. Verification & Test Suite

All 33 tests pass with zero configuration:
```powershell
npm test
```

### Coverage (30/33 passing):
* Catalogue filtering, sold-out product hiding, search matching.
* Server-side pricing integrity and atomic stock reservation under row lock.
* Duplicate line merging preventing overselling past stock limits.
* Stock contention rejection (`409 INSUFFICIENT_STOCK`).
* Staff product withdrawal enforcement (`409 PRODUCT_UNAVAILABLE`).
* Cross-customer order privacy protection (403 Forbidden).
* Payment approval, 502 provider failure audit, and latency spike diagnostics.
* Double-payment prevention.
* Idempotency replay with identical response and reuse rejection with 422.
* Order cancellation with atomic inventory return.
* Role-based fulfilment queue access and state progression (`PAID → FULFILLED`).
* Scrypt authentication, session management, and duplicate registration handling.
* Health check reporting storage engine and degraded dependency detection.
* Outbox drain and confirmation worker dispatch telemetry.
* Zero-credential log leakage assertion across all events.
* Product image coverage: every seeded product has an SVG plate.
* Transport selection: HTTPS over driver over memory, with a half-configured Supabase falling through.
* Login throttle: lockout after five failures, correct password still refused while locked, per-address isolation, window expiry, and counter reset on success.
* Email normalisation: registration lowercases and trims; sign-in accepts any case or surrounding whitespace.

---

## 9. Known Local Environment Constraint

* **Network Restriction:** Outbound TCP on ports 5432 and 6543 is blocked on this local development machine. Verified against three Supabase regions; port 443 succeeds.
* **Resolution:** the Supabase PostgREST transport exists precisely for this and is the local default. The whole store was driven against the live database over 443 and verified before RLS was enabled.
* **Impact:** `npm start` (in-memory) and `npm test` (33 tests) run with zero issues. The `pg` driver path cannot reach a hosted database from here; it remains the Cloud SQL route and its SQL was validated directly against the live schema.
* **Cloud Run:** unaffected — it reaches Cloud SQL over the Auth Proxy unix socket.

### Setup step: complete

`SUPABASE_SECRET_KEY` is set in `.env`. Verified 2026-10-02: `npm run dev` reports `storage: "supabase_rest"`; a full register/logout/re-login cycle was driven against the live server and the account row was confirmed in the Supabase `users` table by direct query, then cleaned up.

---

## 10. Delivery Roadmap: Phase 2 (Observability Platform)

```
[ StaySync Demo Source Product ] ──> [ GCP Deployment Gate ] ──> [ Monitoring & Cost Platform ]
```

### Stage 1: GCP Deployment Gate (Next Immediate Work)
1. Deploy `staysync-api` to Cloud Run using `cloudbuild.yaml`.
2. Provision Cloud SQL for PostgreSQL and apply `database/schema.sql` via `node database/migrate.js`.
3. Deploy `staysync-worker` to Cloud Run subscribed to the Pub/Sub topic.
4. Run Scenario Lab scripts against the live Cloud Run endpoint and confirm structured logs arrive in **GCP Cloud Logging**.

### Stage 2: Central Observability & Cost Optimization Platform (Final Deliverable)
1. **Log Analytics Engine**: Connect to Cloud Logging API; display log streams, filter by severity, component, endpoint; compute error rate trends.
2. **Alert Engine**: Configurable thresholds (error rate > 5%, consecutive 5xx spikes, latency > 500ms).
3. **Resource Metrics Aggregator**: Query Cloud Monitoring API for Cloud Run CPU/Memory, concurrency, and Cloud SQL connection counts.
4. **Cost Analytics Dashboard**: Ingest BigQuery Cloud Billing export; display daily/monthly spend and SKU breakdowns.
5. **Advisory Cost Optimization Engine**: Detect underutilized resources (idle Cloud SQL instances, over-provisioned memory) and display actionable savings estimates.
