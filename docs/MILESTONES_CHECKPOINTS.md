# StaySync Milestones and Checkpoints

**StaySync is the demo source product.** It is the fashion store and order management application
that creates the real application, database, queue and cloud-resource signals the log-monitoring
dashboard consumes. It is not the dashboard.

## Delivery sequence

| Milestone | Outcome | Exit checkpoint | Status |
|---|---|---|---|
| **0. Product definition** | Order management domain, API contract and data model agreed, matching the Use Case 2 demo application. | Team can explain the customer and staff journeys and the telemetry each emits. | **Complete** |
| **1. Catalogue & ordering** | Search, server-side pricing, stock reservation under row locks. | Concurrent orders for the last units return 409 without overselling. | **Complete** |
| **2. Payment, idempotency & outbox** | Three payment outcomes, replay protection, confirmation worker. | 502 leaves the order unpaid and audited; one key yields one order. | **Complete** |
| **3. Auth & fulfilment** | scrypt sessions, RBAC, fulfilment queue, stock control. | Customers are refused the desk with 403; staff can advance `PAID → FULFILLED`. | **Complete** |
| **4. Database & CI/CD** | PostgreSQL schema, migration runner, Cloud Build pipeline. | DDL verified; pipeline installs, tests, builds and deploys both services; the suite passes. | **Complete** |
| **5. Real database** | Supabase Postgres 17 provisioned, migrated, seeded. | Schema, catalogue and demo accounts live; least-privilege app role in use. | **Complete** |
| **6. Fashion store & HTTPS transport** | Clothing catalogue with imagery; transactional logic in SQL functions; PostgREST transport; RLS lockdown. | Store drives the live database over 443; publishable key reaches nothing. | **Complete** |
| **7. GCP deployment** | Cloud Run, Cloud SQL, Pub/Sub, Secret Manager. | Live structured logs and database metrics visible in the GCP project. | **Pending** |
| **8. Scenario rehearsal** | Scenario lab run against the live Cloud Run URL. | Every event queryable in Cloud Logging by name and correlation id. | **Next** |
| **9. Monitoring platform** | The Hackathon log monitoring & cost optimization dashboard. | Central dashboard operating on real GCP telemetry. | **Phase 2** |

---

## Checkpoint 7: required proof before dashboard work

- [ ] Cloud Run writes structured JSON to Cloud Logging, parsed into `jsonPayload`.
- [ ] Cloud SQL holds StaySync products, orders, order items, users and outbox rows.
- [ ] Pub/Sub delivers order confirmation events to the worker.
- [ ] Cloud Monitoring shows CPU, memory, concurrency and database connections responding to the
      traffic-burst scenario.
- [ ] Zero passwords, tokens, payment instruments or personal data appear in Cloud Logging.
- [ ] Each scenario is locatable in Cloud Logging by its stable event name and `requestId`.
- [ ] `GET /health` reports `degraded` when Cloud SQL is unreachable, and that event reaches Logging.

---

## Mapping to the Use Case 2 acceptance criteria

The product document's section 25 lists ten acceptance criteria. StaySync, as the demo source
application, is responsible for these:

| Criterion | Covered by |
|---|---|
| Demo application runs on GCP and produces structured operational logs | Milestone 7 |
| Logs are visible in centralized Cloud Logging | Milestone 7 |
| Known error scenarios are detected and displayed correctly | Scenario lab, milestone 8 |
| At least one alert threshold can be triggered deterministically | `payment_provider_rejected` and the traffic burst |
| Relevant resource metrics are visible for the application environment | Milestone 7 |

The remaining criteria — log querying by the product layer, dashboard views, cost data, and the
optimization recommendation — belong to the monitoring platform in milestone 9.
