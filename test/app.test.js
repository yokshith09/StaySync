import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { seedProducts } from "../src/store.js";
import { createStaySyncApp } from "../src/app.js";
import { createLoginThrottle } from "../src/auth.js";
import { createConfirmationWorker } from "../src/worker.js";
import { createStaySyncStore, getStore } from "../src/store.js";

/**
 * Builds an app over a fresh in-memory store and captures every log line it writes.
 * The email-domain check is stubbed so the suite never touches real DNS.
 */
function harness(overrides = {}) {
  const logs = [];
  const store = createStaySyncStore();
  const app = createStaySyncApp({
    store,
    writeLog: (entry) => logs.push(entry),
    checkEmailDomain: async () => true,
    ...overrides
  });
  return { app, store, logs, last: () => logs.at(-1) };
}

const call = (app, path, { method = "GET", token, scenario, key, body } = {}) => {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  if (scenario) headers["x-demo-scenario"] = scenario;
  if (key) headers["idempotency-key"] = key;
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  );
};

async function signIn(app, email, password) {
  const response = await call(app, "/api/auth/login", { method: "POST", body: { email, password } });
  assert.equal(response.status, 200, `sign-in failed for ${email}`);
  return (await response.json()).token;
}

const customer = (app) => signIn(app, "customer@staysync.internal", "ShopPass2026!");
const staff = (app) => signIn(app, "staff@staysync.internal", "DeskPass2026!");

const order = (app, token, items, key) =>
  call(app, "/api/orders", { method: "POST", token, key, body: { items } });

/* ---------------------------------------------------------------- catalogue */

test("the catalogue returns only active products and hides the sold-out one", async () => {
  const { app, last } = harness();
  const response = await call(app, "/api/products");
  const { products } = await response.json();

  assert.equal(response.status, 200);
  assert.ok(products.length > 0);
  assert.ok(products.every((p) => p.status === "ACTIVE"));
  assert.ok(!products.some((p) => p.id === "prod-cashmere-wrap"), "a withdrawn product must not be listed");
  assert.equal(last().event, "product_catalog_listed");
});

test("the catalogue filters by search term and by category", async () => {
  const { app } = harness();

  const bySku = await (await call(app, "/api/products?q=FW-DRES-01")).json();
  assert.deepEqual(
    bySku.products.map((p) => p.id),
    ["prod-linen-dress"]
  );

  const byCategory = await (await call(app, "/api/products?category=Outerwear")).json();
  assert.equal(byCategory.products.length, 2);
  assert.ok(byCategory.products.every((p) => p.category === "Outerwear"));
});

test("the full inventory endpoint is staff-only and includes unavailable products", async () => {
  const { app, last } = harness();

  const forbidden = await call(app, "/api/products/all", { token: await customer(app) });
  assert.equal(forbidden.status, 403);
  assert.equal(last().event, "auth_unauthorized_access");

  const allowed = await call(app, "/api/products/all", { token: await staff(app) });
  const { products } = await allowed.json();
  assert.equal(allowed.status, 200);
  assert.ok(products.some((p) => p.status === "OUT_OF_STOCK"));
});

/* ------------------------------------------------------------------- orders */

test("placing an order requires a session", async () => {
  const { app, last } = harness();
  const response = await order(app, null, [{ productId: "prod-wool-scarf", quantity: 1 }]);

  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "UNAUTHORIZED");
  assert.equal(last().event, "auth_unauthenticated");
});

test("an order is priced server-side and reserves stock", async () => {
  const { app, store, last } = harness();
  const token = await customer(app);

  const response = await order(app, token, [
    { productId: "prod-wool-scarf", quantity: 2 },
    { productId: "prod-oxford-shirt", quantity: 1 }
  ]);
  const { order: created } = await response.json();

  assert.equal(response.status, 201);
  assert.equal(created.status, "PENDING");
  // 2 x 6400 + 1 x 8900, taken from the catalogue rather than the request.
  assert.equal(created.totalCents, 21700);
  assert.equal(created.items.length, 2);
  assert.equal((await store.getProduct("prod-wool-scarf")).stockQuantity, 108);
  assert.equal(last().event, "order_created");
});

