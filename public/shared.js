/* StaySync shared frontend module: API access, session, cart, and page chrome. */

const CART_KEY = "staysync_cart";

/** Escapes text before it reaches innerHTML. Product copy comes from the database, so it is never trusted. */
export const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const money = (cents) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

export const titleCase = (value) => String(value ?? "").replace(/_/g, " ").toLowerCase();

/** Mirrors the server's check so the form can fail fast; the server stays the authority. */
export const isValidEmail = (email) =>
  typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());

/** Product plates are stored per product id. A missing file degrades to the empty frame. */
export const productImage = (productId) => `/img/${encodeURIComponent(productId)}.svg`;

export const thumb = (product, size = 64) =>
  `<img class="thumb" src="${productImage(product.id)}" alt="" width="${size}" height="${size}" loading="lazy">`;

/** Session cookie is HttpOnly and sent automatically; no token is kept in browser storage. */
export async function api(path, options = {}) {
  const init = { credentials: "same-origin", ...options };
  if (init.body && !init.headers?.["content-type"]) {
    init.headers = { "content-type": "application/json", ...(init.headers ?? {}) };
  }
  const response = await fetch(path, init);
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { response, body, ok: response.ok, message: body?.error?.message ?? null };
}

let sessionCache;

export async function loadSession({ force = false } = {}) {
  if (!force && sessionCache !== undefined) return sessionCache;
  const { ok, body } = await api("/api/auth/me");
  sessionCache = ok ? body.user : null;
  return sessionCache;
}

export async function signOut() {
  await api("/api/auth/logout", { method: "POST" });
  sessionCache = null;
  clearCart();
  location.href = "/signin";
}

/** Sends the visitor to sign in, remembering where they were headed. */
export function requireSession(user) {
  if (user) return true;
  location.href = `/signin?next=${encodeURIComponent(location.pathname)}`;
  return false;
}

/* ---------- Cart (client-side only; orders are priced server-side) ---------- */

export function readCart() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CART_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((i) => i?.productId && Number.isInteger(i.quantity) && i.quantity > 0)
      : [];
  } catch {
    return [];
  }
}

function writeCart(items) {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(items));
  } catch {
    /* private mode or blocked storage: the cart simply does not persist */
  }
  document.querySelectorAll("[data-cart-count]").forEach((el) => {
    const total = items.reduce((sum, i) => sum + i.quantity, 0);
    el.textContent = total;
    el.hidden = total === 0;
  });
}

export function addToCart(productId, quantity = 1) {
  const items = readCart();
  const existing = items.find((i) => i.productId === productId);
  if (existing) existing.quantity = Math.min(99, existing.quantity + quantity);
  else items.push({ productId, quantity });
  writeCart(items);
  return items;
}

export function setCartQuantity(productId, quantity) {
  const items = readCart().flatMap((i) => {
    if (i.productId !== productId) return [i];
    const next = Math.max(0, Math.min(99, quantity));
    return next === 0 ? [] : [{ ...i, quantity: next }];
  });
  writeCart(items);
  return items;
}

export function removeFromCart(productId) {
  const items = readCart().filter((i) => i.productId !== productId);
  writeCart(items);
  return items;
}

export function clearCart() {
  writeCart([]);
}

/* ---------- Chrome ---------- */

const NAV = [
  { href: "/", key: "index", label: "Shop" },
  { href: "/cart", key: "cart", label: "Cart", cart: true },
  { href: "/orders", key: "orders", label: "Orders" },
  { href: "/operations", key: "operations", label: "Fulfilment", staffOnly: true },
  { href: "/scenarios", key: "scenarios", label: "Scenario lab" }
];

export function toast(message, tone = "info") {
  const el = document.querySelector("#toast");
  if (!el) return;
  el.textContent = message;
  el.dataset.tone = tone;
  el.dataset.visible = "true";
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    el.dataset.visible = "false";
  }, 3600);
}

export function notice(selector, message, tone = "info") {
  const el = document.querySelector(selector);
  if (!el) return;
  el.textContent = message ?? "";
  el.dataset.tone = tone;
}

export const badge = (state) => `<span class="badge" data-state="${esc(state)}">${esc(titleCase(state))}</span>`;

/**
 * Renders the shared header, footer and toast slot, then returns the session.
 * One source of truth for navigation across every page.
 */
export async function mountChrome(activeKey) {
  const user = await loadSession();
  const cartTotal = readCart().reduce((sum, i) => sum + i.quantity, 0);

  const links = NAV.filter((item) => !item.staffOnly || user?.role === "staff")
    .map((item) => {
      const current = item.key === activeKey ? ' aria-current="page"' : "";
      const counter = item.cart
        ? `<span class="cart-count" data-cart-count${cartTotal === 0 ? " hidden" : ""}>${cartTotal}</span>`
        : "";
      return `<a href="${item.href}"${current}>${esc(item.label)}${counter}</a>`;
    })
    .join("");

  const session = user
    ? `<span class="user-badge" data-role="${esc(user.role)}">${esc(user.name)} · ${esc(user.role)}</span>
       <button class="btn-quiet btn-small" id="chrome-signout">Sign out</button>`
    : `<a class="btn btn-quiet btn-small" href="/signin">Sign in</a>`;

  document.body.insertAdjacentHTML(
    "afterbegin",
    `<header class="site-header">
       <a class="wordmark" href="/">STAY<span>SYNC</span></a>
       <nav class="site-nav" aria-label="Primary">${links}</nav>
       <div class="header-session">${session}</div>
     </header>`
  );

  document.body.insertAdjacentHTML(
    "beforeend",
    `<footer class="site-footer">
       <span class="meta">StaySync / Order management demo</span>
       <span class="meta">Structured telemetry for GCP Cloud Logging &amp; Monitoring</span>
     </footer>
     <div id="toast" role="status" aria-live="polite"></div>`
  );

  document.querySelector("#chrome-signout")?.addEventListener("click", signOut);
  return user;
}
