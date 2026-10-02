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

## Checkpoint: Booking foundation

- [x] Guest search and hold work through the browser.
- [x] Tests pass; logs contain a request ID and no guest PII.

## Later phases

- [ ] Payment and confirmation events.
- [ ] Staff operations.
- [ ] Cloud SQL, Pub/Sub, Cloud Run deployment, and GCP evidence.
- [ ] Dashboard only after the GCP evidence checkpoint.
