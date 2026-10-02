# Implementation Plan: StaySync source product

## Dependency path

Data model → catalogue/order API → customer UI → payment/outbox → staff operations → real database →
HTTPS transport → GCP adapters → deployment evidence → monitoring dashboard.

## Current state

The full order lifecycle works end to end: a customer browses an illustrated clothing catalogue,
places an order that reserves stock under row locks, pays through one of three simulated outcomes,
and sees an itemised receipt; staff fulfil the order and control stock. Every step emits one
structured log line.

The transactional rules now live in SQL functions, so the pg driver and the Supabase HTTPS transport
share one implementation and the same locking guarantee. RLS is enabled with no policies, so only the
server secret key reaches the tables. The in-memory store keeps the test suite config-free.

## Risks

- Local egress on port 5432 is blocked. The HTTPS transport exists to work around this and is the
  local default; the driver path remains the Cloud SQL route and its SQL was validated against the
  live schema.
- `SUPABASE_SECRET_KEY` must be pasted into `.env` from the dashboard before `npm run dev` reaches
  the hosted database.
- Local success is not GCP evidence; deployment remains a separate checkpoint before any dashboard
  work begins.
- The outbox is drained by polling. Real Pub/Sub publication is wired at deployment, when the topic
  and push subscription exist.
