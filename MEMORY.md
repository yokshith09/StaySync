# StaySync Project Memory

Last updated: 2 October 2026

## Purpose of this memory

This file preserves the important decisions and current state from the project conversation. Read it before changing scope, rebuilding the demo source, deploying to GCP, or starting the future monitoring dashboard.

## Final product decision

The chosen demo source product is **StaySync — Hotel Booking & Operations Platform**.

StaySync is not the monitoring dashboard. It is the realistic application that will be deployed to GCP to create the logs, errors, event activity, database use, and cloud-resource usage the monitoring dashboard will later analyze.

### Why StaySync was chosen

- It feels like a real, understandable product rather than a purpose-built log generator.
- Its guest and hotel-staff journeys naturally create meaningful operations signals.
- It supports realistic incidents without real payments, personal data, or external customer communication.
- It gives the later dashboard a strong story: protect bookings, payment reliability, confirmation processing, room availability, and hotel operations.

## Superseded direction

An earlier CommerceOps/order-management source application and an early monitoring-dashboard shell were built. The user decided this direction was not compelling enough as the source product.

- CommerceOps is superseded by StaySync.
- The early dashboard is superseded; do not revive it.
- Do not build the monitoring dashboard while StaySync is still local-only.

## Mandatory delivery sequence

1. Build and test StaySync locally.
2. Deploy StaySync to GCP.
3. Verify real logs in GCP Cloud Logging and real resource signals in Cloud Monitoring.
4. Run repeatable operational scenarios and save evidence/query results.
5. Only then design and build the monitoring dashboard from verified inputs.

This sequence is intentional. The dashboard must use actual GCP source data rather than invented fixture data.

## Product scope

### In scope now

- Guest room search by dates and guest count.
- Room availability based on fictional hotel/room data.
- Reservation holds with overlap conflict prevention.
- Simulated payment approval, provider rejection, and delayed response.
- Booking confirmation-event request.
- Hotel desk with reservations and guest check-in.
- Demo-only scenario controls and scripts.
- Safe structured JSON logs for meaningful API requests/events.

### Deliberately out of scope now

- Monitoring dashboard, alert dashboard, cost dashboard, or fake operational charts.
- Real payment processing, payment-card collection, email/SMS delivery, customer authentication, and real hotels/guests.
- Production compliance, multi-tenancy, or broad enterprise scope.

## Current implementation

Location: `E:\StaySync`

### Useful folders/files

| Path | Purpose |
|---|---|
| `src/app.js` | API routes, error semantics, and structured logging. |
| `src/store.js` | Local in-memory hotel, room, reservation, payment, and operations state. |
| `src/server.js` | Local HTTP server; starts on port 8081 by default. |
| `public/` | Guest booking interface, hotel desk, your-stay section, and demo lab. |
| `test/app.test.js` | Automated behavior tests. |
| `scripts/generate-scenarios.mjs` | CLI generator for traffic-burst and database-timeout scenarios. |
| `tasks/` | Active build plan and checkpoints. |
| `docs/` | Seven current project documents. |
| `SPEC.md` | Current source-product specification. |
| `DESIGN.md` | StaySync design system. |

### Current guest/staff flow

```text
Search rooms → Hold a room → Choose simulated payment outcome
  → Confirmation requested on approved payment → Hotel desk → Check in guest
```

### Current API surface

- `GET /health`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `GET /api/rooms?checkIn=YYYY-MM-DD&checkOut=YYYY-MM-DD&guests=number`
- `POST /api/reservations`
- `POST /api/payments`
- `GET /api/reservations` (protected: staff role required)
- `GET /api/reservations/my` (protected: active session required)
- `PATCH /api/reservations/:id/check-in` (protected: staff role required)
- `PATCH /api/rooms/:id/housekeeping` (protected: staff role required)
- `POST /pubsub/confirmations` (worker push endpoint)

All error responses use this shape:

```json
{ "error": { "code": "MACHINE_READABLE_CODE", "message": "Safe explanation" } }
```

## Operational scenarios and expected evidence

| Scenario | Trigger | HTTP outcome | Structured event | Severity |
|---|---|---|---|---|
| Normal room search | Guest search | `200` | `room_search_completed` | `INFO` |
| Reservation hold | Select room | `201` | `reservation_held` | `INFO` |
| Overlap conflict | Hold same room/dates twice | `409` | `reservation_conflict` | `WARNING` |
| Invalid search/reservation | Bad or missing input | `422` | `room_search_invalid` / `reservation_invalid` | `WARNING` |
| Capacity conflict | Guest count exceeds room capacity | `409` | `reservation_capacity_conflict` | `WARNING` |
| Payment rejection | Demo payment outcome: provider rejects payment | `502` | `payment_provider_rejected` | `ERROR` |
| Slow payment | Demo payment outcome: slow provider response | `201` | `payment_slow` | `WARNING` |
| Availability database timeout | Demo Lab or request scenario header | `503` | `database_timeout` | `ERROR` |
| Invalid check-in | Check in non-confirmed booking | `409` | `check_in_invalid_state` | `WARNING` |
| Traffic burst | Demo Lab or CLI script | repeated `200` | `room_search_completed` | `INFO` |
| Failed login | Invalid credentials in login | `401` | `auth_login_failed` | `WARNING` |
| Unauthorized desk access | Guest / unauthenticated query to desk | `403` | `auth_unauthorized_access` | `WARNING` |
| Confirmation dispatched | Worker outbox processing | `200` | `confirmation_sent` | `INFO` |

### Logging contract