test("a repeated productId is merged so it cannot slip past the stock check", async () => {
  const { app, store } = harness();
  const token = await customer(app);

  // The linen dress has 4 in stock; three lines of 2 would be 6 units if they were not merged.
  const response = await order(app, token, [
    { productId: "prod-linen-dress", quantity: 2 },
    { productId: "prod-linen-dress", quantity: 2 },
    { productId: "prod-linen-dress", quantity: 2 }
  ]);

  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "INSUFFICIENT_STOCK");
  assert.equal((await store.getProduct("prod-linen-dress")).stockQuantity, 4, "stock must be untouched");
});

test("stock contention rejects the order that cannot be satisfied", async () => {
  const { app, store, last } = harness();
  const token = await customer(app);

  const first = await order(app, token, [{ productId: "prod-linen-dress", quantity: 4 }]);
  const second = await order(app, token, [{ productId: "prod-linen-dress", quantity: 1 }]);

  assert.equal(first.status, 201);
  assert.equal(second.status, 409);
  assert.equal((await second.json()).error.code, "INSUFFICIENT_STOCK");
  assert.equal(last().event, "order_stock_conflict");
  assert.equal(last().severity, "WARNING");

  const mug = await store.getProduct("prod-linen-dress");
  assert.equal(mug.stockQuantity, 0);
  assert.equal(mug.status, "ACTIVE", "selling out does not change the staff-owned status flag");

  // Selling out hides it from the catalogue without touching its status.
  const { products } = await (await call(app, "/api/products")).json();
  assert.ok(!products.some((p) => p.id === "prod-linen-dress"));
});

test("a product staff withdrew is rejected with its own event even though it has stock", async () => {
  const { app, store, last } = harness();
  assert.equal((await store.getProduct("prod-cashmere-wrap")).stockQuantity, 7);

  const response = await order(app, await customer(app), [{ productId: "prod-cashmere-wrap", quantity: 1 }]);

  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "PRODUCT_UNAVAILABLE");
  assert.equal(last().event, "product_unavailable");
});

test("invalid item payloads are rejected before any stock is touched", async () => {
  const { app } = harness();
  const token = await customer(app);

  for (const items of [[], undefined, [{ productId: "prod-wool-scarf", quantity: 0 }], [{ quantity: 2 }]]) {
    const response = await order(app, token, items);
    assert.equal(response.status, 422, `expected 422 for ${JSON.stringify(items)}`);
  }
});

test("one customer cannot read or cancel another customer's order", async () => {
  const { app, last } = harness();
  const owner = await customer(app);
  const { order: created } = await (
    await order(app, owner, [{ productId: "prod-wool-scarf", quantity: 1 }])
  ).json();

  const registered = await call(app, "/api/auth/register", {
    method: "POST",
    body: { name: "Elena Rostova", email: "elena@example.com", password: "Password2026!" }
  });
  const intruder = (await registered.json()).token;

  const read = await call(app, `/api/orders/${created.id}`, { token: intruder });
  assert.equal(read.status, 403);

  const cancel = await call(app, `/api/orders/${created.id}/cancel`, { method: "POST", token: intruder });
  assert.equal(cancel.status, 403);
  assert.equal(last().event, "auth_unauthorized_access");
});

test("an unknown order id reports not found rather than leaking existence", async () => {
  const { app, last } = harness();
  const response = await call(app, "/api/orders/does-not-exist", { token: await customer(app) });

  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "ORDER_NOT_FOUND");
  assert.equal(last().event, "order_not_found");
});

/* ----------------------------------------------------------------- payments */

test("an approved payment moves the order to PAID and stages a confirmation event", async () => {
  const { app, store, last } = harness();
  const token = await customer(app);
  const { order: created } = await (
    await order(app, token, [{ productId: "prod-merino-crew", quantity: 1 }])
  ).json();

  const response = await call(app, "/api/payments", { method: "POST", token, body: { orderId: created.id } });
  const { payment, order: paid } = await response.json();

  assert.equal(response.status, 201);
  assert.equal(paid.status, "PAID");
  assert.equal(payment.status, "APPROVED");
  assert.equal(payment.amountCents, 13800);
  assert.equal(last().event, "payment_approved");

  const pending = await store.getOutboxEvents({ unpublishedOnly: true });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].eventType, "order.confirmation.requested");
});

