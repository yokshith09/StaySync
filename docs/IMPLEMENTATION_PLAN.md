# StaySync Implementation Plan

## Plan

1. Create the StaySync repository, source-product specification, API contract, database schema, test foundation, and checkpoints.
2. Build the guest UI shell and local availability search using fictional seed data.
3. Build atomic reservation holds and conflict handling, with structured event logs and tests.
4. Add simulated payment and confirmation event/worker flow, then test approved, rejected, slow, and retry scenarios.
5. Add staff reservation and housekeeping flows.
6. Add Cloud SQL repository, Pub/Sub publisher/worker, Secret Manager configuration, Cloud Run deployment assets, and workload generator.
7. Deploy to the user-provided GCP project and verify Cloud Logging/Monitoring evidence.
8. Only then update the dashboard plan from observed StaySync signals.

## Implementation checkpoints

- **C1 — Local booking:** date search, hold, and conflict tests pass.
- **C2 — Lifecycle:** payment/confirmation lifecycle tests pass; logs contain event, component, severity, and request ID.
- **C3 — Operations:** staff status changes persist and are logged.
- **C4 — Cloud:** Cloud Run, Cloud SQL, Pub/Sub, Logging, and Monitoring are evidenced in GCP.
- **C5 — Dashboard gate:** controlled scenarios are queryable from Cloud Logging and time-aligned with resource metrics.

## Risks and controls

| Risk | Control |
|---|---|
| Building too much product scope | Keep hotel data fictional and flows limited to booking, payment simulation, confirmation, and operations states. |
| Duplicate booking/payment effects | Use database transactions, availability checks, idempotency keys, and idempotent worker events. |
| Weak telemetry | Define stable structured event names during feature implementation and verify actual stdout/Cloud Logging output. |
| GCP cost or access delay | Build/test local mode first; deploy only with a supplied project, region, permissions, and budget. |

## Not started until source deployment is verified

Monitoring-dashboard frontend, Cloud Logging query adapter, alerting experience, cost analytics, and recommendations.
