# StaySync UI/UX Design Brief

## Design goal

Make StaySync feel like a trustworthy fashion retailer, not an operations prototype. Customers
should be able to judge a piece and complete an order quickly; staff should see order and stock state
without interpreting raw technical data.

## Screens

| Screen | Path | User | Core content | Primary action |
|---|---|---|---|---|
| Shop | `/` | Customer | Catalogue grid with product plates, search, category chips, price, stock state | Add to order |
| Sign in | `/signin` | Anyone | Sign-in and registration tabs, seeded demo accounts | Sign in |
| Your order | `/cart` | Customer | Line items with quantity steppers, summary, payment outcome | Place order, then pay |
| Your orders | `/orders` | Customer | Order history with status, itemised receipt | Pay or cancel |
| Fulfilment desk | `/operations` | Staff | Order queue, stock and availability controls | Mark fulfilled |
| Scenario lab | `/scenarios` | Demo operator | Session panel, named safe scenarios with expected event and severity | Run scenario |

## Interaction requirements

- Show catalogue, order, payment and fulfilment states plainly; never hide a state behind a spinner.
- Stock changes are visible immediately after an order so reservation is legible.
- Treat errors as actionable explanations, not technical messages. The API's human-readable
  `error.message` is surfaced directly.
- Staff status changes are explicit and reversible where appropriate.
- Never show a secret, a simulated payment instrument, or personal data in any surface.
- Do not build dashboard UI or monitoring language into this application.

## Visual direction

Follows `DESIGN.md`: limestone canvas, cypress ink, a single moss accent, clay reserved for
metadata. Generous spacing, readable price and status hierarchy, accessible contrast, and clear
state badges. No gradients, neon glows, emojis, or three equal feature cards.

## Implementation notes

- Header, footer and toast are rendered once by `mountChrome()` in `public/shared.js`, so navigation
  has a single source of truth and the staff link cannot leak to customers.
- Every interactive target is at least 44px; focus rings use the moss accent.
- Layout collapses to one column below 760px; the checkout summary stops being sticky below 980px.
- A print stylesheet strips chrome so a receipt prints cleanly.
- All database-sourced text is escaped before it reaches `innerHTML`.
- Product plates are 4:5 SVG, `object-fit: cover`, lazily loaded, with the product name as alt text.
- Cart, order and fulfilment rows carry a 64px thumbnail so a line is recognisable at a glance.