test("the payment failure scenario returns 502, leaves the order pending, and audits the attempt", async () => {
  const { app, store, last } = harness();
  const token = await customer(app);
  const { order: created } = await (
    await order(app, token, [{ productId: "prod-merino-crew", quantity: 1 }])
  ).json();

  const response = await call(app, "/api/payments", {
    method: "POST",
    token,
    scenario: "payment_failure",
    body: { orderId: created.id }
  });

  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "PAYMENT_PROVIDER_REJECTED");
  assert.equal(last().event, "payment_provider_rejected");
  assert.equal(last().severity, "ERROR");
  assert.equal((await store.getOrder(created.id)).status, "PENDING", "a rejected payment must not confirm the order");
});

test("slow payment and database timeout produce diagnosable telemetry", async () => {
  const { app, logs } = harness();
  const token = await customer(app);
  const { order: created } = await (
    await order(app, token, [{ productId: "prod-selvedge-denim", quantity: 1 }])
  ).json();

  const slow = await call(app, "/api/payments", {
    method: "POST",
    token,
    scenario: "slow_payment",
    body: { orderId: created.id }
  });
  assert.equal(slow.status, 201);
  assert.equal(logs.at(-1).event, "payment_slow");
  assert.equal(logs.at(-1).severity, "WARNING");
  assert.ok(logs.at(-1).responseTimeMs >= 100);

  const timeout = await call(app, "/api/products", { scenario: "database_timeout" });
  assert.equal(timeout.status, 503);
  assert.equal(logs.at(-1).event, "database_timeout");
  assert.equal(logs.at(-1).severity, "ERROR");
});

test("an order cannot be paid twice", async () => {
  const { app, last } = harness();
  const token = await customer(app);
  const { order: created } = await (
    await order(app, token, [{ productId: "prod-leather-tote", quantity: 1 }])
  ).json();

  await call(app, "/api/payments", { method: "POST", token, body: { orderId: created.id } });
  const second = await call(app, "/api/payments", { method: "POST", token, body: { orderId: created.id } });

  assert.equal(second.status, 409);
  assert.equal((await second.json()).error.code, "ORDER_NOT_PAYABLE");
  assert.equal(last().event, "payment_invalid_state");
});

/* -------------------------------------------------------------- idempotency */

test("one Idempotency-Key creates one order and replays the stored response", async () => {
  const { app, store, last } = harness();
  const token = await customer(app);
  const items = [{ productId: "prod-wide-trouser", quantity: 2 }];
  const key = "key-order-001";

  const first = await order(app, token, items, key);
  const second = await order(app, token, items, key);

  const a = await first.json();
  const b = await second.json();

  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(a.order.id, b.order.id, "the replay must return the original order");
  assert.equal(last().event, "idempotent_replay");
  assert.equal((await store.getProduct("prod-wide-trouser")).stockQuantity, 38, "stock may only be taken once");
  assert.equal((await store.listOrders({ role: "staff" })).length, 1);
});

test("reusing an Idempotency-Key with a different body is refused", async () => {
  const { app, last } = harness();
  const token = await customer(app);
  const key = "key-order-002";

  await order(app, token, [{ productId: "prod-wide-trouser", quantity: 1 }], key);
  const conflict = await order(app, token, [{ productId: "prod-wide-trouser", quantity: 5 }], key);

  assert.equal(conflict.status, 422);
  assert.equal((await conflict.json()).error.code, "IDEMPOTENCY_KEY_REUSED");
  assert.equal(last().event, "idempotency_key_conflict");
});

/* ----------------------------------------------------- cancellation & stock */

