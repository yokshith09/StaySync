import { createServer } from "node:http";
import { getStore } from "./store.js";

const POLL_INTERVAL_MS = Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? 5000);

export function createConfirmationWorker({
  store = getStore(),
  writeLog = (entry) => console.log(JSON.stringify(entry)),
  environment = process.env.NODE_ENV ?? "development"
} = {}) {
  const log = (severity, event, statusCode, startedAt, requestId, orderId, message) =>
    writeLog({
      timestamp: new Date().toISOString(),
      severity,
      event,
      component: "confirmation-worker",
      entryPoint: "pubsub",
      requestId,
      orderId,
      statusCode,
      responseTimeMs: Math.round(performance.now() - startedAt),
      environment,
      message
    });

  return {
    async processEvent(event) {
      const startedAt = performance.now();
      const requestId = event.payload?.requestId ?? crypto.randomUUID();
      const orderId = event.aggregateId ?? event.payload?.orderId;

      if (event.payload?.simulateRetry === true) {
        log(
          "WARNING",
          "confirmation_retry_scheduled",
          202,
          startedAt,
          requestId,
          orderId,
          "Downstream notification provider delayed; retry scheduled"
        );
        return { status: "retry_scheduled" };
      }

      if (event.id) await store.markOutboxPublished(event.id);

      const cancelled = event.eventType === "order.cancelled";
      log(
        "INFO",
        cancelled ? "cancellation_notice_sent" : "confirmation_sent",
        200,
        startedAt,
        requestId,
        orderId,
        cancelled ? "Order cancellation notice dispatched" : "Order confirmation dispatched"
      );
      return { status: "processed" };
    },

    async processPendingOutbox() {
      const events = await store.getOutboxEvents({ unpublishedOnly: true });
      const results = [];
      for (const event of events) results.push(await this.processEvent(event));
      return results;
    },

    /** Drains the outbox on an interval. Returns a stop function. */
    startPolling(intervalMs = POLL_INTERVAL_MS) {
      let running = false;
      const tick = async () => {
        if (running) return;
        running = true;
        try {
          await this.processPendingOutbox();
        } catch (err) {
          writeLog({
            timestamp: new Date().toISOString(),
            severity: "ERROR",
            event: "outbox_poll_failed",
            component: "confirmation-worker",
            entryPoint: "poller",
            statusCode: 500,
            environment,
            message: `Outbox poll failed: ${err.code ?? err.name}`
          });
        } finally {
          running = false;
        }
      };
      const timer = setInterval(tick, intervalMs);
      timer.unref?.();
      return () => clearInterval(timer);
    }
  };
}

// Standalone mode: a Cloud Run service that is both a Pub/Sub push target and an outbox poller.
if (process.argv[1]?.endsWith("worker.js")) {
  const worker = createConfirmationWorker();
  worker.startPolling();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };

    if (req.method === "POST" && url.pathname === "/pubsub/confirmations") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
        // Pub/Sub push wraps the payload in message.data as base64; a direct POST is accepted as-is.
        const envelope = body.message?.data
          ? JSON.parse(Buffer.from(body.message.data, "base64").toString("utf-8"))
          : body;
        send(200, await worker.processEvent(envelope));
      } catch (err) {
        // 400 tells Pub/Sub not to retry a message that will never parse.
        send(400, { error: { code: "INVALID_MESSAGE", message: err.message } });
      }
    } else if (req.method === "GET" && url.pathname === "/health") {
      send(200, { status: "healthy", application: "staysync-confirmation-worker" });
    } else {
      send(404, { error: { code: "NOT_FOUND", message: "Route not found" } });
    }
  });

  const port = Number(process.env.PORT ?? 8082);
  server.listen(port, "0.0.0.0", () => {
    console.log(`StaySync confirmation worker listening on port ${port}`);
  });
}
