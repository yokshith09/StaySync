# StaySync Milestones and Checkpoints

## Delivery order

**StaySync is the demo source product.** It is a hotel booking and operations application that creates the real application, database, queue, and cloud-resource signals consumed later by the log-monitoring dashboard. Do not build the dashboard until Checkpoint 4 passes.

## Build principles

- Build one small, verifiable feature at a time.
- Build the product UI before connecting cloud integrations.
- Write tests as each feature is introduced.
- Learn the data model and service boundary before adding an abstraction.
- Never substitute fixture data for GCP evidence after deployment.

| Milestone | Outcome | Exit checkpoint |
|---|---|---|
| 0. Product definition | Approved source-product scope, assumptions, API contract, and data model. | Team can explain the guest and staff journeys and the signals each journey produces. |
| 1. Booking foundation | Search rooms, view availability, create a held reservation in local mode. | A double-booking attempt returns a controlled conflict and structured logs exist. |
| 2. Payment and confirmation | Simulated payment updates a reservation; confirmation event is processed. | Success, provider failure, and slow payment are repeatable and correlated by request ID. |
| 3. Operations experience | Staff can view bookings and update check-in/housekeeping state. | A staff state change is persisted, evented, and logged. |
| 4. Deploy source to GCP | Cloud Run, Cloud SQL, Pub/Sub, Secret Manager, Cloud Logging, Monitoring. | Real StaySync logs and actual resource metrics are visible in the selected GCP project. |
| 5. Scenario rehearsal | Generate normal traffic, booking contention, failure, latency, queue retry, and load. | Every scenario has a saved Cloud Logging query and expected evidence. |
| 6. Dashboard planning | Define only views justified by verified source data. | Dashboard requirements trace to actual logs, metrics, and cost data. |
| 7. Dashboard build | Build the monitoring dashboard from verified GCP inputs. | Separate dashboard acceptance criteria pass. |

## Checkpoint 4: required proof before dashboard work

- [ ] Cloud Run service logs structured JSON to Cloud Logging.
- [ ] Cloud SQL contains StaySync rooms, reservations, payments, and operations records.
- [ ] Pub/Sub delivers a booking-confirmation event to the worker.
- [ ] Cloud Monitoring shows Cloud Run and Cloud SQL resource signals for generated load.
- [ ] No password, token, payment card, email address, or guest name appears in logs.
- [ ] A Cloud Logging query finds each scenario by event name and correlation ID.

## Assumptions/open questions

- Demo guests and hotels use fictional seed data; no real payment or email provider is used.
- GCP project, region, budget, and billing-export access remain to be supplied.
- Authentication is out of scope unless required by the hackathon rubric.
