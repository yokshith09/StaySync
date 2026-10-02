# StaySync — Manual GCP Deployment Guide

A step-by-step walkthrough. Every phase ends with a **Verify** step — do not move on until it passes.

**Time:** ~2 hours first time. **Cost:** ~$10/month, mostly Cloud SQL. Free trial credits cover it.

---

## Phase 0 — What each service does and why we need it

Read this once so the commands later make sense.

| Service | What it actually does | Why StaySync needs it |
|---|---|---|
| **Cloud Run** | Runs a container and gives it an HTTPS URL. Scales to zero when idle, scales up under load. You never touch a server or OS. | Hosts `staysync-api` (public) and `staysync-worker` (private). Scaling to zero is why this is cheap. |
| **Artifact Registry** | A private storage bucket for container images. | Cloud Run can only run images it can pull from a registry. This is where the built image lives. |
| **Cloud Build** | Runs build steps on Google's machines: installs deps, runs tests, builds the image, deploys. | Builds our container and later becomes our CI/CD pipeline. |
| **Cloud Buildpacks** | Inspects your source, detects Node.js, and produces a container **without a Dockerfile**. | We have no Dockerfile and don't need one. It reads `package.json`, installs deps, and sets `npm start` as the entrypoint. |
| **Cloud SQL for PostgreSQL** | A managed Postgres server — Google handles backups, patching, failover. | Our real database. Replaces Supabase, and §13 of the requirements names it explicitly. |
| **Secret Manager** | An encrypted store for credentials, with IAM-controlled access and versioning. | Holds `DATABASE_URL`. Credentials must never sit in plain env vars, in the image, or in git. |
| **Pub/Sub** | A message queue. A publisher drops a message on a *topic*; a *subscription* delivers it to a consumer. | Delivers order confirmation events from the API to the worker, so confirmation work happens outside the request cycle. |
| **Cloud Logging** | Collects anything your container writes to stdout. **No setup, no agent, no code change.** | **This is the dashboard's primary data source.** Cloud Run auto-parses single-line JSON into a structured `jsonPayload` — which is exactly the format StaySync already emits. |
| **Cloud Monitoring** | Collects infrastructure metrics automatically: CPU, memory, request count, latency, DB connections. | The dashboard's resource-usage view. Also free and automatic. |
| **Billing → BigQuery export** | Writes your daily spend into a BigQuery table you can query with SQL. | The dashboard's cost view. **Enable this first — it only collects data going forward and backfills slowly.** |
| **IAM** | Decides which identity may call which service. | Glue. Most "permission denied" errors you hit will be here. |

### A note on containers and Docker

A **container** is your app plus everything it needs to run (Node runtime, `node_modules`, your code) packed into one immutable image. The same image runs identically on your laptop and on Cloud Run — that's the whole point.

**You do not need to install Docker or write a Dockerfile.** Cloud Buildpacks builds the image for you on Google's infrastructure. Install Docker only if you later want to build and test images locally.

### Networking: how Cloud Run reaches Cloud SQL

Cloud Run has no VPC by default. When you pass `--add-cloudsql-instances`, Google mounts a **Unix socket** inside your container at `/cloudsql/PROJECT:REGION:INSTANCE`. Your app connects to that file path instead of a host and port — no IP, no firewall rule, no VPC connector, and the traffic never crosses the public internet.

That's why the connection string looks unusual:

```
postgresql://USER:PASSWORD@/DATABASE?host=/cloudsql/PROJECT:REGION:INSTANCE
```

No host before the `/`, because there is no TCP host — just a socket path. The `pg` driver in `src/store.js` already handles this.

---

## Phase 1 — Prerequisites

### 1.1 Google Cloud account

Create one at https://console.cloud.google.com. Enable billing (new accounts get $300 in credits). Billing must be on — most of these services refuse to start without it.

### 1.2 Choose your workspace: Cloud Shell (recommended)

