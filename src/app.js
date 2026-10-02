import { createHash } from "node:crypto";
import { getStore } from "./store.js";
import { createLoginThrottle, hasDeliverableDomain } from "./auth.js";
import { error, extractToken, json, readJson } from "./http.js";
import { routes } from "./routes/index.js";

/** Routes whose successful response is cached against an Idempotency-Key. */
const IDEMPOTENT_ROUTES = new Set(["/api/orders", "/api/payments"]);

const NOT_FOUND = {
  response: error("NOT_FOUND", "Route not found", 404),
  event: "route_not_found",
  component: "platform",
  severity: "WARNING",
  message: "Route not found"
};

/**
 * Resolves an Idempotency-Key before routing: a known key either replays its
 * stored response or, if the body differs, is refused. An unseen key is passed
 * to the handler so a success can be stored.
 */
async function resolveIdempotency({ store, method, path, idempotencyKey, requestBody }) {
  if (method !== "POST" || !IDEMPOTENT_ROUTES.has(path) || !idempotencyKey) return { replayable: null };

  const requestHash = createHash("sha256")
    .update(`${method} ${path} ${JSON.stringify(requestBody ?? null)}`)
    .digest("hex");
  const stored = await store.getIdempotentResponse(idempotencyKey);

  if (!stored) return { replayable: { key: idempotencyKey, requestHash } };

  if (stored.requestHash !== requestHash) {
    return {
      resolved: {
        response: error(
          "IDEMPOTENCY_KEY_REUSED",
          "This Idempotency-Key was already used for a different request body",
          422
        ),
        event: "idempotency_key_conflict",
        component: "orders",
        severity: "WARNING",
        message: "Idempotency key replayed with a different payload"
      }
    };
  }

  return {
    resolved: {
      response: json(stored.body, stored.status),
      event: "idempotent_replay",
      component: "orders",
      message: "Replayed a stored response for a repeated Idempotency-Key"
    }
  };
}

export function createStaySyncApp({
  store = getStore(),
  writeLog = () => {},
  environment = process.env.NODE_ENV ?? "development",
  loginThrottle = createLoginThrottle(),
  // Injectable so tests stay offline and deterministic rather than hitting real DNS.
  checkEmailDomain = hasDeliverableDomain
} = {}) {
  return {
    async fetch(request) {
      const startedAt = performance.now();
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;
      const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();

      const rawToken = extractToken(request);
      const currentUser = await store.getUserByToken(rawToken);
      const requestBody = method === "POST" || method === "PATCH" ? await readJson(request) : null;

      const { resolved, replayable } = await resolveIdempotency({
        store,
        method,
        path,
        idempotencyKey: request.headers.get("idempotency-key"),
        requestBody
      });

      let result = resolved;
      if (!result) {
        const route = routes.find((candidate) => candidate.method === method && candidate.match(path));
        const context = {
          request,
          url,
          path,
          requestBody,
          currentUser,
          isStaff: currentUser?.role === "staff",
          rawToken,
          scenario: request.headers.get("x-demo-scenario"),
          store,
          loginThrottle,
          checkEmailDomain,
          environment,
          replayable
        };
        result = route ? await route.handler(context) : NOT_FOUND;
      }

      if (result.replayable?.body) {
        const { key, requestHash, status, body } = result.replayable;
        await store.saveIdempotentResponse(key, requestHash, status, body);
      }

      writeLog({
        timestamp: new Date().toISOString(),
        severity: result.severity ?? "INFO",
        event: result.event,
        component: result.component,
        entryPoint: "http",
        requestId,
        route: path,
        statusCode: result.response.status,
        responseTimeMs: Math.round(performance.now() - startedAt),
        environment,
        message: result.message
      });

      return result.response;
    }
  };
}