Each meaningful event is emitted as one JSON stdout record. Required fields:

`timestamp`, `severity`, `event`, `component`, `entryPoint`, `requestId`, `route`, `statusCode`, `responseTimeMs`, `environment`, and safe `message`.

Never log names, emails, payment details, passwords, access tokens, secrets, or raw request bodies.

### Verified local logs

The following were run and observed locally:

- `payment_provider_rejected` with `ERROR`, route `/api/payments`, status `502`.
- `database_timeout` with `ERROR`, route `/api/rooms`, status `503`.
- `payment_slow` with `WARNING` and observed response time of about 131 ms.
- `auth_login_success` and `auth_login_failed` with `WARNING` and 401 status.
- `auth_unauthorized_access` with `WARNING` and 403 status.
- `confirmation_sent` emitted by confirmation-worker with `INFO`.

## Testing and local run commands

```powershell
cd E:\StaySync
node --test
node src/server.js
```

Open `http://localhost:8081` for the current app.

Current test status at the time of this memory: **9 tests passing**.

## GCP target architecture (not deployed yet)

```text
Guest/Staff Web UI
       ↓
Cloud Run: StaySync Booking API → Cloud SQL for PostgreSQL
       ↓ booking confirmation event
Pub/Sub
       ↓
Cloud Run: Confirmation Worker
       ↓
Cloud Logging and Cloud Monitoring
       ↓
Later: StaySync operations monitoring dashboard
```

### GCP decisions

- Cloud Run: host the Booking API and later the confirmation worker.
- Cloud SQL for PostgreSQL: persistent hotels, rooms, reservations, payment attempts, operation state, and idempotency records.
- Pub/Sub: decouple confirmation request from confirmation worker processing.
- Secret Manager: database credentials; never put them in source code or ordinary configuration.
- Cloud Logging: central source of structured application logs.
- Cloud Monitoring: Cloud Run, Cloud SQL, and Pub/Sub resource/activity signals.
- Billing export to BigQuery: later cost context only; it is not real-time telemetry.

### Important GCP accuracy notes

- Cloud Run captures stdout/stderr logs. One-line JSON logs are available as structured `jsonPayload` in Cloud Logging.
- Cloud SQL and Cloud Run should use the same selected region unless a documented reason says otherwise.
- Billing-export data has a delay and must always display freshness/cadence when used later.
- GCP recommendations and cost actions are advisory; the project must never automate resource changes.

## GCP deployment gate

Do not begin dashboard implementation until all of these are true:

- [ ] StaySync runs from Cloud Run.
- [ ] Cloud SQL persists StaySync domain data.
- [ ] Database credential comes from Secret Manager.
- [ ] Pub/Sub delivers a booking-confirmation event to a worker.
- [ ] Controlled scenarios are visible in Cloud Logging using event names and request IDs.
- [ ] Generated load appears in Cloud Monitoring for Cloud Run/Cloud SQL (and Pub/Sub where applicable).
- [ ] Logs have been checked for absence of PII, secrets, and payment data.
- [ ] GCP project, region, budget, IAM roles, and billing-export availability are confirmed.

## Dashboard requirements after the gate

The later dashboard should be built only from verified StaySync/GCP inputs. It should help an operations user see:

- Overall booking/operations health and current most-important issue.
- Error count and error types by component and route.
- Payment failures, availability/database errors, latency, confirmation retries, and traffic bursts.
- Drill-down from summary to raw Cloud Logging evidence while preserving time/component context.
- Cloud Run/Cloud SQL/Pub/Sub resource context alongside the incident window.
- Cost information with explicit billing-data freshness and evidence-based advisory recommendations.

It must not claim a root cause from correlation alone, and it must not present billing data as real-time.

## Design decisions

- The source UI is a guest/staff hospitality product, not a monitoring UI.
- The visual direction is editorial hospitality: Cypress Ink, Limestone Canvas, Moss Accent, accessible contrast, responsive layout, and no neon/AI-dashboard aesthetic.
- The Demo Lab is intentionally labelled development/demo only and separated from the normal guest journey.
- Artificial failures are explicit, safe scenario modes—not hidden defects.

## Project hygiene and location

- Current live project: `E:\StaySync`.
- Seven current documents are in `E:\StaySync\docs`.
- Superseded CommerceOps project, old duplicate StaySync folder, old outputs folder, and temporary work folder were removed from the original generated workspace and sent to the Windows Recycle Bin.
- The retained project is a Git repository.

## Relevant Git history

| Commit | Meaning |
|---|---|
| `52e7afb` | Initial StaySync booking demo foundation. |
| `7a01727` | Visible payment-failure scenario. |
| `d504bdd` | Scenario lab and additional product sections. |
| `063d460` | Current seven StaySync project documents. |

## Immediate next work

1. Add the PostgreSQL/Cloud SQL repository and migration/schema from `docs/BACKEND_SCHEMA.md`.
2. Add durable outbox publishing and a separate confirmation worker with idempotent Pub/Sub handling.
3. Add Cloud Run/Secret Manager/Pub/Sub deployment assets and an environment template.
4. Deploy only after the user provides/approves GCP project, region, budget, and access context.
5. Run and verify every listed scenario in Cloud Logging and Cloud Monitoring.
6. Start the monitoring dashboard only after the deployment gate passes.

## Do not forget

- Build one small feature at a time.
- UI before cloud wiring for each source-product feature.
- Tests early, not at the end.
- Fundamentals before abstractions.
- Keep scope hackathon-focused; do not add marketing/product-growth work.