Click the **terminal icon** in the top-right of the Cloud Console. You get a free Linux VM in the browser with `gcloud`, `node`, `git` and `psql` already installed, already authenticated.

**Use Cloud Shell for everything below.** It avoids installing the gcloud CLI and avoids the port-5432 egress problem on your local network.

If you'd rather work locally, install the gcloud CLI from https://cloud.google.com/sdk/docs/install, then `gcloud auth login`.

### 1.3 Create the project and set variables

```bash
# Pick a globally unique project id
export PROJECT_ID="staysync-hackathon-$(date +%s | tail -c 5)"
export REGION="asia-south1"     # Mumbai — closest to you. us-central1 is cheapest.

gcloud projects create $PROJECT_ID
gcloud config set project $PROJECT_ID
gcloud config set run/region $REGION
```

Then **link billing** in the Console: Billing → Link a billing account → select your project.

### 1.4 Enable the APIs

Nothing works until these are on. This takes a minute or two.

```bash
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  sqladmin.googleapis.com \
  secretmanager.googleapis.com \
  pubsub.googleapis.com \
  logging.googleapis.com \
  monitoring.googleapis.com
```

**Verify:**
```bash
gcloud services list --enabled | grep -E "run|sql|secret|pubsub|artifact"
```
You should see all of them listed.

### 1.5 Get the code

```bash
git clone https://github.com/yokshith09/StaySync.git
cd StaySync
```

---

## Phase 2 — Enable the billing export (do this first)

This has the longest lead time and takes five minutes. Doing it now means you have spend history by the time you build the cost view.

1. Console → **Billing** → **Billing export** → **BigQuery export** tab
2. Under *Detailed usage cost*, click **Edit settings**
3. Create a new BigQuery dataset (name it `billing_export`, location matching your region)
4. Save

**Verify:** Console → BigQuery → you should see a `billing_export` dataset. The table appears within ~24 hours and fills going forward. It will be empty today — that's expected and exactly why you're doing it now.

---

## Phase 3 — Artifact Registry

Create the repository that will hold your container images.

```bash
gcloud artifacts repositories create staysync \
  --repository-format=docker \
  --location=$REGION \
  --description="StaySync container images"
```

**Verify:**
```bash
gcloud artifacts repositories list --location=$REGION
```
You should see `staysync` with format `DOCKER`.

---

## Phase 4 — Cloud SQL

### 4.1 Create the instance

This takes 5–10 minutes. `db-f1-micro` is the smallest tier — fine for a demo.

```bash
gcloud sql instances create staysync-sql \
  --database-version=POSTGRES_15 \
  --tier=db-f1-micro \
  --region=$REGION \
  --storage-size=10GB \
  --storage-auto-increase
```

### 4.2 Create the database and an application user

Generate a strong password and keep it somewhere safe for the next step.

```bash
export DB_PASSWORD="$(openssl rand -base64 24)"
echo "Save this password: $DB_PASSWORD"

gcloud sql databases create staysync --instance=staysync-sql

gcloud sql users create staysync_app \
  --instance=staysync-sql \
  --password="$DB_PASSWORD"
```

### 4.3 Record the instance connection name

```bash
export INSTANCE_CONNECTION_NAME=$(gcloud sql instances describe staysync-sql \
  --format='value(connectionName)')
echo $INSTANCE_CONNECTION_NAME
```

It looks like `my-project:asia-south1:staysync-sql`. You need it twice more.

**Verify:**
```bash
gcloud sql instances describe staysync-sql --format='value(state)'
```
Must print `RUNNABLE`.

---

## Phase 5 — Apply the schema

The database is empty. We need tables, the transactional SQL functions, and the seeded accounts.

### 5.1 Start the Cloud SQL Auth Proxy

The proxy opens an authenticated tunnel from your shell to the instance, exposed on `localhost:5432`.

