# Implementation Plan: StaySync source product

## Dependency path

Data model → availability/hold API → guest UI → payment/event → staff operations → GCP adapters → deployment evidence → dashboard.

## Current vertical slice

Guest searches fictional rooms, creates a reservation hold, and receives a conflict for an overlapping room/date request. The slice includes structured logs and an in-memory store used only locally.

## Risks

- Concurrent booking logic must move into a Cloud SQL transaction before deployment.
- Local success is not GCP evidence; deployment remains a separate checkpoint.
