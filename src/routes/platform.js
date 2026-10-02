import { json } from "../http.js";

export const platformRoutes = [
  {
    method: "GET",
    match: (path) => path === "/health",
    async handler({ store, environment }) {
      try {
        const probe = await store.ping();
        return {
          response: json({ status: "healthy", application: "staysync-order-api", storage: probe.engine, environment }),
          event: "health_checked",
          component: "platform",
          message: "Health check completed"
        };
      } catch (err) {
        return {
          response: json({ status: "degraded", application: "staysync-order-api", dependency: "database" }, 503),
          event: "health_degraded",
          component: "platform",
          severity: "ERROR",
          message: `Health check found a degraded dependency: ${err.code ?? "database unreachable"}`
        };
      }
    }
  }
];
