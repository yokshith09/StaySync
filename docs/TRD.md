# StaySync Technical Requirements Document

## Architecture

```text
Guest and Staff Web UI
        ↓
Cloud Run: StaySync Booking API ─────→ Cloud SQL for PostgreSQL
        ↓ booking.confirmation.requested
      Pub/Sub
        ↓
Cloud Run: StaySync Confirmation Worker
        ↓
Structured stdout JSON → Cloud Logging
Cloud Run + Cloud SQL + Pub/Sub metrics → Cloud Monitoring
Billing export → BigQuery (later dashboard cost input)
```

## Service responsibilities

| Component | Responsibility | Signals it emits |
|---|---|---|
| Booking API | Search, availability, holds, payments, staff operations. | HTTP completion/failure, booking conflict, payment latency/failure, database failure. |
| Confirmation worker | Consume booking confirmation events; simulate sending confirmation. | delivery success, retry, failure, processing latency. |
| Cloud SQL | Store hotel, room, reservation, payment, and operation-state records. | actual database connection/query pressure through GCP metrics. |
| Pub/Sub | Decouple booking from confirmation. | delivery/retry/backlog metrics and worker logs. |

## API contract (v1)

- `GET /health`
- `GET /api/rooms?checkIn=YYYY-MM-DD&checkOut=YYYY-MM-DD&guests=number`
- `POST /api/reservations` with `roomId`, `checkIn`, `checkOut`, `guestCount`
- `POST /api/payments` with `reservationId`; optional protected demo scenario header
- `GET /api/reservations?status=...`
- `PATCH /api/reservations/:id/check-in`
- `PATCH /api/rooms/:id/housekeeping`

State-changing requests accept `Idempotency-Key`; a repeat with a different payload is rejected. Errors use `{ "error": { "code", "message" } }`.

## Logging contract

Every event is one JSON stdout line with: `timestamp`, `severity`, `event`, `component`, `entryPoint`, `requestId`, `traceId` when present, `reservationId` when safe, `route`, `statusCode`, `responseTimeMs`, and a safe message. Never log names, emails, payment data, passwords, secrets, or raw request bodies.

Stable events include `room_search_completed`, `reservation_held`, `reservation_conflict`, `payment_approved`, `payment_provider_rejected`, `payment_slow`, `confirmation_requested`, `confirmation_sent`, and `confirmation_retry_scheduled`.

## Deployment requirements

Use Cloud Run for API and worker, Cloud SQL PostgreSQL in the same region, Secret Manager for credentials, Pub/Sub for events, Cloud Logging/Monitoring for evidence, and a dedicated least-privilege service account. Cloud Run automatically captures stdout/stderr; one-line JSON is available as structured `jsonPayload`. [Cloud Run logging](https://docs.cloud.google.com/run/docs/logging), [Cloud Run to Cloud SQL](https://docs.cloud.google.com/sql/docs/postgres/connect-run), and [Cloud Run secrets](https://docs.cloud.google.com/run/docs/configuring/services/secrets) are the deployment references.

## Open decisions

Select a region, GCP project, billing budget, Pub/Sub retry/dead-letter policy, and exact Cloud Monitoring alert thresholds before deployment.
