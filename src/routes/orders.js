import { json, error, segment } from "../http.js";

const ORDER_BY_ID = /^\/api\/orders\/[^/]+$/;
const ORDER_CANCEL = /^\/api\/orders\/[^/]+\/cancel$/;
const ORDER_FULFIL = /^\/api\/orders\/[^/]+\/fulfil$/;

const signInRequired = (component, message, detail) => ({
  response: error("UNAUTHORIZED", message, 401),
  event: "auth_unauthenticated",
  component,
  severity: "WARNING",
  message: detail
});

const orderNotFound = (component, detail) => ({
  response: error("ORDER_NOT_FOUND", "The order does not exist", 404),
  event: "order_not_found",
  component,
  severity: "WARNING",
  message: detail
});

export const orderRoutes = [
  {
    method: "POST",
    match: (path) => path === "/api/orders",
    async handler({ store, currentUser, requestBody, replayable }) {
      const component = "orders";
      if (!currentUser) return signInRequired(component, "Sign in to place an order", "Order attempted without a session");

      const result = await store.createOrder({ userId: currentUser.id, items: requestBody?.items });

      switch (result.kind) {
        case "invalid_items":
          return {
            response: error(
              "VALIDATION_ERROR",
              "items must be a non-empty list of { productId, quantity } with quantity between 1 and 99",
              422
            ),
            event: "order_invalid",
            component,
            severity: "WARNING",
            message: "Invalid order payload"
          };
        case "product_not_found":
          return {
            response: error("PRODUCT_NOT_FOUND", "An item in this order no longer exists", 404),
            event: "order_product_missing",
            component,
            severity: "WARNING",
            message: "Order referenced a missing product"
          };
        case "product_unavailable":
          return {
            response: error("PRODUCT_UNAVAILABLE", `${result.name} is currently unavailable`, 409),
            event: "product_unavailable",
            component,
            severity: "WARNING",
            message: "Order prevented because a product is not active"
          };
        case "insufficient_stock":
          return {
            response: error("INSUFFICIENT_STOCK", `${result.name} has only ${result.available} left in stock`, 409),
            event: "order_stock_conflict",
            component,
            severity: "WARNING",
            message: "Concurrent stock contention prevented this order"
          };
        default: {
          const body = { order: result.order };
          return {
            response: json(body, 201),
            event: "order_created",
            component,
            message: "Order created and stock reserved",
            // Only a success is cached, so a failed attempt can be retried with the same key.
            replayable: replayable && { ...replayable, status: 201, body }
          };
        }
      }
    }
  },

  {
    method: "GET",
    match: (path) => path === "/api/orders",
    async handler({ store, isStaff, scenario }) {
      const component = "operations";
      if (scenario === "unauthorized_desk" || !isStaff) {
        return {
          response: error("FORBIDDEN", "Staff credentials are required to access the fulfilment desk", 403),
          event: "auth_unauthorized_access",
          component,
          severity: "WARNING",
          message: "Unauthorized attempt to access the fulfilment desk"
        };
      }

      const orders = await store.listOrders({ role: "staff" });
      return {
        response: json({ orders }),
        event: "orders_listed",
        component,
        message: `Fulfilment desk returned ${orders.length} orders`
      };
    }
  },

  // Must stay ahead of the :id route below, or "my" is read as an order id.
  {
    method: "GET",
    match: (path) => path === "/api/orders/my",
    async handler({ store, currentUser }) {
      const component = "orders";
      if (!currentUser) {
        return {
          ...signInRequired(component, "Sign in to view your orders", "Order history requested without a session"),
          severity: "INFO"
        };
      }

      const orders = await store.listOrders({ userId: currentUser.id, role: currentUser.role });
      return {
        response: json({ orders }),
        event: "order_history_retrieved",
        component,
        message: `Returned ${orders.length} orders for the signed-in customer`
      };
    }
  },

  {
    method: "GET",
    match: (path) => ORDER_BY_ID.test(path),
    async handler({ store, path, currentUser, isStaff }) {
      const component = "orders";
      const order = await store.getOrder(segment(path, 3));

      if (!order) return orderNotFound(component, "Order lookup found no matching record");

      if (!currentUser || (!isStaff && order.userId !== currentUser.id)) {
        return {
          response: error("FORBIDDEN", "You do not have permission to view this order", 403),
          event: "auth_unauthorized_access",
          component,
          severity: "WARNING",
          message: "Unauthorized order lookup"
        };
      }

      return { response: json({ order }), event: "order_viewed", component, message: "Order retrieved" };
    }
  },

  {
    method: "POST",
    match: (path) => ORDER_CANCEL.test(path),
    async handler({ store, path, currentUser }) {
      const component = "orders";
      if (!currentUser) {
        return signInRequired(component, "Sign in to cancel an order", "Cancellation attempted without a session");
      }

      const result = await store.cancelOrder(segment(path, 3), {
        userId: currentUser.id,
        role: currentUser.role
      });

      switch (result.kind) {
        case "not_found":
          return orderNotFound(component, "Cancellation referenced a missing order");
        case "forbidden":
          return {
            response: error("FORBIDDEN", "You do not have permission to cancel this order", 403),
            event: "auth_unauthorized_access",
            component,
            severity: "WARNING",
            message: "Unauthorized cancellation attempt"
          };
        case "invalid_state":
          return {
            response: error(
              "ORDER_NOT_CANCELLABLE",
              `An order in status ${result.currentStatus} cannot be cancelled`,
              409
            ),
            event: "order_cancel_invalid_state",
            component,
            severity: "WARNING",
            message: "Cancellation attempted in a terminal state"
          };
        default:
          return {
            response: json({ order: result.order }),
            event: "order_cancelled",
            component,
            message: "Order cancelled and reserved stock released"
          };
      }
    }
  },

  {
    method: "PATCH",
    match: (path) => ORDER_FULFIL.test(path),
    async handler({ store, path, isStaff }) {
      const component = "operations";
      if (!isStaff) {
        return {
          response: error("FORBIDDEN", "Staff credentials are required to fulfil orders", 403),
          event: "auth_unauthorized_access",
          component,
          severity: "WARNING",
          message: "Unauthorized fulfilment attempt"
        };
      }

      const result = await store.fulfilOrder(segment(path, 3));

      switch (result.kind) {
        case "not_found":
          return orderNotFound(component, "Fulfilment referenced a missing order");
        case "invalid_state":
          return {
            response: error(
              "ORDER_NOT_FULFILLABLE",
              `Only paid orders can be fulfilled; this one is ${result.currentStatus}`,
              409
            ),
            event: "order_fulfil_invalid_state",
            component,
            severity: "WARNING",
            message: "Fulfilment attempted in an invalid state"
          };
        default:
          return {
            response: json({ order: result.order }),
            event: "order_fulfilled",
            component,
            message: "Order marked as fulfilled"
          };
      }
    }
  }
];
