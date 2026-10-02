import pg from "pg";
import { defaultSeedUsers, hashPassword, verifyPassword, generateToken, hashToken } from "./auth.js";

const { Pool } = pg;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const RESTOCKABLE = ["PENDING", "PAID"];

export const seedProducts = [
  { id: "prod-wool-overcoat", sku: "FW-COAT-01", name: "Falmouth Wool Overcoat", description: "Double-faced wool in a relaxed drop shoulder, with a full cupro lining.", category: "Outerwear", unitPriceCents: 42800, stockQuantity: 18, status: "ACTIVE" },
  { id: "prod-cotton-trench", sku: "FW-TRNC-01", name: "Harbour Cotton Trench", description: "Water-resistant cotton gabardine with a storm flap and belted waist.", category: "Outerwear", unitPriceCents: 36500, stockQuantity: 12, status: "ACTIVE" },
  { id: "prod-merino-crew", sku: "FW-KNIT-01", name: "Merino Crew Knit", description: "Fine-gauge extra-fine merino, fully fashioned at the shoulder.", category: "Knitwear", unitPriceCents: 13800, stockQuantity: 54, status: "ACTIVE" },
  { id: "prod-cardigan-rib", sku: "FW-KNIT-02", name: "Ribbed Lambswool Cardigan", description: "Chunky rib in British lambswool with corozo buttons.", category: "Knitwear", unitPriceCents: 16400, stockQuantity: 27, status: "ACTIVE" },
  { id: "prod-oxford-shirt", sku: "FW-SHRT-01", name: "Washed Oxford Shirt", description: "Garment-washed oxford cotton with a soft unlined collar.", category: "Shirting", unitPriceCents: 8900, stockQuantity: 86, status: "ACTIVE" },
  { id: "prod-silk-blouse", sku: "FW-SHRT-02", name: "Sandwashed Silk Blouse", description: "Sandwashed silk with a concealed placket and shell buttons.", category: "Shirting", unitPriceCents: 15200, stockQuantity: 31, status: "ACTIVE" },
  { id: "prod-wide-trouser", sku: "FW-TROU-01", name: "Wide Leg Wool Trouser", description: "High rise with a pressed crease, in a mid-weight wool twill.", category: "Trousers", unitPriceCents: 17600, stockQuantity: 40, status: "ACTIVE" },
  { id: "prod-selvedge-denim", sku: "FW-TROU-02", name: "Selvedge Straight Denim", description: "Fourteen ounce selvedge denim, raw and unsanforized.", category: "Trousers", unitPriceCents: 14200, stockQuantity: 62, status: "ACTIVE" },
  { id: "prod-linen-dress", sku: "FW-DRES-01", name: "Bias Cut Linen Dress", description: "Cut on the bias in washed European linen, with a tie back.", category: "Dresses", unitPriceCents: 19800, stockQuantity: 4, status: "ACTIVE" },
  { id: "prod-knit-midi", sku: "FW-DRES-02", name: "Knitted Midi Dress", description: "Column shape in a dense viscose rib that holds its line.", category: "Dresses", unitPriceCents: 17400, stockQuantity: 22, status: "ACTIVE" },
  { id: "prod-wool-scarf", sku: "FW-ACCS-01", name: "Lambswool Scarf", description: "Woven in a traditional mill, with hand-knotted fringing.", category: "Accessories", unitPriceCents: 6400, stockQuantity: 110, status: "ACTIVE" },
  { id: "prod-leather-tote", sku: "FW-ACCS-02", name: "Vegetable Tanned Tote", description: "Vegetable tanned leather that patinas with wear. Unlined.", category: "Accessories", unitPriceCents: 28500, stockQuantity: 16, status: "ACTIVE" },
  { id: "prod-chelsea-boot", sku: "FW-ACCS-03", name: "Chelsea Boot", description: "Goodyear welted on a leather sole, with elasticated gussets.", category: "Accessories", unitPriceCents: 31200, stockQuantity: 9, status: "ACTIVE" },
  { id: "prod-cashmere-wrap", sku: "FW-ACCS-04", name: "Cashmere Travel Wrap", description: "Two-ply Mongolian cashmere, generously sized. Currently withdrawn.", category: "Accessories", unitPriceCents: 24600, stockQuantity: 7, status: "OUT_OF_STOCK" }
];