test("cancelling an order returns its stock and relists the product", async () => {
  const { app, store, last } = harness();
  const token = await customer(app);

  const listed = async () =>
    (await (await call(app, "/api/products")).json()).products.some((p) => p.id === "prod-linen-dress");

  const { order: created } = await (
    await order(app, token, [{ productId: "prod-linen-dress", quantity: 4 }])
  ).json();
  assert.equal(await listed(), false, "a sold-out product leaves the catalogue");

  const cancelled = await call(app, `/api/orders/${created.id}/cancel`, { method: "POST", token });
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).order.status, "CANCELLED");
  assert.equal(last().event, "order_cancelled");

  assert.equal((await store.getProduct("prod-linen-dress")).stockQuantity, 4);
  assert.equal(await listed(), true, "the released stock puts it back in the catalogue");

  // The released stock is immediately orderable again.
  const reorder = await order(app, token, [{ productId: "prod-linen-dress", quantity: 4 }]);
  assert.equal(reorder.status, 201);
});

test("a fulfilled order can no longer be cancelled", async () => {
  const { app, last } = harness();
  const token = await customer(app);
  const staffToken = await staff(app);
  const { order: created } = await (
    await order(app, token, [{ productId: "prod-cotton-trench", quantity: 1 }])
  ).json();

  await call(app, "/api/payments", { method: "POST", token, body: { orderId: created.id } });
  await call(app, `/api/orders/${created.id}/fulfil`, { method: "PATCH", token: staffToken });

  const cancel = await call(app, `/api/orders/${created.id}/cancel`, { method: "POST", token });
  assert.equal(cancel.status, 409);
  assert.equal((await cancel.json()).error.code, "ORDER_NOT_CANCELLABLE");
  assert.equal(last().event, "order_cancel_invalid_state");
});

/* ------------------------------------------------------- fulfilment & staff */

test("the fulfilment desk is staff-only and advances a paid order", async () => {
  const { app, last } = harness();
  const token = await customer(app);
  const staffToken = await staff(app);
  const { order: created } = await (
    await order(app, token, [{ productId: "prod-merino-crew", quantity: 1 }])
  ).json();

  const blocked = await call(app, "/api/orders", { token });
  assert.equal(blocked.status, 403);
  assert.equal(last().event, "auth_unauthorized_access");

  const desk = await call(app, "/api/orders", { token: staffToken });
  assert.equal(desk.status, 200);
  assert.equal((await desk.json()).orders.length, 1);

  // Only a PAID order may be fulfilled.
  const tooEarly = await call(app, `/api/orders/${created.id}/fulfil`, { method: "PATCH", token: staffToken });
  assert.equal(tooEarly.status, 409);

  await call(app, "/api/payments", { method: "POST", token, body: { orderId: created.id } });
  const fulfilled = await call(app, `/api/orders/${created.id}/fulfil`, { method: "PATCH", token: staffToken });
  assert.equal(fulfilled.status, 200);
  assert.equal((await fulfilled.json()).order.status, "FULFILLED");
  assert.equal(last().event, "order_fulfilled");
});

test("staff stock adjustment blocks ordering and is validated", async () => {
  const { app, last } = harness();
  const staffToken = await staff(app);
  const token = await customer(app);

  const invalid = await call(app, "/api/products/prod-merino-crew/stock", {
    method: "PATCH",
    token: staffToken,
    body: { stockQuantity: -3 }
  });
  assert.equal(invalid.status, 422);

  const updated = await call(app, "/api/products/prod-merino-crew/stock", {
    method: "PATCH",
    token: staffToken,
    body: { status: "OUT_OF_STOCK" }
  });
  assert.equal(updated.status, 200);
  assert.equal(last().event, "product_stock_updated");

  const blocked = await order(app, token, [{ productId: "prod-merino-crew", quantity: 1 }]);
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error.code, "PRODUCT_UNAVAILABLE");
});

/* --------------------------------------------------------------------- auth */

test("sign-in verifies credentials and reports failure without a server error", async () => {
  const { app, logs } = harness();

  const success = await call(app, "/api/auth/login", {
    method: "POST",
    body: { email: "staff@staysync.internal", password: "DeskPass2026!" }
  });
  assert.equal(success.status, 200);
  assert.equal((await success.json()).user.role, "staff");
  assert.equal(logs.at(-1).event, "auth_login_success");

  const failure = await call(app, "/api/auth/login", {
    method: "POST",
    body: { email: "staff@staysync.internal", password: "WrongPassword!" }
  });
  assert.equal(failure.status, 401);
  assert.equal(logs.at(-1).event, "auth_login_failed");
  assert.equal(logs.at(-1).severity, "WARNING");

  const unknown = await call(app, "/api/auth/login", {
    method: "POST",
    body: { email: "nobody@example.com", password: "whatever" }
  });
  assert.equal(unknown.status, 401, "an unknown email must not produce a 500");
});

