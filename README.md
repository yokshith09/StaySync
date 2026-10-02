# StaySync — Fashion Store & Order Management Platform

**Demo source product for Cognizant Hackathon Use Case 2 — GCP Application Log Monitoring, Resource Usage & Cost Optimization Platform**

StaySync is a working fashion e-commerce store: a catalogue of clothing, a cart, stock-reserving
orders, simulated payment, and a fulfilment desk. It exists to generate genuine, explainable Google
Cloud telemetry — structured logs, database transactions, queue events and resource load — for the
monitoring platform built in Phase 2.

It is **not** the monitoring dashboard. It is the controlled source of operational data the dashboard
consumes, matching the Order Management / E-commerce demo application the Use Case 2 product
document specifies in sections 7 and 9.

---

## Quick start

```bash
npm install
npm test          # 33 tests, zero config, in-memory store
npm start         # http://localhost:8081
```

Against the real database:

```bash
npm run migrate   # schema + order functions + RLS + demo accounts
npm run dev       # reads .env
npm run worker    # confirmation worker on :8082
```

---

## Database transports

The app speaks to the same Postgres three ways, chosen by environment:

| Transport | When it is used | Why it exists |
|---|---|---|
| **Supabase over HTTPS** | `SUPABASE_URL` + `SUPABASE_SECRET_KEY` set | Port 443. Works on networks that block outbound 5432 — including this development machine. |
| **Postgres driver** | `DATABASE_URL` set | Port 5432. The Cloud SQL path for GCP deployment. |
| **In-memory** | neither set | Zero config. What `npm test` and `npm start` use. |

HTTPS takes precedence when both are configured.

> **Setup step you need to do once.** Put the **secret (service_role)** key into `.env` as
> `SUPABASE_SECRET_KEY` — Supabase Dashboard → Project Settings → API Keys → `service_role`. It is
> used server-side only and never reaches a browser. Everything else is already wired.

### Why the order logic lives in SQL

PostgREST cannot hold a transaction across HTTP requests, so it cannot run
`BEGIN … SELECT FOR UPDATE … COMMIT` — the exact sequence that stops stock being oversold. The
transactional operations therefore live in database functions (`database/functions.sql`):
`create_order`, `pay_order`, `cancel_order`, `fulfil_order`. Both the driver and the HTTP transport
call the same functions, so the locking guarantees are identical and there is one implementation
rather than two.

### Access control

Row Level Security is enabled on all eight tables **with no policies**, so the publishable/anon key
can read and write nothing. The server holds the secret key, which bypasses RLS. Execute permission
on the order functions is revoked from `PUBLIC`. Verified: with the publishable key, the catalogue
returns 0 rows and `create_order` returns `401 permission denied`.

---

## Pages

| Page | Path | Who | What it does |
|---|---|---|---|
| Shop | `/` | Anyone | Catalogue with imagery, search and category filters. |
| Sign in | `/signin` | Anyone | Sign in or create a customer account. |
| Your order | `/cart` | Customer | Review lines, place the order, choose a payment outcome. |
| Your orders | `/orders` | Customer | History, printable receipt, pay or cancel. |
| Fulfilment desk | `/operations` | Staff | Order queue, mark fulfilled, adjust stock. |
| Scenario lab | `/scenarios` | Demo operator | Fourteen controlled scenarios, each emitting one named event. |

**There is no login bypass anywhere in the application.** The sign-in page is a real form with no
prefilled credentials and no one-click fill. The scenario lab holds no credentials and performs no
sign-in of its own: scenarios that place real orders refuse to run unless you are already signed in,
and say so. The seeded demo accounts are listed behind a disclosure on the sign-in page for you to
type in; they are ordinary accounts with no special path through the login.

---

## Capabilities

1. **Catalogue** — fourteen pieces across Outerwear, Knitwear, Shirting, Trousers, Dresses and
   Accessories. Search by name, description or SKU; filter by category. Each product has a flat
   illustrated plate in `public/img/`, drawn in the design-system palette.
2. **Ordering** — priced server-side from the catalogue, stock reserved under row locks, duplicate
   lines merged, `409 INSUFFICIENT_STOCK` on contention, `409 PRODUCT_UNAVAILABLE` when withdrawn.
3. **Authentication** — real email-and-password accounts validated against the database. Salted
   `scrypt` and SHA-256 session tokens using only `node:crypto`; HttpOnly cookie sessions with no
   token in browser storage. Emails are normalised, format-checked, and their domain is verified to
   have a reachable mail server (MX, or A per RFC 5321 §5.1) before an account is created — so
   fabricated domains are refused. Registration enforces an 8-character minimum. Five failed
   sign-ins lock an account for fifteen minutes, refused before the database is touched. Roles
   `customer` and `staff`.
4. **Payments & idempotency** — simulated approval, provider rejection (502) and latency spike, all
   audited. `Idempotency-Key` makes order creation and payment safe to retry.
5. **Asynchronous confirmation** — transactional outbox drained by `src/worker.js`, as a Pub/Sub
   push target or by polling.
6. **Telemetry** — one structured JSON line per request with a stable `event` name and `requestId`.
   `/health` pings the database and reports `degraded` (503). No credentials or PII are ever logged.

---

## Demo accounts

| Role | Name | Email | Password |
|---|---|---|---|
| Staff | Alex Vance | `staff@staysync.internal` | `DeskPass2026!` |
| Customer | Sarah Jenkins | `customer@staysync.internal` | `ShopPass2026!` |

---

## Scenario lab

Run from `/scenarios`, or headlessly against a deployed URL:

```bash
STAYSYNC_URL=https://staysync-api-xxxx.run.app npm run scenario -- stock-conflict
```

**Failure paths** — `payment-failure` · `slow-payment` · `database-timeout` · `auth-failure`
**Security signals** — `brute-force` · `unauthorized-desk` · `route-scan`
**Correctness guards** — `stock-conflict` · `idempotent-replay` · `key-conflict` · `validation-storm`
**Load shapes** — `traffic-burst` · `order-churn` · `mixed-load`

---

## Source map

| Path | Role |
|---|---|
| `src/app.js` | Request dispatcher: idempotency, route matching, single logging exit point. |
| `src/routes/` | One module per domain — platform, auth, catalog, orders, payments. |
| `src/http.js` | Shared Request/Response helpers. |
| `src/store.js` | Three transports behind one interface: in-memory, pg driver, Supabase REST. |
| `src/auth.js` | scrypt hashing, token generation, seeded accounts. |
| `src/worker.js` | Outbox confirmation worker. |
| `src/server.js` | Static page and image routing, HTTP adapter. |
| `public/` | Six pages, `shared.js`, `styles.css`, and `img/` product plates. |
| `database/schema.sql` | Tables, indexes, seed catalogue. |
| `database/functions.sql` | Transactional order functions, RLS and grants. |
| `database/migrate.js` | Applies both, then seeds demo accounts. |
| `test/app.test.js` | 33 behaviour tests. |
| `cloudbuild.yaml` | Test → Buildpacks → deploy API and worker to Cloud Run. |
| `MEMORY.md` | Full project context. |