```bash
curl -o cloud-sql-proxy https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.11.0/cloud-sql-proxy.linux.amd64
chmod +x cloud-sql-proxy
./cloud-sql-proxy $INSTANCE_CONNECTION_NAME &
```

Wait for `Ready for new connections`.

### 5.2 Run the migration

```bash
npm ci
DATABASE_URL="postgresql://staysync_app:$DB_PASSWORD@localhost:5432/staysync" \
  node database/migrate.js
```

This applies `schema.sql`, then `functions.sql` (the transactional order functions and the RLS lockdown), then seeds the two demo accounts.

**Verify:** it should print `Migration complete: 14 products, 2 users.`

Double-check directly:
```bash
PGPASSWORD="$DB_PASSWORD" psql -h localhost -U staysync_app -d staysync \
  -c "SELECT count(*) FROM products; SELECT email, role FROM users;"
```

Then stop the proxy: `kill %1`

---

## Phase 6 — Secret Manager

Store the production connection string. Note the **socket form** — no host, because Cloud Run connects over the mounted Unix socket.

```bash
printf "postgresql://staysync_app:$DB_PASSWORD@/staysync?host=/cloudsql/$INSTANCE_CONNECTION_NAME" \
  | gcloud secrets create staysync-database-url --data-file=-
```

`printf` not `echo` — `echo` appends a newline that becomes part of the password and causes a baffling auth failure.

**Verify:**
```bash
gcloud secrets versions access latest --secret=staysync-database-url
```
Check it ends with your instance connection name and has no trailing newline.

---

## Phase 7 — IAM permissions

Cloud Run runs as the Compute Engine default service account. It currently cannot read secrets or reach Cloud SQL.

```bash
export PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
export RUN_SA="$PROJECT_NUMBER-compute@developer.gserviceaccount.com"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$RUN_SA" \
  --role="roles/secretmanager.secretAccessor"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$RUN_SA" \
  --role="roles/cloudsql.client"
```

**Verify:**
```bash
gcloud projects get-iam-policy $PROJECT_ID \
  --flatten="bindings[].members" \
  --filter="bindings.members:$RUN_SA" \
  --format="value(bindings.role)"
```
Both roles should appear. **Most first-deploy failures are a missing role here.**

---

## Phase 8 — First manual deploy

One command. It uploads your source, Buildpacks builds a container, pushes it to Artifact Registry, and deploys to Cloud Run.

```bash
gcloud run deploy staysync-api \
  --source . \
  --region=$REGION \
  --allow-unauthenticated \
  --port=8081 \
  --set-env-vars=NODE_ENV=production \
  --set-secrets=DATABASE_URL=staysync-database-url:latest \
  --add-cloudsql-instances=$INSTANCE_CONNECTION_NAME \
  --min-instances=0 \
  --max-instances=4
```

What each flag does:
- `--source .` — build from this directory using Buildpacks (no Dockerfile)
- `--allow-unauthenticated` — anyone can reach it; it's a public storefront
- `--port=8081` — Cloud Run sends traffic here and sets `PORT` to match
- `--set-secrets` — mounts the secret as the `DATABASE_URL` env var at runtime
- `--add-cloudsql-instances` — mounts the Cloud SQL socket
- `--min-instances=0` — scale to zero when idle, so you pay nothing

**Verify:**
```bash
export API_URL=$(gcloud run services describe staysync-api --region=$REGION --format='value(status.url)')
curl -s $API_URL/health
```

You want: `{"status":"healthy", ... "storage":"postgresql", ...}`

`"storage":"postgresql"` is the proof the Cloud SQL socket works. If you see `in_memory`, the secret didn't mount. If `degraded`, the socket or IAM is wrong — check `gcloud run services logs read staysync-api --region=$REGION`.

Open `$API_URL` in a browser. You should see the storefront with all 14 products.

---

## Phase 9 — Deploy the worker

Same image, different entrypoint. Private — only Pub/Sub should reach it.