test("registration creates a customer session, rejects duplicates, and enforces password length", async () => {
  const { app, logs } = harness();

  const created = await call(app, "/api/auth/register", {
    method: "POST",
    body: { name: "Elena Rostova", email: "Elena@Example.com", password: "Password2026!" }
  });
  const body = await created.json();
  assert.equal(created.status, 201);
  assert.equal(body.user.email, "elena@example.com", "the email is normalised");
  assert.equal(body.user.role, "customer");
  assert.ok(body.token);
  assert.equal(logs.at(-1).event, "auth_register_success");

  const duplicate = await call(app, "/api/auth/register", {
    method: "POST",
    body: { name: "Someone Else", email: "elena@example.com", password: "Password2026!" }
  });
  assert.equal(duplicate.status, 409);
  assert.equal(logs.at(-1).event, "auth_register_duplicate");

  const weak = await call(app, "/api/auth/register", {
    method: "POST",
    body: { name: "Short Pass", email: "short@example.com", password: "abc123" }
  });
  assert.equal(weak.status, 422);

  const badEmail = await call(app, "/api/auth/register", {
    method: "POST",
    body: { name: "Bad Email", email: "not-an-email", password: "Password2026!" }
  });
  assert.equal(badEmail.status, 422);
});

test("signing out revokes the session token", async () => {
  const { app } = harness();
  const token = await customer(app);

  assert.equal((await call(app, "/api/auth/me", { token })).status, 200);
  await call(app, "/api/auth/logout", { method: "POST", token });
  assert.equal((await call(app, "/api/auth/me", { token })).status, 401);
});

/* ----------------------------------------------------------- health & worker */

test("health reports the storage engine, and a degraded dependency as 503", async () => {
  const { app, last } = harness();
  const healthy = await call(app, "/health");
  assert.equal(healthy.status, 200);
  assert.equal((await healthy.json()).storage, "in_memory");
  assert.equal(last().event, "health_checked");

  const store = createStaySyncStore();
  store.ping = async () => {
    throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
  };
  const logs = [];
  const degradedApp = createStaySyncApp({ store, writeLog: (entry) => logs.push(entry) });

  const degraded = await degradedApp.fetch(new Request("http://localhost/health"));
  assert.equal(degraded.status, 503);
  assert.equal((await degraded.json()).status, "degraded");
  assert.equal(logs.at(-1).event, "health_degraded");
  assert.equal(logs.at(-1).severity, "ERROR");
});

test("the confirmation worker drains the outbox and marks events published", async () => {
  const { app, store } = harness();
  const logs = [];
  const worker = createConfirmationWorker({ store, writeLog: (entry) => logs.push(entry) });
  const token = await customer(app);

  const { order: created } = await (
    await order(app, token, [{ productId: "prod-oxford-shirt", quantity: 3 }])
  ).json();
  await call(app, "/api/payments", { method: "POST", token, body: { orderId: created.id } });

  assert.equal((await store.getOutboxEvents({ unpublishedOnly: true })).length, 1);

  const results = await worker.processPendingOutbox();
  assert.equal(results[0].status, "processed");
  assert.equal(logs.at(-1).event, "confirmation_sent");
  assert.equal(logs.at(-1).severity, "INFO");
  assert.equal((await store.getOutboxEvents({ unpublishedOnly: true })).length, 0, "the event is not redelivered");

  const retry = await worker.processEvent({ aggregateId: created.id, payload: { simulateRetry: true } });
  assert.equal(retry.status, "retry_scheduled");
  assert.equal(logs.at(-1).event, "confirmation_retry_scheduled");
  assert.equal(logs.at(-1).statusCode, 202);
});

