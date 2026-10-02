# StaySync Product Requirements Document

## Product

StaySync is a hotel booking and operations application. Guests search rooms by date, view availability, reserve a room, complete a simulated payment, and receive a confirmation. Hotel staff view reservations, check guests in, and update housekeeping status.

It is the **demo source product** for the hackathon monitoring solution. Its job is to create genuine, explainable GCP telemetry. The log-monitoring dashboard is a later product that will consume the deployed application's Cloud Logging, Monitoring, and cost inputs.

## Users and journeys

| User | Goal | Essential journey |
|---|---|---|
| Guest | Secure a room with confidence. | Search dates → select available room → reserve → pay → see confirmation. |
| Hotel staff member | Run daily room operations. | View reservations → check guest in/out → set housekeeping status. |
| Demo operator | Create observable conditions. | Run normal booking, contention, payment failure, slow payment, notification retry, and traffic-burst scenarios. |

## Functional requirements

1. Guests can search fictional hotels/rooms by check-in, check-out, and guest count.
2. Guests can create a reservation only when the room is available for the selected dates.
3. The product prevents overlapping confirmed/held reservations for the same room.
4. A simulated payment records approved, failed, or delayed outcomes; no card data is collected.
5. A booking event triggers a simulated confirmation worker.
6. Staff can list reservations and change check-in and housekeeping states.
7. Every meaningful request and worker event emits safe, structured JSON logs with a correlation ID.
8. Repeatable demo scenarios create success, warning, error, retry, and traffic/load evidence.

## Non-goals

- Real hotel inventory, payment processing, email/SMS, customer authentication, and production compliance workflows.
- Any dashboard, log-analysis UI, alerting UI, or cost-recommendation UI before the source product is deployed and verified.

## Success criteria

- A guest completes a normal booking journey locally and after GCP deployment.
- Concurrent/overlapping booking attempts yield a meaningful conflict, never two confirmed reservations.
- Each planned failure can be found in Cloud Logging by stable event name, component, severity, and correlation ID.
- Generated load causes visible Cloud Run/Cloud SQL activity in Cloud Monitoring.

## Assumptions

The first release uses fictitious hotels and simulated providers. "Real-time" means requests/events are generated during the demo; the future dashboard must label actual source freshness rather than promise instantaneous ingestion.
