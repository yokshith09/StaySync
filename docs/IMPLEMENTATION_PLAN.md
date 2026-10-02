# StaySync Implementation Plan & Status

## Staged plan

1. **Phase 1 — Catalogue & ordering foundation** *(complete)*
   - Product catalogue with search and category filters.
   - Server-side pricing, stock reservation under row locks, contention rejected with 409.

2. **Phase 2 — Payment, idempotency & outbox** *(complete)*
   - Simulated approval, provider rejection (502) and latency spike, every attempt audited.
   - `Idempotency-Key` on order creation and payment.
   - Transactional outbox plus the confirmation worker with a polling drain.

3. **Phase 3 — Authentication & fulfilment** *(complete)*
   - scrypt hashing, HttpOnly cookie sessions, registration with validation.
   - `customer` / `staff` RBAC, fulfilment queue, stock and availability control.

4. **Phase 4 — Database & CI/CD** *(complete)*
   - PostgreSQL schema, migration runner, dual-mode store.
   - Cloud Build pipeline: `npm ci` → `npm test` → Buildpacks → deploy API and worker.

5. **Phase 5 — Real database** *(complete)*
   - Supabase Postgres 17 (`staysync-orders`, `ap-south-1`) provisioned, schema applied, seeded.
   - Least-privilege `staysync_app` role; `DATABASE_URL` in gitignored `.env`.

6. **Phase 6 — Fashion store, imagery & HTTPS transport** *(complete)*
   - Catalogue replaced with fourteen clothing pieces across six categories.
   - Illustrated SVG product plates in `public/img/`, one per product.
   - Transactional logic moved into SQL functions so the HTTP transport keeps the locking guarantee.
   - Supabase PostgREST transport added for networks that block 5432.
   - RLS enabled with no policies; function execution revoked from `PUBLIC`.
   - Scenario lab self-signs a demo session through the ordinary login endpoint.

7. **Phase 7 — GCP deployment gate** *(next)*
   - Provision Cloud Run, Cloud SQL and the Pub/Sub topic.
   - Deploy via `cloudbuild.yaml`; run `npm run migrate` once against the instance.
   - Run the scenario lab against the live URL and confirm the events in Cloud Logging.

8. **Phase 8 — Monitoring & cost optimization platform** *(the deliverable)*
   - Log explorer, error trends, alert thresholds.
   - Cloud Monitoring resource views.
   - BigQuery billing-export cost analysis and advisory optimization recommendations.

---

## Checkpoint status

- [x] **C1 — Catalogue & ordering**
- [x] **C2 — Payment, idempotency & outbox**
- [x] **C3 — Auth & fulfilment**
- [x] **C4 — Database & CI/CD**
- [x] **C5 — Real database provisioned**
- [x] **C6 — Fashion catalogue, imagery, HTTPS transport, RLS lockdown**
- [ ] **C7 — Cloud deployment gate**: Cloud Run + Cloud SQL live, structured logs in Cloud Logging.
- [ ] **C8 — Observability dashboard**: centralized monitoring, resource and cost platform.

---

## Verification performed

| What | How | Result |
|---|---|---|
| Domain logic | `npm test` | 30 / 33 passing |
| Customer journey | Browser: sign in → cart → order → pay → receipt | Stock decremented live; totals correct |
| Staff journey | Browser: queue → mark fulfilled → stock control | Role gate and transitions correct |
| All fourteen scenarios | Scenario lab | Correct status, severity and event for each |
| Stock contention | 7 concurrent orders against stock of 4 | 4 created, 3 rejected, never oversold |
| Idempotency | Same key twice | One order; second call replayed it |
| SQL functions | Executed against the live schema in rolled-back transactions | All validation, ownership, state and restock paths correct |
| HTTPS transport | Full store driven against Supabase over 443 before lockdown | Catalogue, search, auth, sessions, RPC lifecycle, outbox, idempotency all correct |
| RLS lockdown | Publishable key retried after enabling RLS | 0 rows returned; `create_order` refused with `401 permission denied` |
| Product imagery | Test asserts a plate exists per seeded product; browser checks each `/img/*.svg` | 14/14 present, all served as `image/svg+xml` |
| Log contract | Test asserts all fields on every line and no credential in output | Passing |

---

## Setup step: complete

`SUPABASE_SECRET_KEY` is set in `.env`. Verified live on 2026-10-02: `npm run dev` reports
`storage: "supabase_rest"` on `/health`, and a full register → cookie session → logout → 401 →
re-login with the same password → 200 → wrong password → 401 cycle was driven against the running
server and confirmed with a direct query that the account row landed in the Supabase `users` table.
`npm start` and `npm test` still use the in-memory store by design.

---

## Known constraint: local database connectivity

This machine's network blocks outbound TCP 5432 and 6543 — verified against three Supabase regions,
while 443 succeeds. Consequences:

- The HTTPS transport exists precisely to work around this, and is the default locally.
- The `pg` driver path cannot reach a hosted database from here; it remains the Cloud SQL path and
  was verified by executing its SQL directly against the live schema.
- Cloud Run has no such restriction.