const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role });
const matches = (product, q) =>
  !q || `${product.name} ${product.description} ${product.sku}`.toLowerCase().includes(q.toLowerCase());

/** Collapses a client item list into one row per product so a repeated productId cannot bypass the stock check. */
function normaliseItems(items) {
  if (!Array.isArray(items)) return null;
  const merged = new Map();
  for (const item of items) {
    const quantity = Number(item?.quantity);
    if (!item?.productId || !Number.isInteger(quantity) || quantity < 1 || quantity > 99) return null;
    merged.set(item.productId, (merged.get(item.productId) ?? 0) + quantity);
  }
  if (merged.size === 0 || merged.size > 20) return null;
  return [...merged.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([productId, quantity]) => ({ productId, quantity }));
}

/* ========================================================================== */
/* In-memory store — zero config, used by the test suite                      */
/* ========================================================================== */

export function createStaySyncStore() {
  const products = new Map(seedProducts.map((p) => [p.id, { ...p }]));
  const users = new Map(defaultSeedUsers.map((u) => [u.id, { ...u }]));
  const sessions = new Map();
  const orders = new Map();
  const orderItems = [];
  const payments = [];
  const outbox = [];
  const idempotency = new Map();

  const hydrate = (order) => ({
    ...order,
    items: orderItems
      .filter((i) => i.orderId === order.id)
      .map((i) => {
        const product = products.get(i.productId);
        return {
          id: i.id,
          orderId: i.orderId,
          productId: i.productId,
          quantity: i.quantity,
          unitPriceCents: i.unitPriceCents,
          product: { id: product.id, name: product.name, sku: product.sku, category: product.category }
        };
      })
  });

  return {
    async ping() {
      return { ok: true, engine: "in_memory" };
    },

    async registerUser({ email, password, name }) {
      const normalised = email.trim().toLowerCase();
      if ([...users.values()].some((u) => u.email.toLowerCase() === normalised)) return { kind: "email_exists" };
      const { hash, salt } = hashPassword(password);
      const user = { id: `user-${crypto.randomUUID().slice(0, 8)}`, email: normalised, name: name.trim(), role: "customer", hash, salt };
      users.set(user.id, user);
      const session = await this.createSession(user.id);
      return { kind: "created", user: publicUser(user), token: session.token };
    },

    async authenticateUser({ email, password }) {
      const wanted = String(email ?? "").trim().toLowerCase();
      const user = [...users.values()].find((u) => u.email.toLowerCase() === wanted);
      if (!user || !verifyPassword(password ?? "", user.salt, user.hash)) return null;
      return publicUser(user);
    },

    async createSession(userId) {
      const user = users.get(userId);
      if (!user) return null;
      const { rawToken, tokenHash } = generateToken();
      sessions.set(tokenHash, { userId, expiresAt: Date.now() + SESSION_TTL_MS });
      return { token: rawToken, user: publicUser(user) };
    },

    async getUserByToken(rawToken) {
      if (!rawToken) return null;
      const tokenHash = hashToken(rawToken);
      const session = sessions.get(tokenHash);
      if (!session) return null;
      if (session.expiresAt < Date.now()) {
        sessions.delete(tokenHash);
        return null;
      }
      const user = users.get(session.userId);
      return user ? publicUser(user) : null;
    },

    async deleteSession(rawToken) {
      if (rawToken) sessions.delete(hashToken(rawToken));
    },

    async listProducts({ q = null, category = null, includeInactive = false } = {}) {
      return [...products.values()]
        .filter(
          (p) =>
            (includeInactive || (p.status === "ACTIVE" && p.stockQuantity > 0)) &&
            (!category || p.category === category) &&
            matches(p, q)
        )
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((p) => ({ ...p }));
    },

    async listCategories() {
      return [...new Set([...products.values()].map((p) => p.category))].sort();
    },

    async getProduct(id) {
      const product = products.get(id);
      return product ? { ...product } : null;
    },

    async updateProductStock(id, { stockQuantity, status }) {
      const product = products.get(id);
      if (!product) return { kind: "not_found" };
      if (stockQuantity !== undefined && stockQuantity !== null) product.stockQuantity = stockQuantity;
      if (status !== undefined && status !== null) product.status = status;
      return { kind: "updated", product: { ...product } };
    },

    async createOrder({ userId, items }) {
      const normalised = normaliseItems(items);
      if (!normalised) return { kind: "invalid_items" };

      for (const line of normalised) {
        const product = products.get(line.productId);
        if (!product) return { kind: "product_not_found", productId: line.productId };
        if (product.status !== "ACTIVE") return { kind: "product_unavailable", productId: line.productId, name: product.name };
        if (product.stockQuantity < line.quantity) {
          return { kind: "insufficient_stock", productId: line.productId, name: product.name, available: product.stockQuantity };
        }
      }

      const order = { id: crypto.randomUUID(), userId, status: "PENDING", totalCents: 0, createdAt: new Date().toISOString() };
      for (const line of normalised) {
        const product = products.get(line.productId);
        product.stockQuantity -= line.quantity;
        order.totalCents += product.unitPriceCents * line.quantity;
        orderItems.push({
          id: crypto.randomUUID(),
          orderId: order.id,
          productId: line.productId,
          quantity: line.quantity,
          unitPriceCents: product.unitPriceCents
        });
      }
      orders.set(order.id, order);
      return { kind: "created", order: hydrate(order) };
    },

    async getOrder(id) {
      const order = orders.get(id);
      return order ? hydrate(order) : null;
    },

    async listOrders({ userId = null, role = "staff" } = {}) {
      return [...orders.values()]
        .filter((o) => role === "staff" || o.userId === userId)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .map(hydrate);
    },

    async payOrder(orderId, { userId = null, role = "customer" } = {}) {
      const order = orders.get(orderId);
      if (!order) return { kind: "not_found" };
      if (role !== "staff" && order.userId !== userId) return { kind: "forbidden" };
      if (order.status !== "PENDING") return { kind: "invalid_state", currentStatus: order.status };

      order.status = "PAID";
      const payment = {
        id: crypto.randomUUID(),
        orderId,
        status: "APPROVED",
        amountCents: order.totalCents,
        providerReference: `sim_${crypto.randomUUID().slice(0, 12)}`
      };
      payments.push(payment);
      const event = {
        id: crypto.randomUUID(),
        eventType: "order.confirmation.requested",
        aggregateId: orderId,
        payload: { orderId, status: "PAID", totalCents: order.totalCents },
        publishedAt: null,
        createdAt: new Date().toISOString()
      };
      outbox.push(event);
      return { kind: "paid", order: hydrate(order), payment, event };
    },

    async recordFailedPayment(orderId, amountCents) {
      payments.push({ id: crypto.randomUUID(), orderId, status: "FAILED", amountCents, providerReference: null });
    },

    async cancelOrder(orderId, { userId = null, role = "customer" } = {}) {
      const order = orders.get(orderId);
      if (!order) return { kind: "not_found" };
      if (role !== "staff" && order.userId !== userId) return { kind: "forbidden" };
      if (!RESTOCKABLE.includes(order.status)) return { kind: "invalid_state", currentStatus: order.status };

      order.status = "CANCELLED";
      for (const item of orderItems.filter((i) => i.orderId === orderId)) {
        const product = products.get(item.productId);
        if (product) product.stockQuantity += item.quantity;
      }
      outbox.push({
        id: crypto.randomUUID(),
        eventType: "order.cancelled",
        aggregateId: orderId,
        payload: { orderId, status: "CANCELLED" },
        publishedAt: null,
        createdAt: new Date().toISOString()
      });
      return { kind: "cancelled", order: hydrate(order) };
    },

    async fulfilOrder(orderId) {
      const order = orders.get(orderId);
      if (!order) return { kind: "not_found" };
      if (order.status !== "PAID") return { kind: "invalid_state", currentStatus: order.status };
      order.status = "FULFILLED";
      return { kind: "fulfilled", order: hydrate(order) };
    },

    async getOutboxEvents({ unpublishedOnly = true } = {}) {
      return (unpublishedOnly ? outbox.filter((e) => !e.publishedAt) : outbox).map((e) => ({ ...e }));
    },

    async markOutboxPublished(eventId) {
      const event = outbox.find((e) => e.id === eventId);
      if (event) event.publishedAt = new Date().toISOString();
    },

    async getIdempotentResponse(key) {
      return idempotency.get(key) ?? null;
    },

    async saveIdempotentResponse(key, requestHash, status, body) {
      if (!idempotency.has(key)) idempotency.set(key, { requestHash, status, body });
    }
  };
}

