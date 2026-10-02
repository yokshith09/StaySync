# StaySync Product Requirements Document (PRD)

## Product overview

StaySync is a fashion e-commerce store with full order management, built as the **demo source
product** for Cognizant Hackathon Use Case 2: *GCP Application Log Monitoring, Resource Usage & Cost Optimization
Platform*.

The Use Case 2 product document specifies an Order Management / E-commerce API as the demo
application (sections 1, 7 and 9), with flows for login, browsing products, placing an order,
payment, order history and health. This project implements that application so the monitoring
platform has real, correlated signals to ingest — without exposing personal data or credentials.

---

## Personas & journeys

| Persona | Role | Journey |
|---|---|---|
| **Customer** | Self-service buyer | Register or sign in → browse and filter the catalogue → add items → place order (stock reserved) → choose a simulated payment outcome → view receipt → track or cancel under *Your orders*. |
| **Operations staff** | Fulfilment | Sign in as `staff` → open the fulfilment desk → review the order queue → mark paid orders fulfilled → adjust stock levels and withdraw or relist products. |
| **Demo operator / judge** | Telemetry evaluation | Sign in → open the scenario lab (order scenarios refuse to run without a real session) → trigger payment rejection, slow payment, database timeout, stock contention, auth failure, unauthorized access, traffic burst or idempotent replay → inspect the resulting events in Cloud Logging and the load in Cloud Monitoring. |

---

## Functional requirements

1. **Authentication & identity**
   - Salted scrypt hashing and SHA-256 session tokens, using only `node:crypto`.
   - Sessions in an HttpOnly cookie; no token in browser storage.
   - Self-service registration with email validation, normalisation and duplicate detection;
     minimum password length of 8.
   - Five failed sign-ins lock an address for fifteen minutes, refused before the database is
     touched, with a `Retry-After` header. The lockout is per address, not global.
   - The email's domain must resolve to a mail server before an account is created, so fabricated
     domains are refused. This verifies the domain, not the individual mailbox.
   - The sign-in form carries no prefilled credentials; the seeded demo accounts are listed for
     reference only and have no special path through the login.
   - **No login bypass exists anywhere in the product**, including the scenario lab.
   - Role-based access: the fulfilment desk and stock control are `staff` only.

2. **Catalogue**
   - Fourteen clothing pieces across Outerwear, Knitwear, Shirting, Trousers, Dresses and Accessories.
   - Each piece carries an illustrated product plate drawn in the design-system palette.
   - Search across name, description and SKU; filter by category.
   - The public catalogue excludes products that are sold out or that staff have withdrawn.
   - Stock levels are visible, with a low-stock indication.

3. **Ordering**
   - Orders are priced server-side from the catalogue; the client never supplies a price.
   - Stock is reserved at order creation inside a transaction with row-level locking.
   - Contention returns `409 INSUFFICIENT_STOCK`; a withdrawn product returns `409 PRODUCT_UNAVAILABLE`.
   - `Idempotency-Key` guarantees a retried or double-submitted order creates exactly one order.
   - Cancellation returns reserved stock to the catalogue immediately.

4. **Payment**
   - Simulated approval, provider rejection (HTTP 502) and latency spike.
   - No payment card or financial data is collected or stored.
   - Every attempt is audited, including failures, so a 502 is traceable afterwards.
   - A printable, itemised receipt is available for any order.

5. **Fulfilment desk**
   - Live order queue across all customers with status and totals.
   - `PAID → FULFILLED` transition; only paid orders can be fulfilled.
   - Stock quantity editing and availability toggling, which immediately affects what customers can order.

6. **Telemetry & observability**
   - Every request and background job emits one line of structured JSON with a correlation id,
     stable event name and severity.
   - `/health` pings the database and reports a degraded dependency as 503.
   - No personal data, credentials or tokens are ever logged.

---

## Non-goals

- Real inventory, live payment processing, shipping or email delivery.
- A general-purpose logging platform replacing Cloud Logging.
- Autonomous modification of cloud resources; optimization output stays advisory.
- Any mock monitoring dashboard inside this application — the dashboard is a separate deliverable
  built from real GCP telemetry.

---

## Success criteria

- Customer and staff journeys complete locally and on Cloud Run.
- Concurrent orders for the last units of stock never oversell.
- A repeated order or payment request with one `Idempotency-Key` creates exactly one record.
- Every controlled scenario is findable in Cloud Logging by its stable event name.
- A traffic burst produces visible CPU, concurrency and database-connection movement in Cloud Monitoring.
- No credential or personal datum appears anywhere in the log output.
