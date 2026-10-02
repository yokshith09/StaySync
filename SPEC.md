# Spec: StaySync Demo Source Product

## Objective

Build a fashion e-commerce store, with full order management, that serves as the demo source
product for Cognizant Hackathon Use Case 2 (GCP Application Log Monitoring, Resource Usage & Cost
Optimization Platform). It produces genuine, structured, privacy-safe telemetry across Cloud Run,
Cloud SQL, Pub/Sub, Cloud Logging and Cloud Monitoring.

The Use Case 2 product document names an Order Management / E-commerce API as the demo application
(sections 1, 7 and 9). This project implements exactly that.

## Core capabilities

1. **Catalogue** — fourteen clothing pieces across six categories, each with an illustrated
   product plate. Search by name, description or SKU; filter by category; sold-out and withdrawn
   products are excluded from the public listing.
2. **Ordering** — server-side pricing, stock reserved under row locks, duplicate lines merged,
   `409 INSUFFICIENT_STOCK` on contention and `409 PRODUCT_UNAVAILABLE` when staff withdrew an item.
3. **Authentication & RBAC** — native `node:crypto` scrypt hashing, HttpOnly cookie sessions,
   self-service registration, and `customer` vs `staff` authorization.
4. **Payments** — simulated approval, provider rejection (502) and latency spike; every attempt
   audited, including failures.
5. **Idempotency** — `Idempotency-Key` on order creation and payment; replay returns the stored
   response, key reuse with a different body is refused.
6. **Fulfilment** — staff queue, `PAID → FULFILLED`, stock and availability control.
7. **Asynchronous processing** — transactional outbox plus a standalone confirmation worker.
8. **Telemetry contract** — single-line structured JSON, stable event names, correlation id, no PII.
9. **Three-transport persistence** — Supabase over HTTPS (port 443), the Postgres driver over
   5432 for Cloud SQL, or a zero-config in-memory store. All three share one interface, and the two
   database transports share one implementation of the transactional logic via SQL functions.

10. **Access control at the database** — RLS enabled with no policies, so only the server's secret
   key reaches the tables; execute permission on the order functions revoked from `PUBLIC`.

## Order lifecycle

```
PENDING ──pay──> PAID ──fulfil──> FULFILLED
   │               │
   └───cancel──────┴──> CANCELLED        (cancelling returns reserved stock)
```

Stock is reserved at `PENDING`, not at payment, which is what makes concurrent contention observable.

## Commands

- Start (in-memory): `npm start` — port 8081
- Start (database over HTTPS or driver): `npm run dev`
- Worker: `npm run worker` — port 8082
- Tests: `npm test` — 33 tests
- Migration: `npm run migrate`
- Scenario: `npm run scenario -- <name>`

## Boundaries & constraints

- **Always**: validate at the trust boundary, price orders server-side, emit structured telemetry,
  hash passwords with salted scrypt, hold stock changes inside a transaction, escape values before
  they reach `innerHTML`.
- **Never**: log credentials, session tokens, payment instruments or personal data; trust a
  client-supplied price; let a repeated request create a second order; send the Supabase secret key
  to a browser.
- **Monitoring scope**: the dashboard is Phase 2 and is built from real GCP inputs — Cloud Logging,
  Cloud Monitoring and the Cloud Billing export to BigQuery. No mock dashboard lives in this app.