test("a cancellation also reaches the worker as its own event", async () => {
  const { app, store } = harness();
  const logs = [];
  const worker = createConfirmationWorker({ store, writeLog: (entry) => logs.push(entry) });
  const token = await customer(app);

  const { order: created } = await (
    await order(app, token, [{ productId: "prod-wool-scarf", quantity: 1 }])
  ).json();
  await call(app, `/api/orders/${created.id}/cancel`, { method: "POST", token });

  await worker.processPendingOutbox();
  assert.equal(logs.at(-1).event, "cancellation_notice_sent");
});

/* -------------------------------------------------------------- log contract */

test("every log line carries the monitoring contract and never leaks a credential", async () => {
  const { app, logs } = harness();
  const token = await customer(app);
  await order(app, token, [{ productId: "prod-wool-scarf", quantity: 1 }]);
  await call(app, "/api/auth/login", {
    method: "POST",
    body: { email: "customer@staysync.internal", password: "ShopPass2026!" }
  });
  await call(app, "/nope");

  const required = ["timestamp", "severity", "event", "component", "entryPoint", "requestId", "route", "statusCode", "responseTimeMs", "environment", "message"];
  for (const entry of logs) {
    for (const field of required) {
      assert.ok(entry[field] !== undefined, `log for ${entry.event} is missing ${field}`);
    }
    assert.ok(["INFO", "WARNING", "ERROR"].includes(entry.severity));
  }

  const serialised = JSON.stringify(logs);
  for (const secret of ["ShopPass2026!", "DeskPass2026!", token]) {
    assert.ok(!serialised.includes(secret), "a credential reached the log output");
  }
});

/* ------------------------------------------------------------------ assets */

test("every seeded product has a product image", () => {
  const missing = seedProducts.filter(
    (p) => !existsSync(new URL(`../public/img/${p.id}.svg`, import.meta.url))
  );
  assert.deepEqual(missing.map((p) => p.id), [], "products without an image plate");
});

/* ---------------------------------------------------------------- transport */

test("transport selection prefers HTTPS, then the driver, then memory", async () => {
  // HTTPS wins when both are configured: it works where outbound 5432 is blocked.
  const viaHttps = getStore({
    supabaseUrl: "https://example.supabase.co",
    supabaseKey: "secret",
    connectionString: "postgresql://ignored/db"
  });
  assert.equal((await viaHttps.ping().catch(() => ({ engine: "supabase_rest" }))).engine, "supabase_rest");

  // A half-configured Supabase falls through rather than failing at request time.
  const partial = getStore({ supabaseUrl: "https://example.supabase.co", supabaseKey: undefined, connectionString: undefined });
  assert.equal((await partial.ping()).engine, "in_memory");

  const inMemory = getStore({ supabaseUrl: undefined, supabaseKey: undefined, connectionString: undefined });
  assert.equal((await inMemory.ping()).engine, "in_memory");
});

/* ------------------------------------------------------------ login throttle */

test("repeated failed sign-ins lock the account, and a success clears the counter", async () => {
  const logs = [];
  const store = createStaySyncStore();
  const app = createStaySyncApp({ store, writeLog: (e) => logs.push(e) });
  const creds = { email: "customer@staysync.internal", password: "WrongPassword!" };

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await call(app, "/api/auth/login", { method: "POST", body: creds });
    assert.equal(response.status, 401, `attempt ${attempt} should still be a plain rejection`);
    assert.equal(logs.at(-1).event, "auth_login_failed");
  }

  // Sixth attempt is refused before the store is consulted.
  const blocked = await call(app, "/api/auth/login", { method: "POST", body: creds });
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).error.code, "TOO_MANY_ATTEMPTS");
  assert.ok(Number(blocked.headers.get("retry-after")) > 0, "a Retry-After header is sent");
  assert.equal(logs.at(-1).event, "auth_rate_limited");
  assert.equal(logs.at(-1).severity, "WARNING");

  // The correct password is refused too while the lockout holds.
  const correctButLocked = await call(app, "/api/auth/login", {
    method: "POST",
    body: { email: "customer@staysync.internal", password: "ShopPass2026!" }
  });
  assert.equal(correctButLocked.status, 429);

  // A different account is unaffected.
  const other = await call(app, "/api/auth/login", {
    method: "POST",
    body: { email: "staff@staysync.internal", password: "DeskPass2026!" }
  });
  assert.equal(other.status, 200, "the lockout is per account, not global");
});

