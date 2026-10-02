# Use Case 2 — Requirements Compliance

**Assessed:** 2 October 2026 · **Source:** Use Case 2 Product Document v1.0 (1 October 2026)

## How to read this

StaySync is the **demo source application** the product document mandates (§7). The deliverable the
hackathon is judged on is the **monitoring and cost optimization platform** (§10, §11) that consumes
StaySync's telemetry. Those are two separate pieces of work, and only the first is built.

| Status | Meaning |
|---|---|
| **Met** | Implemented and verified by an automated test or a recorded live check. |
| **Partial** | Implemented in the source app, but unproven until deployed to GCP. |
| **Not met** | Not built. |
| **N/A — Phase 2** | Belongs to the monitoring platform, which has not been started. |

---

## Headline verdict

**No. The requirements are not all met, and they cannot be until the application runs on GCP.**

- The **demo source application (§7)** is complete and exceeds what the document asks for.
- The **monitoring and cost platform (§10.1–10.5, §11, §14, §15)** — the actual deliverable — **does not exist**.
- Everything requiring **GCP services (§8, §13)** is unproven: nothing is deployed, so there are no
  logs in Cloud Logging, no metrics in Cloud Monitoring, and no billing export in BigQuery.

Roughly **10 of the document's 25 substantive requirement areas are met**, 4 are partial, and
11 are Phase 2 work that has not begun.

---

## §3 / §4 — Problem statement & understanding

| Requirement | Status | Evidence |
|---|---|---|
| Deploy a demo application on GCP generating real-time logs | **Partial** | App is built and emits structured logs; **not deployed to GCP**. |
| Use Cloud Logging to collect logs | **Not met** | Requires deployment. Logs go to stdout in the Cloud Run `jsonPayload` shape, so collection is automatic once deployed. |
| Analyse errors, patterns, performance, system health | **N/A — Phase 2** | No analysis layer exists. |
| Monitor resource usage and cost for savings opportunities | **N/A — Phase 2** | Not started. |
| Present insights via a centralized dashboard with alerts | **N/A — Phase 2** | Not started. |

---

## §7 — Demo application

| Requirement | Status | Evidence |
|---|---|---|
| Order Management / E-commerce API | **Met** | Fashion store with full order lifecycle. |
| §7.2 Login flow | **Met** | `POST /api/auth/login`, scrypt + HttpOnly cookie sessions. |
| §7.2 Browse products | **Met** | `GET /api/products` with search and category filters. |
| §7.2 Place order | **Met** | `POST /api/orders`, server-side priced, stock reserved under row locks. |
| §7.2 Payment with success / timeout / failure | **Met** | `POST /api/payments`; approval, 502 rejection, latency spike. |
| §7.2 Order history / missing record | **Met** | `GET /api/orders/my`, `GET /api/orders/:id` → 404 `order_not_found`. |
| §7.2 Health check with degraded dependency | **Met** | `GET /health` pings the database, returns 503 `degraded`. |
| §7.3 Structured logs with timestamp, severity, service, endpoint, status, latency, message | **Met** | One JSON line per request; a test asserts every field on every line. |
| §7.4 Elevated payment error rate | **Met** | `payment-failure` scenario. |
| §7.4 Slow responses above a latency threshold | **Met** | `slow-payment` scenario (>125 ms). |
| §7.4 Database connection failures | **Met** | `database-timeout` scenario → 503. |
| §7.4 Request burst creating a resource spike | **Met** | `traffic-burst` (20 concurrent) and `mixed-load` scenarios. |
| §7.4 Repeated warnings for alert-noise demonstration | **Met** | `validation-storm`, `route-scan`, `brute-force` scenarios. |

**Assessment: fully met, and exceeded.** The document asks for 5 failure scenarios; 14 are
implemented, each emitting a distinct named event.

---

## §8 — Data & inputs

| Input | Status | Notes |
|---|---|---|
| Demo application logs | **Partial** | Produced correctly; not yet flowing into Cloud Logging. |
| Cloud Monitoring metrics | **Not met** | Requires deployment. |
| Cloud Billing export to BigQuery | **Not met** | Export not enabled. **This has lead time — it backfills slowly.** |
| GCP Recommender signals | **Not met** | Not integrated. |

---

## §10 — Product capabilities (the deliverable)

| Capability | Status |
|---|---|
| 10.1 Centralized log monitoring, filter by severity/service/endpoint/time | **N/A — Phase 2** |
| 10.2 Log analysis: volume, error rate, frequent errors, slow endpoints, health | **N/A — Phase 2** |
| 10.3 Threshold alerts | **N/A — Phase 2** |
| 10.4 Resource monitoring correlated with application behaviour | **N/A — Phase 2** |
| 10.5 Cost monitoring and optimization suggestions | **N/A — Phase 2** |
| 10.6 Automation, with optional AI explanation, never autonomous mutation | **N/A — Phase 2** |

**Assessment: none of §10 is built.** This is the core of what is being judged.

---

## §11 / §12 — Dashboard structure & user journey

All seven dashboard areas (system overview, log analytics, performance, resource usage, cost,
recommendations, alerts/incidents) and the seven-step developer journey are **N/A — Phase 2**.

The source app deliberately contains **no mock dashboard**, per its own design brief — the dashboard
is to be built from real GCP data, not faked.