/* ========================================================================== */
/* PostgreSQL / Cloud SQL — direct driver on port 5432                        */
/* ========================================================================== */

export function createPostgresStore(connectionString) {
  const pool = new Pool({ connectionString, max: 8, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });

  const PRODUCT_COLS = `id, sku, name, description, category,
    unit_price_cents AS "unitPriceCents", stock_quantity AS "stockQuantity", status`;
  const ORDER_COLS = `id, user_id AS "userId", status, total_cents AS "totalCents", created_at AS "createdAt"`;

  async function hydrateOrders(orderRows) {
    if (orderRows.length === 0) return [];
    const { rows } = await pool.query(
      `SELECT oi.id, oi.order_id AS "orderId", oi.product_id AS "productId", oi.quantity,
              oi.unit_price_cents AS "unitPriceCents",
              p.name AS "productName", p.sku AS "productSku", p.category AS "productCategory"
         FROM order_items oi JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = ANY($1::varchar[])
        ORDER BY p.name ASC`,
      [orderRows.map((r) => r.id)]
    );
    const grouped = new Map(orderRows.map((r) => [r.id, []]));
    for (const row of rows) {
      grouped.get(row.orderId)?.push({
        id: row.id,
        orderId: row.orderId,
        productId: row.productId,
        quantity: row.quantity,
        unitPriceCents: row.unitPriceCents,
        product: { id: row.productId, name: row.productName, sku: row.productSku, category: row.productCategory }
      });
    }
    return orderRows.map((order) => ({ ...order, items: grouped.get(order.id) ?? [] }));
  }

  const store = {
    async ping() {
      await pool.query("SELECT 1");
      return { ok: true, engine: "postgresql" };
    },

    async registerUser({ email, password, name }) {
      const { hash, salt } = hashPassword(password);
      const id = `user-${crypto.randomUUID().slice(0, 8)}`;
      const normalised = email.trim().toLowerCase();
      try {
        await pool.query(
          "INSERT INTO users (id, email, password_hash, salt, role, full_name) VALUES ($1, $2, $3, $4, 'customer', $5)",
          [id, normalised, hash, salt, name.trim()]
        );
      } catch (err) {
        if (err.code === "23505") return { kind: "email_exists" };
        throw err;
      }
      const session = await this.createSession(id);
      return { kind: "created", user: { id, email: normalised, name: name.trim(), role: "customer" }, token: session.token };
    },

    async authenticateUser({ email, password }) {
      const { rows } = await pool.query(
        `SELECT id, email, full_name AS name, role, password_hash, salt FROM users WHERE LOWER(email) = LOWER($1)`,
        [String(email ?? "").trim()]
      );
      const user = rows[0];
      if (!user || !verifyPassword(password ?? "", user.salt, user.password_hash)) return null;
      return publicUser(user);
    },

    async createSession(userId) {
      const { rawToken, tokenHash } = generateToken();
      await pool.query("INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)", [
        crypto.randomUUID(),
        userId,
        tokenHash,
        new Date(Date.now() + SESSION_TTL_MS)
      ]);
      const { rows } = await pool.query(`SELECT id, email, full_name AS name, role FROM users WHERE id = $1`, [userId]);
      return { token: rawToken, user: rows[0] ?? null };
    },

    async getUserByToken(rawToken) {
      if (!rawToken) return null;
      const { rows } = await pool.query(
        `SELECT u.id, u.email, u.full_name AS name, u.role
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = $1 AND s.expires_at > CURRENT_TIMESTAMP`,
        [hashToken(rawToken)]
      );
      return rows[0] ?? null;
    },

    async deleteSession(rawToken) {
      if (rawToken) await pool.query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(rawToken)]);
    },

    async listProducts({ q = null, category = null, includeInactive = false } = {}) {
      const { rows } = await pool.query(
        `SELECT ${PRODUCT_COLS} FROM products
          WHERE ($1::boolean OR (status = 'ACTIVE' AND stock_quantity > 0))
            AND ($2::varchar IS NULL OR category = $2)
            AND ($3::varchar IS NULL OR name ILIKE '%' || $3 || '%' OR description ILIKE '%' || $3 || '%' OR sku ILIKE '%' || $3 || '%')
          ORDER BY name ASC`,
        [includeInactive, category, q]
      );
      return rows;
    },

    async listCategories() {
      const { rows } = await pool.query("SELECT DISTINCT category FROM products ORDER BY category ASC");
      return rows.map((r) => r.category);
    },

    async getProduct(id) {
      const { rows } = await pool.query(`SELECT ${PRODUCT_COLS} FROM products WHERE id = $1`, [id]);
      return rows[0] ?? null;
    },

    async updateProductStock(id, { stockQuantity, status }) {
      const { rows } = await pool.query(
        `UPDATE products
            SET stock_quantity = COALESCE($2, stock_quantity), status = COALESCE($3, status)
          WHERE id = $1
        RETURNING ${PRODUCT_COLS}`,
        [id, stockQuantity ?? null, status ?? null]
      );
      return rows.length ? { kind: "updated", product: rows[0] } : { kind: "not_found" };
    },

    // The transactional operations live in SQL functions so the driver and the
    // HTTP transport share one implementation of the locking rules.
    async createOrder({ userId, items }) {
      const { rows } = await pool.query("SELECT create_order($1, $2::jsonb) AS result", [userId, JSON.stringify(items ?? [])]);
      const result = rows[0].result;
      if (result.kind !== "created") return result;
      return { kind: "created", order: await store.getOrder(result.orderId) };
    },

    async payOrder(orderId, { userId = null, role = "customer" } = {}) {
      const { rows } = await pool.query("SELECT pay_order($1, $2, $3) AS result", [orderId, userId, role]);
      const result = rows[0].result;
      if (result.kind !== "paid") return result;
      return {
        kind: "paid",
        order: await store.getOrder(orderId),
        payment: {
          id: result.paymentId,
          orderId,
          status: "APPROVED",
          amountCents: result.amountCents,
          providerReference: result.providerReference
        }
      };
    },

    async cancelOrder(orderId, { userId = null, role = "customer" } = {}) {
      const { rows } = await pool.query("SELECT cancel_order($1, $2, $3) AS result", [orderId, userId, role]);
      const result = rows[0].result;
      if (result.kind !== "cancelled") return result;
      return { kind: "cancelled", order: await store.getOrder(orderId) };
    },

    async fulfilOrder(orderId) {
      const { rows } = await pool.query("SELECT fulfil_order($1) AS result", [orderId]);
      const result = rows[0].result;
      if (result.kind !== "fulfilled") return result;
      return { kind: "fulfilled", order: await store.getOrder(orderId) };
    },

    async recordFailedPayment(orderId, amountCents) {
      await pool.query(
        "INSERT INTO payment_attempts (id, order_id, status, amount_cents) VALUES ($1, $2, 'FAILED', $3)",
        [crypto.randomUUID(), orderId, amountCents]
      );
    },

    async getOrder(id) {
      const { rows } = await pool.query(`SELECT ${ORDER_COLS} FROM orders WHERE id = $1`, [id]);
      if (!rows.length) return null;
      const [order] = await hydrateOrders(rows);
      return order;
    },

    async listOrders({ userId = null, role = "staff" } = {}) {
      const { rows } = await pool.query(
        `SELECT ${ORDER_COLS} FROM orders WHERE ($1::boolean OR user_id = $2) ORDER BY created_at DESC`,
        [role === "staff", userId]
      );
      return hydrateOrders(rows);
    },

    async getOutboxEvents({ unpublishedOnly = true } = {}) {
      const { rows } = await pool.query(
        `SELECT id, event_type AS "eventType", aggregate_id AS "aggregateId", payload,
                published_at AS "publishedAt", created_at AS "createdAt"
           FROM outbox_events
          WHERE ($1::boolean = false OR published_at IS NULL)
          ORDER BY created_at ASC`,
        [unpublishedOnly]
      );
      return rows;
    },

    async markOutboxPublished(eventId) {
      await pool.query("UPDATE outbox_events SET published_at = CURRENT_TIMESTAMP WHERE id = $1", [eventId]);
    },

    async getIdempotentResponse(key) {
      const { rows } = await pool.query(
        `SELECT request_hash AS "requestHash", response_status AS status, response_body AS body
           FROM idempotency_records WHERE key = $1`,
        [key]
      );
      return rows[0] ?? null;
    },

    async saveIdempotentResponse(key, requestHash, status, body) {
      await pool.query(
        `INSERT INTO idempotency_records (key, request_hash, response_status, response_body)
         VALUES ($1, $2, $3, $4) ON CONFLICT (key) DO NOTHING`,
        [key, requestHash, status, JSON.stringify(body)]
      );
    },

    async close() {
      await pool.end();
    }
  };

  return store;
}

