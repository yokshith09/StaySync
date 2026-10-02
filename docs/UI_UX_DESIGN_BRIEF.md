# StaySync UI/UX Design Brief

## Design goal

Make StaySync feel like a trustworthy hotel product, not an operations prototype. Guests should complete a booking quickly; staff should see room and reservation state without interpreting raw technical data.

## Required screens

| Screen | User | Core content | Primary action |
|---|---|---|---|
| Search | Guest | date/guest controls, location/hotel context, room results | Search availability |
| Room detail | Guest | room imagery placeholder, amenities, rate, availability | Reserve room |
| Reservation and payment | Guest | selected dates, room, total, simulated payment status | Confirm booking |
| Confirmation | Guest | booking reference, status, dates, notice state | Return to search |
| Staff reservations | Staff | status, dates, room, operational state | Open reservation |
| Room operations | Staff | room status and housekeeping state | Update housekeeping |
| Demo scenario panel | Demo operator | named safe scenarios, expected product outcome | Generate scenario (development/demo only) |

## Interaction requirements

- Start with the guest booking UI; do not build dashboard UI in this phase.
- Show availability, hold, payment, and confirmation states plainly.
- Treat errors as actionable explanations, not technical messages.
- Never show a secret, simulated card details, or PII in operational/debug surfaces.
- Make staff status changes explicit and reversible where appropriate.

## Visual direction

Calm hospitality feel: generous spacing, readable price/date hierarchy, warm neutrals with one confident accent color, accessible contrast, and clear state badges. Avoid fake monitoring charts or monitoring-dashboard language in the source UI.
