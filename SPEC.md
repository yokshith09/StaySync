# Spec: StaySync demo source

## Objective

Build a hospitality booking and operations demo that produces safe, structured, GCP-deployable telemetry. First release: room search, reservation holds, simulated payment, confirmation, and staff state changes. Dashboard work is excluded until deployment evidence exists.

## Commands

- Start: `node src/server.js`
- Test: `node --test`

## Structure

`src/` application/API, `public/` guest UI, `test/` behavior tests, `database/` Cloud SQL schema, `tasks/` plan/checkpoints.

## Testing and boundaries

- Always: validate inputs, add a test for behavior, emit safe JSON telemetry, run tests before a commit.
- Ask first: GCP resource creation, real integrations, new dependencies, schema changes after initial baseline.
- Never: log secrets, payment data, guest PII, or build the monitoring dashboard in this repository phase.

## Success criteria

The local guest flow can search rooms, create one hold, reject an overlapping hold, and emit queryable structured logs.

## Assumptions

No authentication, real payment provider, email service, or real guest data in the hackathon demo.