/* ========================================================================== */
/* Supabase PostgREST — same database over HTTPS on port 443                  */
/* ========================================================================== */

/**
 * Speaks to Postgres through Supabase's REST layer, which matters where
 * outbound 5432 is blocked. The transactional operations are delegated to the
 * same SQL functions the driver calls, so locking behaviour is identical;
 * PostgREST could not otherwise hold a transaction across requests.
 *
 * `key` must be the secret (service_role) key: it is used server-side only and
 * bypasses RLS, which is enabled with no policies so the publishable key cannot
 * reach these tables.
 */
export function createSupabaseRestStore({ url, key }) {
  const base = `${url.replace(/\/$/, "")}/rest/v1`;
  const headers = {
    apikey: key,
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
    accept: "application/json"
  };

  const PRODUCT_SELECT =
    "id,sku,name,description,category,unitPriceCents:unit_price_cents,stockQuantity:stock_quantity,status";
  const ORDER_SELECT =
    "id,userId:user_id,status,totalCents:total_cents,createdAt:created_at," +
    "items:order_items(id,orderId:order_id,productId:product_id,quantity,unitPriceCents:unit_price_cents," +
    "product:products(id,name,sku,category))";

  async function send(path, { method = "GET", body, prefer } = {}) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: prefer ? { ...headers, prefer } : headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`PostgREST ${method} ${path} failed: ${response.status} ${text.slice(0, 200)}`);
      error.status = response.status;
      try {
        error.pgCode = JSON.parse(text).code;
      } catch {
        /* non-JSON error body */
      }
      throw error;
    }
    return text ? JSON.parse(text) : null;
  }

  const rpc = (name, args) => send(`/rpc/${name}`, { method: "POST", body: args });
  const first = (rows) => (Array.isArray(rows) ? (rows[0] ?? null) : rows);
  const enc = encodeURIComponent;

  const store = {
    async ping() {
      await send(`/products?select=id&limit=1`);
      return { ok: true, engine: "supabase_rest" };
    },

    async registerUser({ email, password, name }) {
      const { hash, salt } = hashPassword(password);
      const id = `user-${crypto.randomUUID().slice(0, 8)}`;
      const normalised = email.trim().toLowerCase();
      try {
        await send("/users", {
          method: "POST",
          body: { id, email: normalised, password_hash: hash, salt, role: "customer", full_name: name.trim() }
        });
      } catch (err) {
        if (err.pgCode === "23505") return { kind: "email_exists" };
        throw err;
      }
      const session = await store.createSession(id);
      return { kind: "created", user: { id, email: normalised, name: name.trim(), role: "customer" }, token: session.token };
    },

    async authenticateUser({ email, password }) {
      const wanted = String(email ?? "").trim().toLowerCase();
      const rows = await send(
        `/users?select=id,email,name:full_name,role,password_hash,salt&email=eq.${enc(wanted)}&limit=1`
      );
      const user = first(rows);
      if (!user || !verifyPassword(password ?? "", user.salt, user.password_hash)) return null;
      return publicUser(user);
    },

    async createSession(userId) {
      const { rawToken, tokenHash } = generateToken();
      await send("/sessions", {
        method: "POST",
        body: {
          id: crypto.randomUUID(),
          user_id: userId,
          token_hash: tokenHash,
          expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString()
        }
      });
      const user = first(await send(`/users?select=id,email,name:full_name,role&id=eq.${enc(userId)}&limit=1`));
      return { token: rawToken, user };
    },

    async getUserByToken(rawToken) {
      if (!rawToken) return null;
      const rows = await send(
        `/sessions?select=expires_at,user:users(id,email,name:full_name,role)` +
          `&token_hash=eq.${enc(hashToken(rawToken))}&expires_at=gt.${enc(new Date().toISOString())}&limit=1`
      );
      return first(rows)?.user ?? null;
    },

    async deleteSession(rawToken) {
      if (rawToken) await send(`/sessions?token_hash=eq.${enc(hashToken(rawToken))}`, { method: "DELETE" });
    },

    async listProducts({ q = null, category = null, includeInactive = false } = {}) {
      let path = `/products?select=${PRODUCT_SELECT}&order=name.asc`;
      if (!includeInactive) path += "&status=eq.ACTIVE&stock_quantity=gt.0";
      if (category) path += `&category=eq.${enc(category)}`;
      // PostgREST `or=` needs the wildcards inline; * is its single-char-run wildcard for ilike.
      if (q) {
        const term = `*${q.replace(/[(),*]/g, "")}*`;
        path += `&or=(name.ilike.${enc(term)},description.ilike.${enc(term)},sku.ilike.${enc(term)})`;
      }
      return (await send(path)) ?? [];
    },

    async listCategories() {
      const rows = (await send("/products?select=category&order=category.asc")) ?? [];
      return [...new Set(rows.map((r) => r.category))];
    },

    async getProduct(id) {
      return first(await send(`/products?select=${PRODUCT_SELECT}&id=eq.${enc(id)}&limit=1`));
    },

    async updateProductStock(id, { stockQuantity, status }) {
      const patch = {};
      if (stockQuantity !== undefined && stockQuantity !== null) patch.stock_quantity = stockQuantity;
      if (status !== undefined && status !== null) patch.status = status;

      const rows = await send(`/products?id=eq.${enc(id)}&select=${PRODUCT_SELECT}`, {
        method: "PATCH",
        body: patch,
        prefer: "return=representation"
      });
      const product = first(rows);
      return product ? { kind: "updated", product } : { kind: "not_found" };
    },

    async createOrder({ userId, items }) {
      const result = await rpc("create_order", { p_user_id: userId, p_items: items ?? [] });
      if (result.kind !== "created") return result;
      return { kind: "created", order: await store.getOrder(result.orderId) };
    },

    async payOrder(orderId, { userId = null, role = "customer" } = {}) {
      const result = await rpc("pay_order", { p_order_id: orderId, p_user_id: userId, p_role: role });
      if (result.kind !== "paid") return result;
      return {
        kind: "paid",
        order: await store.getOrder(orderId),
        payment: {
          id: result.paymentId,
          orderId,
          status: "APPROVED",
          amountCents: result.amountCents,
          providerReference: result.providerReference
        }
      };
    },

    async cancelOrder(orderId, { userId = null, role = "customer" } = {}) {
      const result = await rpc("cancel_order", { p_order_id: orderId, p_user_id: userId, p_role: role });
      if (result.kind !== "cancelled") return result;
      return { kind: "cancelled", order: await store.getOrder(orderId) };
    },

    async fulfilOrder(orderId) {
      const result = await rpc("fulfil_order", { p_order_id: orderId });
      if (result.kind !== "fulfilled") return result;
      return { kind: "fulfilled", order: await store.getOrder(orderId) };
    },

    async recordFailedPayment(orderId, amountCents) {
      await send("/payment_attempts", {
        method: "POST",
        body: { id: crypto.randomUUID(), order_id: orderId, status: "FAILED", amount_cents: amountCents }
      });
    },

    async getOrder(id) {
      const order = first(await send(`/orders?select=${ORDER_SELECT}&id=eq.${enc(id)}&limit=1`));
      if (order) order.items?.sort((a, b) => a.product.name.localeCompare(b.product.name));
      return order;
    },

    async listOrders({ userId = null, role = "staff" } = {}) {
      let path = `/orders?select=${ORDER_SELECT}&order=created_at.desc`;
      if (role !== "staff") path += `&user_id=eq.${enc(userId)}`;
      const orders = (await send(path)) ?? [];
      for (const order of orders) order.items?.sort((a, b) => a.product.name.localeCompare(b.product.name));
      return orders;
    },

    async getOutboxEvents({ unpublishedOnly = true } = {}) {
      let path =
        "/outbox_events?select=id,eventType:event_type,aggregateId:aggregate_id,payload," +
        "publishedAt:published_at,createdAt:created_at&order=created_at.asc";
      if (unpublishedOnly) path += "&published_at=is.null";
      return (await send(path)) ?? [];
    },

    async markOutboxPublished(eventId) {
      await send(`/outbox_events?id=eq.${enc(eventId)}`, {
        method: "PATCH",
        body: { published_at: new Date().toISOString() }
      });
    },

    async getIdempotentResponse(key) {
      const row = first(
        await send(
          `/idempotency_records?select=requestHash:request_hash,status:response_status,body:response_body&key=eq.${enc(key)}&limit=1`
        )
      );
      return row ?? null;
    },

    async saveIdempotentResponse(key, requestHash, status, body) {
      await send("/idempotency_records", {
        method: "POST",
        body: { key, request_hash: requestHash, response_status: status, response_body: body },
        prefer: "resolution=ignore-duplicates"
      });
    }
  };

  return store;
}

/* ========================================================================== */

/**
 * Transport precedence: Supabase over HTTPS, then the Postgres driver, then
 * in-memory. HTTPS wins because it works on networks that block 5432.
 */
export function getStore({
  supabaseUrl = process.env.SUPABASE_URL,
  supabaseKey = process.env.SUPABASE_SECRET_KEY,
  connectionString = process.env.DATABASE_URL
} = {}) {
  if (supabaseUrl && supabaseKey) return createSupabaseRestStore({ url: supabaseUrl, key: supabaseKey });
  if (connectionString) return createPostgresStore(connectionString);
  return createStaySyncStore();
}