```bash
gcloud run deploy staysync-worker \
  --source . \
  --region=$REGION \
  --no-allow-unauthenticated \
  --port=8082 \
  --command=node --args=src/worker.js \
  --set-env-vars=NODE_ENV=production \
  --set-secrets=DATABASE_URL=staysync-database-url:latest \
  --add-cloudsql-instances=$INSTANCE_CONNECTION_NAME \
  --min-instances=1 --max-instances=2
```

`--min-instances=1` keeps one instance warm so the outbox poller runs continuously.

**Verify:**
```bash
gcloud run services describe staysync-worker --region=$REGION --format='value(status.url)'
gcloud run services logs read staysync-worker --region=$REGION --limit=10
```
You should see `StaySync confirmation worker listening on port 8082`. A `curl` to its URL should return **403** — that's correct, it's private.

---

## Phase 10 — Pub/Sub

```bash
export WORKER_URL=$(gcloud run services describe staysync-worker --region=$REGION --format='value(status.url)')

gcloud pubsub topics create order-events

# A service account that is allowed to invoke the private worker
gcloud iam service-accounts create pubsub-invoker --display-name="Pub/Sub push invoker"

gcloud run services add-iam-policy-binding staysync-worker \
  --region=$REGION \
  --member="serviceAccount:pubsub-invoker@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/run.invoker"

gcloud pubsub subscriptions create order-events-push \
  --topic=order-events \
  --push-endpoint="$WORKER_URL/pubsub/confirmations" \
  --push-auth-service-account="pubsub-invoker@$PROJECT_ID.iam.gserviceaccount.com"
```

**Verify:**
```bash
gcloud pubsub subscriptions describe order-events-push --format='value(pushConfig.pushEndpoint)'
```

> **Note:** StaySync's outbox worker currently drains by **polling**, which works today. Publishing to this topic from the API is not yet wired — see "Known gaps" at the end.

---

## Phase 11 — Generate and verify logs

This is the step that unlocks the dashboard.

```bash
STAYSYNC_URL=$API_URL npm run scenario -- traffic-burst
STAYSYNC_URL=$API_URL npm run scenario -- database-timeout
STAYSYNC_URL=$API_URL npm run scenario -- auth-failure
STAYSYNC_URL=$API_URL npm run scenario -- payment-failure
STAYSYNC_URL=$API_URL npm run scenario -- stock-conflict
STAYSYNC_URL=$API_URL npm run scenario -- brute-force
```

### Verify logs arrived as structured data

```bash
gcloud logging read \
  'resource.type="cloud_run_revision" AND jsonPayload.event="payment_provider_rejected"' \
  --limit=5 --format=json
```

**This is the critical check.** You must see your fields as **`jsonPayload.event`, `jsonPayload.severity`, `jsonPayload.requestId`** — real queryable fields, not a blob of text. That proves Cloud Run parsed StaySync's single-line JSON correctly, which is what makes the dashboard possible.

Try a few more query shapes, since these become your dashboard queries:

```bash
# All errors
gcloud logging read 'resource.type="cloud_run_revision" AND severity="ERROR"' --limit=10

# One request end to end, by correlation id
gcloud logging read 'jsonPayload.requestId="<paste-a-request-id>"' --limit=20

# Slow requests
gcloud logging read 'jsonPayload.responseTimeMs>100' --limit=10
```

### Verify metrics

Console → **Monitoring** → **Metrics Explorer** → resource `Cloud Run Revision` → metric `Request count`. Run `traffic-burst` again and watch it move. Also check **Container CPU utilisation** and Cloud SQL **connections**.

**At this point you have everything the dashboard needs.**

---

## Phase 12 — CI/CD

Manual deploys are fine for learning. Automating means: push to GitHub → tests run → image builds → both services deploy.

Your `cloudbuild.yaml` already does all of this. Two things to fix first.

### 12.1 Update the placeholder

