import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createStaySyncApp } from "./app.js";

const app = createStaySyncApp({ writeLog: (entry) => console.log(JSON.stringify(entry)) });
const staticFiles = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/app.js", "app.js"],
  ["/styles.css", "styles.css"]
]);

const port = Number(process.env.PORT ?? 8081);

const server = createServer(async (req, res) => {
  try {
    const host = req.headers.host || `localhost:${port}`;
    const url = new URL(req.url, `http://${host}`);

    if (req.method === "GET" && staticFiles.has(url.pathname)) {
      const file = await readFile(new URL(`../public/${staticFiles.get(url.pathname)}`, import.meta.url));
      res.writeHead(200, {
        "content-type": url.pathname.endsWith(".css")
          ? "text/css; charset=utf-8"
          : url.pathname.endsWith(".js")
          ? "text/javascript; charset=utf-8"
          : "text/html; charset=utf-8"
      });
      return res.end(file);
    }

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const hasBody = req.method !== "GET" && req.method !== "HEAD" && chunks.length > 0;

    const response = await app.fetch(
      new Request(`http://${host}${req.url}`, {
        method: req.method,
        headers: req.headers,
        body: hasBody ? Buffer.concat(chunks) : undefined
      })
    );

    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    console.error("Server error handling request:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: { code: "SERVER_ERROR", message: err.message } }));
    }
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`StaySync is running at http://localhost:${port}`);
});
