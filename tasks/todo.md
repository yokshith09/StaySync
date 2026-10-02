# StaySync tasks and checkpoints

## Phase 1: Catalogue & ordering
- [x] Task 1: Product catalogue with search and category filter
  - Acceptance: only active, in-stock products are listed; search matches name, description or SKU.
  - Files: `src/app.js`, `src/store.js`, `public/index.html`.
- [x] Task 2: Stock-reserving orders with server-side pricing
  - Acceptance: totals come from the catalogue; concurrent orders for the last units return
    `409 INSUFFICIENT_STOCK` without overselling; duplicate lines are merged.
  - Files: `src/store.js`, `src/app.js`, `test/app.test.js`.

## Phase 2: Payment, idempotency & outbox
- [x] Task 3: Simulated payment lifecycle
  - Acceptance: 201 approval, 502 provider rejection, latency spike; failed attempts audited and the
    order left `PENDING`.
- [x] Task 4: Idempotency on the money paths
  - Acceptance: one `Idempotency-Key` creates one order; key reuse with a different body is 422.
  - Files: `src/app.js`, `src/store.js`.
- [x] Task 5: Outbox events and confirmation worker
  - Acceptance: `order.confirmation.requested` and `order.cancelled` staged transactionally; worker
    drains by Pub/Sub push or polling and emits `confirmation_sent`.
  - Files: `src/worker.js`.

## Phase 3: Authentication & fulfilment
- [x] Task 6: scrypt authentication with cookie sessions
  - Acceptance: register, login, logout, me; HttpOnly cookie; no token in browser storage;
    unknown email returns 401 rather than 500.
  - Files: `src/auth.js`, `src/app.js`, `public/signin.html`.
- [x] Task 7: Role authorization and the fulfilment desk
  - Acceptance: staff unlock the queue, fulfilment and stock control; others get 403
    `auth_unauthorized_access`; one customer cannot read or cancel another's order.
  - Files: `src/app.js`, `public/operations.html`.

## Phase 4: Database service & CI/CD
- [x] Task 8: PostgreSQL / Cloud SQL dual-mode store
  - Acceptance: schema, migration runner, row-level locking, zero-config in-memory fallback.
  - Files: `database/schema.sql`, `database/migrate.js`, `src/store.js`.
- [x] Task 9: Cloud Build pipeline
  - Acceptance: `npm ci` → `npm test` → Buildpacks image → deploy API and worker with Cloud SQL and
    Secret Manager wired.
  - Files: `cloudbuild.yaml`.

## Phase 5: Frontend & real database
- [x] Task 10: Six connected pages on a shared chrome
  - Acceptance: shop, sign in, cart, orders, fulfilment, scenario lab; nav rendered once; staff link
    hidden from customers; responsive to phone width.
  - Files: `public/*.html`, `public/shared.js`, `public/styles.css`, `src/server.js`.
- [x] Task 11: Real Postgres connected
  - Acceptance: hosted Postgres provisioned, schema applied, catalogue and demo accounts seeded,
    least-privilege role, `DATABASE_URL` in gitignored `.env`.

## Phase 6: Fashion store, imagery & HTTPS transport
- [x] Task 12: Fashion catalogue with product imagery
  - Acceptance: fourteen clothing pieces across six categories; one SVG plate per product; a test
    fails if any seeded product lacks an image.
  - Files: `database/schema.sql`, `src/store.js`, `public/img/*.svg`, `public/index.html`.
- [x] Task 13: Transactional logic moved into SQL functions
  - Acceptance: `create_order`, `pay_order`, `cancel_order`, `fulfil_order` hold the row locks;
    both database transports call them; `search_path` pinned.
  - Files: `database/functions.sql`, `src/store.js`.
- [x] Task 14: Supabase HTTPS transport
  - Acceptance: full store drives the live database over port 443; `getStore()` prefers HTTPS, then
    the driver, then memory.
  - Files: `src/store.js`, `.env.example`.
- [x] Task 15: Database access lockdown
  - Acceptance: RLS enabled on all eight tables with no policies; function execution revoked from
    `PUBLIC`; publishable key verified to reach nothing.
  - Files: `database/functions.sql`.
- [x] Task 16: Remove every login bypass
  - Acceptance: the scenario lab holds no credentials and never authenticates on the user's behalf;
    order scenarios refuse to run without a real session.
  - Files: `public/scenarios.html`.
- [x] Task 17: Verify email domains at registration
  - Acceptance: an address whose domain publishes no MX or A record is refused with
    `422 EMAIL_DOMAIN_UNREACHABLE`; the check is injectable so tests stay offline.
  - Files: `src/auth.js`, `src/routes/auth.js`, `test/app.test.js`.
- [x] Task 18: Split the request dispatcher into route modules
  - Acceptance: `src/app.js` drops from 526 to 130 lines; one module per domain under `src/routes/`;
    all behaviour and log output unchanged.
  - Files: `src/app.js`, `src/http.js`, `src/routes/*.js`.

## Next checkpoint: GCP deployment & telemetry verification
- [x] Paste `SUPABASE_SECRET_KEY` into `.env` to run locally against the hosted database.
- [ ] Provision Cloud Run, Cloud SQL and the Pub/Sub topic; store `DATABASE_URL` in Secret Manager.
- [ ] Run `node database/migrate.js` once against the Cloud SQL instance.
- [ ] Deploy via `cloudbuild.yaml` and confirm both services are healthy.
- [ ] Run the scenario lab against the live URL; verify every event in Cloud Logging.
- [ ] Verify CPU, memory, concurrency and database connections in Cloud Monitoring under burst.
- [ ] Enable the Cloud Billing export to BigQuery.
- [ ] Build the monitoring & cost optimization platform from those real inputs.