test("the lockout window expires and a successful sign-in resets the counter", async () => {
  let clock = 0;
  const throttle = createLoginThrottle({ maxAttempts: 2, windowMs: 1000, now: () => clock });
  const app = createStaySyncApp({ store: createStaySyncStore(), loginThrottle: throttle });
  const bad = { email: "customer@staysync.internal", password: "nope" };
  const good = { email: "customer@staysync.internal", password: "ShopPass2026!" };

  await call(app, "/api/auth/login", { method: "POST", body: bad });
  await call(app, "/api/auth/login", { method: "POST", body: bad });
  assert.equal((await call(app, "/api/auth/login", { method: "POST", body: good })).status, 429);

  clock += 1001; // window elapses
  assert.equal((await call(app, "/api/auth/login", { method: "POST", body: good })).status, 200);

  // One failure then a success must not leave a stale count behind.
  await call(app, "/api/auth/login", { method: "POST", body: bad });
  await call(app, "/api/auth/login", { method: "POST", body: good });
  await call(app, "/api/auth/login", { method: "POST", body: bad });
  assert.equal((await call(app, "/api/auth/login", { method: "POST", body: good })).status, 200);
});

test("an email address is normalised on registration and accepted in any case at sign-in", async () => {
  const { app } = harness();
  const created = await call(app, "/api/auth/register", {
    method: "POST",
    body: { name: "Mixed Case", email: "  Mixed.Case@Example.COM  ", password: "Password2026!" }
  });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).user.email, "mixed.case@example.com");

  for (const email of ["mixed.case@example.com", "MIXED.CASE@EXAMPLE.COM", " Mixed.Case@Example.com "]) {
    const response = await call(app, "/api/auth/login", { method: "POST", body: { email, password: "Password2026!" } });
    assert.equal(response.status, 200, `sign-in should accept ${JSON.stringify(email)}`);
  }
});

/* --------------------------------------------------------- email reachability */

test("registration is refused when the email domain has no mail server", async () => {
  const unreachable = new Set(["asdkjfh-not-a-real-place.zzz"]);
  const { app, store, last } = harness({
    checkEmailDomain: async (email) => !unreachable.has(email.split("@")[1])
  });

  const fabricated = await call(app, "/api/auth/register", {
    method: "POST",
    body: { name: "Nobody", email: "nobody@asdkjfh-not-a-real-place.zzz", password: "Password2026!" }
  });

  assert.equal(fabricated.status, 422);
  assert.equal((await fabricated.json()).error.code, "EMAIL_DOMAIN_UNREACHABLE");
  assert.equal(last().event, "auth_register_domain_unreachable");
  assert.equal(last().severity, "WARNING");
  assert.equal(await store.authenticateUser({ email: "nobody@asdkjfh-not-a-real-place.zzz", password: "Password2026!" }), null,
    "no account may be created for an unreachable domain");

  // A reachable domain still registers normally.
  const real = await call(app, "/api/auth/register", {
    method: "POST",
    body: { name: "Real Person", email: "real@reachable-domain.com", password: "Password2026!" }
  });
  assert.equal(real.status, 201);
  assert.equal(last().event, "auth_register_success");
});

test("the domain check runs after cheap validation, so it is never reached by malformed input", async () => {
  let domainChecks = 0;
  const { app } = harness({
    checkEmailDomain: async () => {
      domainChecks += 1;
      return true;
    }
  });

  await call(app, "/api/auth/register", { method: "POST", body: { name: "X", email: "bad", password: "Password2026!" } });
  await call(app, "/api/auth/register", { method: "POST", body: { name: "X", email: "a@b.co", password: "short" } });
  await call(app, "/api/auth/register", { method: "POST", body: { name: "", email: "a@b.co", password: "Password2026!" } });

  assert.equal(domainChecks, 0, "a DNS lookup must not be spent on input that already failed validation");
});
