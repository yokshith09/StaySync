# StaySync demo source product

StaySync is the hotel booking and operations application that will generate the real GCP logs, events, database activity, and resource signals for the later monitoring dashboard.

## Current working flow

Guest room search → reservation hold → simulated payment → confirmation event request → hotel desk → check-in.

The local build uses safe fictional data and in-memory storage. Cloud SQL, Pub/Sub, Cloud Run, Secret Manager, and Cloud Logging are the next deployment milestone—not a dashboard integration.

## Commands

```powershell
node --test
node src/server.js
```

Open `http://localhost:8081`.

## Key source files

- `src/app.js`: HTTP contract and structured logging.
- `src/store.js`: local booking lifecycle and conflict rules.
- `public/`: guest and hotel-desk experience.
- `tasks/todo.md`: staged build checklist and dashboard gate.
