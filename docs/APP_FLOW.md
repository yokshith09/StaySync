# StaySync Application Flow

## Product navigation

```text
Guest home → Search rooms → Room details → Reservation hold → Payment → Confirmation
Staff home → Reservations → Reservation detail → Check-in/out
Staff home → Rooms → Housekeeping update
Demo operator → Scenario runner → Cloud Logging and Monitoring (after deployment)
```

## Guest booking flow

1. Guest enters check-in date, check-out date, and guest count.
2. System validates dates and returns available rooms.
3. Guest selects a room and creates a `HELD` reservation.
4. API reserves the room/date range atomically and emits `reservation_held`.
5. Guest submits simulated payment.
6. Approved payment changes reservation to `CONFIRMED`, publishes a confirmation event, and shows confirmation.
7. The worker processes the event and logs confirmation success or a scheduled retry.

## Controlled failure paths

| Scenario | User-visible outcome | Expected operational evidence |
|---|---|---|
| Last-room contention | Second reservation is rejected with a clear availability message. | `reservation_conflict`, warning severity, stable room ID—not guest data. |
| Payment rejection | Guest sees payment could not be completed. | `payment_provider_rejected`, error severity, correlated reservation ID. |
| Slow payment | Guest receives a delayed result. | `payment_slow`, warning severity, response-time value. |
| Confirmation retry | Booking is confirmed but notice is pending/retrying. | `confirmation_retry_scheduled`, worker event and Pub/Sub retry evidence. |
| Booking surge | Searches/bookings still receive valid responses. | Higher Cloud Run request/concurrency and Cloud SQL activity. |

## Scope boundary

There is no monitoring dashboard navigation in this source product. After GCP verification, the future dashboard will use these flows and event names to define its overview, drill-down, alerts, resources, and cost pages.
