# StaySync tasks and checkpoints

## Phase 1: Booking foundation
- [x] Task 1: Guest room search and availability contract
  - Acceptance: valid date search returns only rooms that fit the guest count.
  - Verify: `node --test`.
  - Files: `src/app.js`, `test/app.test.js`.
- [x] Task 2: Atomic local reservation hold and conflict result
  - Acceptance: overlapping hold returns `409 RESERVATION_CONFLICT` and logs an event.
  - Verify: `node --test`.
  - Files: `src/app.js`, `src/store.js`, `test/app.test.js`.

## Phase 2: Payment, Confirmation Outbox & Pub/Sub Worker
- [x] Task 3: Simulated payment lifecycle and failure paths
  - Acceptance: 201 payment approval, 502 provider failure, and latency spike scenarios.
  - Files: `src/app.js`, `test/app.test.js`.
- [x] Task 4: Outbox event pattern & Confirmation Worker
  - Acceptance: transactional `outbox_events` generation, standalone `src/worker.js` for Pub/Sub push/polling, emits `confirmation_sent` and retry telemetry.
  - Files: `src/worker.js`, `test/app.test.js`.

## Phase 3: Authentication & Role-Based Hotel Operations
- [x] Task 5: Zero-dependency scrypt authentication
  - Acceptance: `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, token hashing.
  - Files: `src/auth.js`, `src/app.js`, `test/app.test.js`.
- [x] Task 6: Role authorization & Hotel Desk security
  - Acceptance: Staff role unlocks arrivals roster, check-in, and housekeeping; unauthorized queries blocked with 403 `auth_unauthorized_access`.
  - Files: `src/app.js`, `public/app.js`, `public/index.html`.

## Phase 4: Database Service & CI/CD
- [x] Task 7: PostgreSQL & Cloud SQL Dual-Mode Store
  - Acceptance: DDL schema in `database/schema.sql`, migration script `database/migrate.js`, Postgres transaction locking + in-memory zero-config fallback in `src/store.js`.
  - Files: `database/schema.sql`, `database/migrate.js`, `src/store.js`.
- [x] Task 8: Google Cloud Build CI/CD Pipeline
  - Acceptance: Automated test execution + Google Cloud Buildpacks container compilation + Cloud Run deployment configuration.
  - Files: `cloudbuild.yaml`.

## Next Checkpoint: GCP Deployment & Telemetry Verification
- [ ] Deploy StaySync to GCP Cloud Run with Cloud SQL and Secret Manager.
- [ ] Verify live structured JSON logs in GCP Cloud Logging.
- [ ] Verify resource signals (CPU, memory, DB connections) in GCP Cloud Monitoring.
- [ ] Build the Hackathon Log Monitoring & Cost Optimization Platform from real GCP inputs.
