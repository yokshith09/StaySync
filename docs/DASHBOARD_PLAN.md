# Monitoring & Cost Optimization Dashboard — Plan

**Status:** built, in its own repository · **This is the graded deliverable.**

> The dashboard lives in its own repository, **[OPS_MIND](https://github.com/yokshith09/OPS_MIND)**
> (local path `E:\Vantage`), not here. StaySync is only the demo source
> application that produces the telemetry it reads. For what is and is not
> covered against the product document, see Vantage's `docs/REQUIREMENTS.md` —
> this file remains the original plan, kept for the reasoning behind it.

---

## 1. What we are actually building

Not a logging platform. §6.2 of the requirements explicitly rules that out:

> *"Building a general-purpose logging platform that replaces GCP Cloud Logging."*

We are building the **product layer that sits above** collected telemetry and answers a developer's
questions:

- Is the application healthy right now?
- What is failing, how often, and in which component?
- What is slow?
- Did a failure coincide with a resource spike?
- What are we spending, and where can we spend less?

StaySync produces the signals. The dashboard turns them into answers. Two separate services.

---

## 2. The constraint, and the design decision it forces

GCP billing is blocked, so we cannot reach Cloud Logging, Cloud Monitoring or the BigQuery billing
export today. We are not going to wait, and we are not going to invent fake data.

**The fact that saves us:** StaySync already emits exactly the shape Cloud Logging stores.

```json
{"timestamp":"...","severity":"WARNING","event":"order_stock_conflict","component":"orders",
 "entryPoint":"http","requestId":"...","route":"/api/orders","statusCode":409,
 "responseTimeMs":1,"environment":"production","message":"..."}
```

Cloud Run collects this by reading **stdout** and parsing each JSON line into `jsonPayload.*`. So if
we read the same stdout locally, we get the same records. Not a simulation — the same bytes from the
same application.

### Therefore: a source adapter layer

Every data access goes through an interface with two implementations.

```
          ┌──────────────── Dashboard UI ────────────────┐
          │  overview · logs · performance · resources   │
          │           cost · recommendations · alerts    │
          └───────────────────┬─────────────────────────┘
                              │
                      Dashboard API
                              │
                   ┌──────────┴──────────┐
                   │   Source interface  │
                   │  logs/metrics/cost  │
                   └──────────┬──────────┘
                              │
             ┌────────────────┴────────────────┐
             │                                 │
     LOCAL (today)                      GCP (when unblocked)
  stdout collector → Postgres        Cloud Logging API
  process metrics                    Cloud Monitoring API
  schema-shaped cost sample          BigQuery billing export
```

Swapping is a config change, not a rewrite. **The UI, the aggregations and the alert engine never
change** — only where the rows come from.

### Collector design

Zero changes to StaySync. Cloud Run reads stdout; so do we:

```bash
npm start | node dashboard/collector.js
```

The collector parses each JSON line and writes it to a `log_entries` table in the Supabase Postgres
we already have. Decoupled: StaySync has no idea the dashboard exists, and cannot be slowed or broken
by it. That property matters — the demo app must never depend on the thing observing it.

---

## 3. What can and cannot be real today

Being honest about this now prevents a nasty surprise at demo time.

| Dashboard area | Data today | Real? |
|---|---|---|
| **Log analytics** | StaySync's actual logs | **Fully real** |
| **Performance** | `responseTimeMs` on every log line | **Fully real** |
| **Alerts** | Thresholds evaluated over real logs | **Fully real** |
| **System overview** | Health, error rate, recent alerts | **Fully real** |
| **Resource usage** | Node `process.cpuUsage()`, `memoryUsage()`, event-loop lag, DB pool size | **Real, but process-level** — not Cloud Monitoring's infrastructure view |
| **Cost** | Sample rows in the **exact BigQuery billing export schema** | **Not real** — clearly labelled as awaiting billing export |
| **Recommendations** | Rules run against resource + cost inputs | **Logic real, cost inputs not** |

So roughly **five of seven areas are genuinely demonstrable** without GCP. Cost is the honest gap,
and it is gated on billing, not on engineering.

**Mitigation that costs nothing:** the moment billing clears, enable the BigQuery export first. The
cost view is already written against its documented schema, so it lights up with no code change.

---

## 4. Architecture

Separate service, same repository. The source app's own design brief forbids putting dashboard UI
inside StaySync, and the requirements treat them as distinct products.

```
dashboard/
  collector.js            stdin → parse JSON lines → log store
  src/
    server.js             HTTP + static, same pattern as StaySync
    api.js                dashboard endpoints
    sources/
      index.js            picks local or gcp from env
      local-logs.js       SQL over log_entries
      local-metrics.js    process metrics
      local-cost.js       schema-shaped sample
      gcp-logs.js         Cloud Logging API      (stub until unblocked)
      gcp-metrics.js      Cloud Monitoring API   (stub)
      gcp-cost.js         BigQuery billing       (stub)
    alerts.js             rule evaluation
  public/                 UI, reusing StaySync's design tokens
```

**Stack:** same as StaySync — plain Node, no framework, no build step, Web-standard
`Request`/`Response`. Reasons: consistency, nothing new to learn, no toolchain to break at 2am, and
we reuse `styles.css` so the two products look like one system. Charts via Chart.js from a CDN,
themed to the `DESIGN.md` palette.

**Database:** a `log_entries` table in the existing Supabase Postgres. SQL aggregation over logs is
also a good conceptual rehearsal for Cloud Logging's filter syntax.

---

## 5. Phases

Each phase is independently demoable. Stop at any point and still have something to show.

| # | Phase | Delivers | Requirement |
|---|---|---|---|
| 1 | **Pipeline** | `log_entries` schema, collector, backfill from a scenario run | §8 |
| 2 | **Source layer** | Interface + local implementations + GCP stubs | §13 |
| 3 | **Dashboard API** | Query, aggregate, timeseries, alert endpoints | §10.1–10.2 |
| 4 | **Overview + Log analytics** | Health, error rate, severity split, top errors, live log table with filters and drill-down | §10.1, §10.2, §11 |
| 5 | **Performance** | Latency trend, p50/p95, slowest routes, failure correlation | §10.2, §11 |
| 6 | **Alert engine** | Threshold rules, grouping, cooldown, active/recent alerts | §10.3, §14 |
| 7 | **Resource usage** | CPU, memory, event-loop lag, DB connections over time | §10.4, §11 |
| 8 | **Cost + recommendations** | Spend by service/SKU, trend, advisory rules with evidence | §10.5, §15 |
| 9 | **GCP swap** | Real Cloud Logging / Monitoring / BigQuery adapters | §13, §25 |

**Phases 1–6 are the core.** They are fully real with today's data and cover the majority of what is
graded. Phase 7 is real but process-level. Phase 8 is the honest gap. Phase 9 is gated on billing.

---

## 6. Alert rules (§14)

Every one of these fires on signals StaySync already produces:

| Alert | Condition | Source event |
|---|---|---|
| Error rate | `ERROR` share > 5% over 5 min | any |
| Payment failures | ≥3 `payment_provider_rejected` in 5 min | §14 application error |
| Latency | p95 `responseTimeMs` > 500ms over 5 min | §14 latency |
| Repeated failure | same `event` ≥10 times in 5 min | §14 repeated failure |
| Brute force | ≥5 `auth_rate_limited` in 10 min | security |
| Stock contention | ≥5 `order_stock_conflict` in 5 min | business signal |
| Dependency down | any `health_degraded` | §14 resource |
| Cost anomaly | daily spend > 1.5× 7-day mean | §14 cost (needs billing) |

Each alert carries: condition, first/last seen, count, affected component, and a link to the exact
filtered logs. §15 requires evidence attached to every recommendation — same principle here.

---

## 7. What this does and does not close

Against `REQUIREMENTS_COMPLIANCE.md`:

**Closes (locally demonstrable):** §10.1, §10.2, §10.3, §11 (5 of 7 areas), §12 journey, §14 alert
model, §19 KPIs for detection and reproducibility.

**Still blocked on GCP:** §25 criteria 2 (logs in Cloud Logging), 3 (programmatic query of *GCP*
data), 7 (Cloud Monitoring metrics), 8 (billing data). Those four need deployment, full stop.

**Realistic outcome:** dashboard complete and demoable, with roughly **6 of 10 acceptance criteria
met** once deployed, and the remaining four unblocking the same day billing clears.

---

## 8. Decisions taken

Flagged so they can be overridden rather than discovered later.

1. **Same repo, separate `dashboard/` directory.** Simplest for a hackathon; deploys as a second
   Cloud Run service.
2. **Plain Node, no framework.** Consistent with StaySync, no build step.
3. **Logs stored in Supabase Postgres.** Already available, persistent across restarts.
4. **Collector reads stdout via a pipe.** Zero changes to StaySync, mirrors Cloud Run exactly.
5. **Chart.js from CDN**, themed to our palette. Hand-rolled SVG would be more coherent but costs
   time we should spend on substance.
6. **Cost view built against the real BigQuery schema** with sample rows, clearly labelled. Honest,
   and swaps to live data without code changes.
