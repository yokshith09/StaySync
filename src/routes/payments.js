import { json, error } from "../http.js";

const SLOW_PAYMENT_DELAY_MS = 125;

export const paymentRoutes = [
  {
    method: "POST",
    match: (path) => path === "/api/payments",
    async handler({ store, currentUser, requestBody, scenario, replayable }) {
      const component = "payments";

      if (!currentUser) {
        return {
          response: error("UNAUTHORIZED", "Sign in to pay for an order", 401),
          event: "auth_unauthenticated",
          component,
          severity: "WARNING",
          message: "Payment attempted without a session"
        };
      }

      if (!requestBody?.orderId) {
        return {
          response: error("VALIDATION_ERROR", "orderId is required", 422),
          event: "payment_invalid",
          component,
          severity: "WARNING",
          message: "Invalid payment request"
        };
      }

      if (scenario === "payment_failure") {
        const order = await store.getOrder(requestBody.orderId);
        // The failed attempt is still audited, which is what makes the 502 traceable later.
        if (order) await store.recordFailedPayment(order.id, order.totalCents);
        return {
          response: error("PAYMENT_PROVIDER_REJECTED", "The simulated payment provider rejected this order", 502),
          event: "payment_provider_rejected",
          component,
          severity: "ERROR",
          message: "Simulated provider rejected the payment"
        };
      }

      const slow = scenario === "slow_payment";
      if (slow) await new Promise((resolve) => setTimeout(resolve, SLOW_PAYMENT_DELAY_MS));

      const result = await store.payOrder(requestBody.orderId, {
        userId: currentUser.id,
        role: currentUser.role
      });

      switch (result.kind) {
        case "not_found":
          return {
            response: error("ORDER_NOT_FOUND", "The order does not exist", 404),
            event: "order_not_found",
            component,
            severity: "WARNING",
            message: "Payment referenced a missing order"
          };
        case "forbidden":
          return {
            response: error("FORBIDDEN", "You do not have permission to pay for this order", 403),
            event: "auth_unauthorized_access",
            component,
            severity: "WARNING",
            message: "Unauthorized payment attempt"
          };
        case "invalid_state":
          return {
            response: error(
              "ORDER_NOT_PAYABLE",
              `Only pending orders can be paid; this one is ${result.currentStatus}`,
              409
            ),
            event: "payment_invalid_state",
            component,
            severity: "WARNING",
            message: "Payment attempted for an order in an invalid state"
          };
        default: {
          const body = { payment: result.payment, order: result.order };
          return {
            response: json(body, 201),
            event: slow ? "payment_slow" : "payment_approved",
            component,
            severity: slow ? "WARNING" : "INFO",
            message: slow
              ? "Payment approved above the demo latency threshold"
              : "Payment approved and confirmation event staged",
            replayable: replayable && { ...replayable, status: 201, body }
          };
        }
      }
    }
  }
];
