import { platformRoutes } from "./platform.js";
import { authRoutes } from "./auth.js";
import { catalogRoutes } from "./catalog.js";
import { orderRoutes } from "./orders.js";
import { paymentRoutes } from "./payments.js";

/**
 * Matched in order, first match wins. Order matters in one place: within the
 * order routes, the exact `/api/orders/my` path must come before the `:id`
 * pattern, which would otherwise read "my" as an order id.
 */
export const routes = [...platformRoutes, ...authRoutes, ...catalogRoutes, ...orderRoutes, ...paymentRoutes];