---

## §13 — GCP role

| Service | Status |
|---|---|
| Cloud Logging | **Not met** — not deployed |
| Cloud Monitoring | **Not met** — not deployed |
| Cloud Billing → BigQuery | **Not met** — export not enabled |
| Recommender / Active Assist | **Not met** |
| Compute runtime (Cloud Run) | **Partial** — `cloudbuild.yaml` deploys API + worker; never executed |
| Dashboard application | **Not met** |

Currently the database is **Supabase Postgres**, not Cloud SQL. The `pg` driver path and
`DATABASE_URL` are already wired for Cloud SQL, so this is a connection-string change, not a rewrite.

---

## §14 / §15 — Alert model & cost logic

All six alert types (application error, repeated failure, latency, resource spike, cost anomaly,
optimization opportunity) are **N/A — Phase 2**.

The source app *produces* the signals three of them would fire on (`payment_provider_rejected`,
`payment_slow`, `order_stock_conflict`, `auth_rate_limited`), but nothing evaluates thresholds.

Cost logic (§15) is entirely **Not met** — no usage, cost, or recommendation data path exists.

---

## §16 — Cognizant framework (student task)

| Requirement | Status | Where |
|---|---|---|
| Analyse current process and inefficiencies | **Met** | `docs/PRD.md`, `MEMORY.md` §1 |
| Propose AI/automation/process redesign | **Partial** | Automation designed and documented; AI layer not built |
| Define data, tools, methods | **Met** | `docs/TRD.md`, `docs/BACKEND_SCHEMA.md` |
| Suggest KPIs/metrics | **Partial** | §19 KPIs listed in the source document; not instrumented |
| Risks, adoption, change management | **Met** | `docs/PRD.md` non-goals, `docs/IMPLEMENTATION_PLAN.md` constraints |
| Reflect on future improvements | **Met** | Roadmap in `MEMORY.md` §9 |

---

## §17 — Deliverable format

| Requirement | Status |
|---|---|
| 4–6 page report **or** 8–10 slide presentation | **Not met** — no submission artefact exists |
| Diagrams / flowcharts / mock-ups | **Partial** — architecture diagrams exist in `docs/TRD.md` and `MEMORY.md` |
| Working demoable screen | **Met** — six working pages |
| Short walkthrough video | **Not met** |

**This is a scoring risk.** The document is explicit that the submission is a report or deck, and
neither exists.

---

## §19 — KPIs

| KPI | Status |
|---|---|
| Log ingestion coverage | **Partial** — events exist; not in Cloud Logging |
| Dashboard freshness | **N/A — Phase 2** |
| Error detection | **Met** — 14 deterministic scenarios |
| Alert precision | **N/A — Phase 2** |
| Insight usefulness | **N/A — Phase 2** |
| Resource visibility | **Not met** |
| Cost visibility | **Not met** |
| Recommendation traceability | **N/A — Phase 2** |
| Demo reproducibility | **Met** — scenarios run identically from UI or CLI |

---

## §20 — Risks & compliance

| Risk | Mitigation status |
|---|---|
| Sensitive information in logs | **Met** — synthetic data only; a test asserts no credential ever reaches log output |
| Alert fatigue | **N/A — Phase 2** |
| Telemetry/cost overhead | **Partial** — logs are structured and minimal; retention not configured |
| Incorrect recommendation | **N/A — Phase 2** |
| Data freshness mismatch | **Not met** — must be surfaced in the dashboard |
| Permissions | **Met** — least-privilege DB role, RLS deny-all, secret key server-side only |
| Prototype overreach | **Met** — scope held to one app and a small service set |

---

## §25 — Acceptance criteria

| # | Criterion | Status |
|---|---|---|
| 1 | Demo app runs on GCP producing structured logs | **Partial** — produces them, not on GCP |
| 2 | Logs visible in centralized Cloud Logging | **Not met** |
| 3 | Product can query log data programmatically | **Not met** |
| 4 | Dashboard shows live and historical views | **Not met** |
| 5 | Known error scenarios detected and displayed | **Partial** — generated and named; nothing displays them |
| 6 | At least one alert threshold triggered deterministically | **Not met** — signal exists, alerting does not |
| 7 | Resource metrics visible | **Not met** |
| 8 | Cost data available with freshness context | **Not met** |
| 9 | At least one optimization suggestion from evidence | **Not met** |
| 10 | Outputs understandable without raw telemetry | **Not met** |

**1 of 10 acceptance criteria partially met. 0 fully met.** Every one of them depends on
deployment, the dashboard, or both.

---

## What this means

The hard part of the *source application* is done and is genuinely good: real concurrency control,
real authentication, idempotency, a transactional outbox, and 14 reproducible failure scenarios.

But the project is **roughly 40% of the way to the actual hackathon deliverable**, and the remaining
60% is the part being graded. The two highest-leverage moves, in order:

1. **Deploy to GCP.** Unblocks acceptance criteria 1, 2, 7 and the entire data layer in §8.
   Nothing else can start until this happens.
2. **Enable the Cloud Billing → BigQuery export immediately** — before anything else, because it
   backfills slowly and §25.8 cannot be demonstrated without history.

Then build the dashboard (§10, §11), then produce the submission artefact (§17).
