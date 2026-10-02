/**
 * Drives named failure scenarios against a running StaySync instance so the
 * matching log events appear in Cloud Logging. Point it at the deployed URL:
 *   STAYSYNC_URL=https://staysync-api-xxxx.run.app npm run scenario -- stock-conflict
 */
const baseUrl = (process.env.STAYSYNC_URL ?? "http://localhost:8081").replace(/\/$/, "");
const scenario = process.argv[2] ?? "traffic-burst";

const CREDENTIALS = {
  email: process.env.STAYSYNC_EMAIL ?? "customer@staysync.internal",
  password: process.env.STAYSYNC_PASSWORD ?? "ShopPass2026!"
};

async function call(path, { method = "GET", token, scenario: demo, key, body } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  if (demo) headers["x-demo-scenario"] = demo;
  if (key) headers["idempotency-key"] = key;

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, body: payload };
}

async function signIn() {
  const { status, body } = await call("/api/auth/login", { method: "POST", body: CREDENTIALS });
  if (status !== 200) throw new Error(`Sign-in failed with HTTP ${status}. Set STAYSYNC_EMAIL / STAYSYNC_PASSWORD.`);
  return body.token;
}

async function pendingOrder(token) {
  const { body } = await call("/api/products");
  const product = body?.products?.find((p) => p.stockQuantity > 0);
  if (!product) throw new Error("No product with stock is available.");
  const { status, body: created } = await call("/api/orders", {
    method: "POST",
    token,
    key: crypto.randomUUID(),
    body: { items: [{ productId: product.id, quantity: 1 }] }
  });
  if (status !== 201) throw new Error(`Could not create an order: HTTP ${status}`);
  return created.order;
}

