# StaySync Backend Schema and Events

## PostgreSQL entities

| Table | Essential fields | Purpose |
|---|---|---|
| `hotels` | `id`, `name`, `city` | Fictitious property context. |
| `rooms` | `id`, `hotel_id`, `name`, `capacity`, `nightly_rate_cents`, `housekeeping_status` | Searchable bookable room. |
| `reservations` | `id`, `room_id`, `check_in`, `check_out`, `guest_count`, `status`, `created_at` | Booking lifecycle: `HELD`, `CONFIRMED`, `PAYMENT_FAILED`, `CANCELLED`, `CHECKED_IN`, `CHECKED_OUT`. |
| `payment_attempts` | `id`, `reservation_id`, `status`, `provider_reference`, `created_at` | Simulated payment audit; no payment instrument details. |
| `outbox_events` | `id`, `event_type`, `aggregate_id`, `payload`, `published_at` | Reliably record confirmation event intent before Pub/Sub publish. |
| `idempotency_records` | `key`, `request_hash`, `response_status`, `response_body`, `created_at` | Prevent duplicate state-changing requests. |

## Integrity rules

- A transaction locks the room's relevant reservation state before creating a hold; overlaps of held/confirmed bookings are rejected.
- Payment attempts reference an existing held reservation.
- Confirmation events are created in the same transaction as confirmation state change; publisher/worker processing is at-least-once and idempotent.
- Guest name/email is intentionally excluded from the initial schema to keep the demo privacy-safe.

## Event envelope

```json
{
  "eventId": "uuid",
  "eventType": "booking.confirmation.requested",
  "occurredAt": "ISO-8601",
  "requestId": "uuid",
  "reservationId": "uuid",
  "schemaVersion": 1
}
```

The event contains no personal or payment data. The worker uses `eventId` for idempotent processing.