```bash
sed -i "s|_CLOUDSQL_INSTANCE: 'PROJECT:REGION:staysync-sql'|_CLOUDSQL_INSTANCE: '$INSTANCE_CONNECTION_NAME'|" cloudbuild.yaml
sed -i "s|_LOCATION: 'us-central1'|_LOCATION: '$REGION'|" cloudbuild.yaml
git commit -am "chore: point cloudbuild at the real Cloud SQL instance" && git push
```

### 12.2 Give Cloud Build permission to deploy

```bash
export CB_SA="$PROJECT_NUMBER@cloudbuild.gserviceaccount.com"

gcloud projects add-iam-policy-binding $PROJECT_ID --member="serviceAccount:$CB_SA" --role="roles/run.admin"
gcloud projects add-iam-policy-binding $PROJECT_ID --member="serviceAccount:$CB_SA" --role="roles/iam.serviceAccountUser"
gcloud projects add-iam-policy-binding $PROJECT_ID --member="serviceAccount:$CB_SA" --role="roles/artifactregistry.writer"
```

### 12.3 Connect GitHub and create the trigger

```bash
gcloud builds triggers create github \
  --name=staysync-main \
  --repo-name=StaySync \
  --repo-owner=yokshith09 \
  --branch-pattern="^master$" \
  --build-config=cloudbuild.yaml
```

If that errors asking you to connect the repository, do it once in the Console: **Cloud Build → Triggers → Connect Repository → GitHub** → authorise → select `yokshith09/StaySync`. Then re-run the command.

**Verify:** make a trivial commit, push, then:
```bash
gcloud builds list --limit=3
```
Status should go `WORKING` → `SUCCESS`. If a test fails, the build stops and **nothing deploys** — which is the point.

---

## Phase 13 — Security, domains, and hardening

### Already done
- Credentials in Secret Manager, never in git or the image
- Least-privilege DB user (`staysync_app`, not `postgres`)
- RLS enabled on all tables with no policies
- Passwords salted with scrypt; sessions in HttpOnly cookies
- Login throttling: 5 failures locks an address for 15 minutes
- HTTPS enforced automatically by Cloud Run

### Worth doing
```bash
# Budget alert so a runaway loop can't surprise you
# Console → Billing → Budgets & alerts → Create budget → $20, alert at 50/90/100%
```

Set `min-instances=0` on the API (already done) so idle costs nothing.

### Custom domain (optional)

The `.run.app` URL is fine for the hackathon. If you want your own:

```bash
gcloud beta run domain-mappings create --service=staysync-api --domain=shop.yourdomain.com --region=$REGION
```
Then add the DNS records it prints at your registrar. Certificates are provisioned automatically.

---

## Phase 14 — Tear down after the hackathon

Cloud SQL bills whether you use it or not.

```bash
gcloud sql instances delete staysync-sql
gcloud run services delete staysync-api --region=$REGION
gcloud run services delete staysync-worker --region=$REGION
# Or simply: gcloud projects delete $PROJECT_ID
```

---

## Known gaps to close later

1. **Pub/Sub publishing isn't wired.** The outbox is written transactionally and the worker drains it by polling — functionally correct, but nothing publishes to the `order-events` topic yet. Needs `@google-cloud/pubsub` in the API.
2. **Supabase vs Cloud SQL.** After this guide the app runs on Cloud SQL. Remove `SUPABASE_URL`/`SUPABASE_SECRET_KEY` from any production config so the driver path is used.
3. **Log retention.** Cloud Logging keeps 30 days by default. Fine for the hackathon.

---

## Quick reference

```bash
# Logs, live
gcloud run services logs tail staysync-api --region=$REGION

# Structured query
gcloud logging read 'jsonPayload.event="order_created"' --limit=10

# Redeploy by hand
gcloud run deploy staysync-api --source . --region=$REGION

# Service URL
gcloud run services describe staysync-api --region=$REGION --format='value(status.url)'

# Recent builds
gcloud builds list --limit=5
```