const scenarios = {
  async "traffic-burst"() {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => call("/api/products", { scenario: "traffic_burst" }))
    );
    const ok = results.filter((r) => r.status === 200).length;
    console.log(`${ok}/20 catalogue requests returned 200 -> product_catalog_listed x${ok} (INFO)`);
  },

  async "database-timeout"() {
    const { status, body } = await call("/api/products", { scenario: "database_timeout" });
    console.log(`HTTP ${status} ${body?.error?.code} -> database_timeout (ERROR)`);
  },

  async "auth-failure"() {
    const { status, body } = await call("/api/auth/login", {
      method: "POST",
      body: { email: CREDENTIALS.email, password: "WrongPassword123!" }
    });
    console.log(`HTTP ${status} ${body?.error?.code} -> auth_login_failed (WARNING)`);
  },

  async "unauthorized-desk"() {
    const { status, body } = await call("/api/orders", { scenario: "unauthorized_desk" });
    console.log(`HTTP ${status} ${body?.error?.code} -> auth_unauthorized_access (WARNING)`);
  },

  async "payment-failure"() {
    const token = await signIn();
    const order = await pendingOrder(token);
    const { status, body } = await call("/api/payments", {
      method: "POST",
      token,
      scenario: "payment_failure",
      body: { orderId: order.id }
    });
    console.log(`Order ${order.id.slice(0, 8)} -> HTTP ${status} ${body?.error?.code} -> payment_provider_rejected (ERROR)`);
  },

  async "slow-payment"() {
    const token = await signIn();
    const order = await pendingOrder(token);
    const startedAt = Date.now();
    const { status } = await call("/api/payments", {
      method: "POST",
      token,
      scenario: "slow_payment",
      body: { orderId: order.id }
    });
    console.log(`HTTP ${status} in ${Date.now() - startedAt}ms -> payment_slow (WARNING)`);
  },

  async "stock-conflict"() {
    const token = await signIn();
    const { body } = await call("/api/products");
    const target = body.products.filter((p) => p.stockQuantity > 0).sort((a, b) => a.stockQuantity - b.stockQuantity)[0];
    if (!target) throw new Error("No product with stock is available.");

    const attempts = target.stockQuantity + 3;
    const results = await Promise.all(
      Array.from({ length: attempts }, () =>
        call("/api/orders", {
          method: "POST",
          token,
          key: crypto.randomUUID(),
          body: { items: [{ productId: target.id, quantity: 1 }] }
        })
      )
    );
    const created = results.filter((r) => r.status === 201).length;
    const rejected = results.filter((r) => r.status === 409).length;
    console.log(
      `${target.name}: stock ${target.stockQuantity}, ${attempts} concurrent orders -> ` +
        `${created} created, ${rejected} rejected -> order_stock_conflict (WARNING)`
    );
    console.log(created <= target.stockQuantity ? "Stock was never oversold." : "FAIL: stock was oversold.");
  },


  async "brute-force"() {
    // A throwaway address, so no real account is locked out.
    const target = `bruteforce.${Date.now()}@example.com`;
    let rejected = 0;
    let locked = 0;
    for (let i = 0; i < 8; i += 1) {
      const { status } = await call("/api/auth/login", {
        method: "POST",
        body: { email: target, password: `Guess${i}!` }
      });
      if (status === 401) rejected += 1;
      if (status === 429) locked += 1;
    }
    console.log(`${rejected} rejected with 401, then ${locked} refused with 429 -> auth_rate_limited (WARNING)`);
    console.log(locked > 0 ? "Lockout engaged." : "FAIL: no lockout engaged.");
  },

  async "key-conflict"() {
    const token = await signIn();
    const { body } = await call("/api/products");
    const [a, b] = body.products.filter((p) => p.stockQuantity > 1);
    if (!a || !b) throw new Error("Need two products with spare stock.");

    const key = crypto.randomUUID();
    const first = await call("/api/orders", { method: "POST", token, key, body: { items: [{ productId: a.id, quantity: 1 }] } });
    const second = await call("/api/orders", { method: "POST", token, key, body: { items: [{ productId: b.id, quantity: 1 }] } });
    console.log(`First HTTP ${first.status}, second HTTP ${second.status} -> idempotency_key_conflict (WARNING)`);
    console.log(second.status === 422 ? "Key reuse refused." : "FAIL: reuse was not refused.");
  },

  async "validation-storm"() {
    const token = await signIn();
    const payloads = [
      { items: [] },
      { items: [{ productId: "prod-merino-crew", quantity: 0 }] },
      { items: [{ quantity: 3 }] },
      { items: [{ productId: "prod-merino-crew", quantity: 500 }] },
      { items: "not-a-list" },
      {}
    ];
    const results = await Promise.all(payloads.map((body) => call("/api/orders", { method: "POST", token, body })));
    const counts = results.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
    console.log(`${payloads.length} malformed orders -> ${JSON.stringify(counts)} -> order_invalid (WARNING)`);
    console.log(results.every((r) => r.status < 500) ? "No malformed payload reached a 5xx." : "FAIL: a 5xx escaped.");
  },

  async "route-scan"() {
    const paths = ["/api/admin", "/api/users", "/.env", "/api/orders/nonexistent-probe", "/wp-login.php"];
    const results = await Promise.all(paths.map((p) => call(p)));
    const notFound = results.filter((r) => r.status === 404).length;
    console.log(`${notFound}/${paths.length} unknown paths returned 404 -> route_not_found (WARNING)`);
  },

  async "order-churn"() {
    const token = await signIn();
    const { body } = await call("/api/products");
    const product = body.products.find((p) => p.stockQuantity > 5);
    if (!product) throw new Error("Need a product with spare stock.");
    const before = product.stockQuantity;

    for (let i = 0; i < 5; i += 1) {
      const created = await call("/api/orders", {
        method: "POST",
        token,
        key: crypto.randomUUID(),
        body: { items: [{ productId: product.id, quantity: 1 }] }
      });
      if (created.status === 201) {
        await call(`/api/orders/${created.body.order.id}/cancel`, { method: "POST", token });
      }
    }

    const after = (await call("/api/products")).body.products.find((p) => p.id === product.id)?.stockQuantity;
    console.log(`5 orders placed and cancelled; stock ${before} -> ${after}; 10 outbox events staged`);
    console.log(before === after ? "Stock returned exactly." : "FAIL: stock drifted.");
  },

  async "mixed-load"() {
    const token = await signIn();
    const started = Date.now();
    const work = [
      ...Array.from({ length: 8 }, () => call("/api/products")),
      call("/api/products?q=wool"),
      call("/api/products?category=Knitwear"),
      call("/api/categories"),
      call("/api/orders/my", { token }),
      call("/health"),
      call("/api/auth/login", { method: "POST", body: { email: CREDENTIALS.email, password: "definitely-wrong" } }),
      call("/api/products", { scenario: "database_timeout" })
    ];
    const results = await Promise.all(work);
    const counts = results.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
    console.log(`${results.length} blended requests in ${Date.now() - started}ms -> ${JSON.stringify(counts)}`);
    console.log("A mixed INFO/WARNING/ERROR baseline for anomaly detection.");
  },

  async "idempotent-replay"() {
    const token = await signIn();
    const { body } = await call("/api/products");
    const product = body.products.find((p) => p.stockQuantity > 1);
    const key = crypto.randomUUID();
    const payload = { items: [{ productId: product.id, quantity: 1 }] };

    const first = await call("/api/orders", { method: "POST", token, key, body: payload });
    const second = await call("/api/orders", { method: "POST", token, key, body: payload });
    console.log(`First HTTP ${first.status}, second HTTP ${second.status} -> idempotent_replay (INFO)`);
    console.log(
      first.body?.order?.id === second.body?.order?.id
        ? "Same order returned twice: no duplicate was created."
        : "FAIL: two different orders were created."
    );
  }
};

const run = scenarios[scenario];
if (!run) {
  console.error(`Unknown scenario "${scenario}".\nAvailable: ${Object.keys(scenarios).join(" | ")}`);
  process.exit(1);
}

console.log(`Running "${scenario}" against ${baseUrl}`);
await run();
