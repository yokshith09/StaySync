import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { createStaySyncApp } from "./app.js";

const app = createStaySyncApp({ writeLog: (entry) => console.log(JSON.stringify(entry)) });
const port = Number(process.env.PORT ?? 8081);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json"
};

const PAGES = new Set(["index", "signin", "cart", "orders", "operations", "scenarios"]);

/** Maps a request path to a file under public/, or null if it is not a static asset. */
function resolveStatic(pathname) {
  if (pathname.includes("..")) return null;
  if (pathname === "/") return "index.html";

  const name = pathname.slice(1);
  if (PAGES.has(name)) return `${name}.html`;
  if (/^[a-z0-9_-]+\.(html|css|js|svg|webmanifest)$/i.test(name)) return name;
  if (/^img\/[a-z0-9_-]+\.svg$/i.test(name)) return name;
  return null;
}

const server = createServer(async (req, res) => {
  try {
    const host = req.headers.host || `localhost:${port}`;
    const url = new URL(req.url, `http://${host}`);

    if (req.method === "GET") {
      const file = resolveStatic(url.pathname);
      if (file) {
        try {
          const body = await readFile(new URL(`../public/${file}`, import.meta.url));
          res.writeHead(200, {
            "content-type": MIME[extname(file)] ?? "application/octet-stream",
            "cache-control": "no-cache"
          });
          return res.end(body);
        } catch (err) {
          if (err.code !== "ENOENT") throw err;
          // Fall through to the API, which answers with a structured 404.
        }
      }
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
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        severity: "ERROR",
        event: "unhandled_server_error",
        component: "platform",
        entryPoint: "http",
        route: req.url,
        statusCode: 500,
        environment: process.env.NODE_ENV ?? "development",
        message: `Unhandled error: ${err.name}: ${err.message}`
      })
    );
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: { code: "SERVER_ERROR", message: "Internal server error" } }));
    }
  }
});

server.listen(port, "0.0.0.0", () => {
  const engine =
    process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY
      ? "supabase_rest"
      : process.env.DATABASE_URL
        ? "postgresql"
        : "in-memory";
  console.log(`StaySync order platform on http://localhost:${port} (storage: ${engine})`);
});
