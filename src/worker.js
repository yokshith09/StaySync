import { createServer } from "node:http";
import { getStore } from "./store.js";

export function createConfirmationWorker({
  store = getStore(),
  writeLog = (entry) => console.log(JSON.stringify(entry)),
  environment = process.env.NODE_ENV ?? "development"
} = {}) {
  return {
    async processEvent(event) {
      const startedAt = performance.now();
      const requestId = event.payload?.requestId ?? crypto.randomUUID();
      const reservationId = event.aggregateId ?? event.payload?.reservationId;

      // Check simulated failure or retry condition
      const shouldRetry = event.payload?.simulateRetry === true;

      if (shouldRetry) {
        writeLog({
          timestamp: new Date().toISOString(),
          severity: "WARNING",
          event: "confirmation_retry_scheduled",
          component: "confirmation-worker",
          entryPoint: "pubsub",
          requestId,
          reservationId,
          statusCode: 202,
          responseTimeMs: Math.round(performance.now() - startedAt),
          environment,
          message: "Downstream notification provider delayed; scheduled retry"
        });
        return { status: "retry_scheduled" };
      }

      if (event.id) {
        await store.markOutboxPublished(event.id);
      }

      writeLog({
        timestamp: new Date().toISOString(),
        severity: "INFO",
        event: "confirmation_sent",
        component: "confirmation-worker",
        entryPoint: "pubsub",
        requestId,
        reservationId,
        statusCode: 200,
        responseTimeMs: Math.round(performance.now() - startedAt),
        environment,
        message: "Booking confirmation dispatched successfully"
      });

      return { status: "processed" };
    },

    async processPendingOutbox() {
      const events = await store.getOutboxEvents({ unpublishedOnly: true });
      const results = [];
      for (const ev of events) {
        results.push(await this.processEvent(ev));
      }
      return results;
    }
  };
}

// If invoked as a standalone worker server (e.g. Cloud Run Pub/Sub push target)
if (process.argv[1]?.endsWith("worker.js")) {
  const worker = createConfirmationWorker();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "POST" && url.pathname === "/pubsub/confirmations") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
        // Pub/Sub push messages wrap data in message.data (base64)
        const rawData = body.message?.data
          ? JSON.parse(Buffer.from(body.message.data, "base64").toString("utf-8"))
          : body;
        const result = await worker.processEvent(rawData);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "healthy", worker: "staysync-confirmation-worker" }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  const port = Number(process.env.PORT ?? 8082);
  server.listen(port, () => {
    console.log(`StaySync confirmation worker listening on port ${port}`);
  });
}
