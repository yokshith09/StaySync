import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createStaySyncApp } from "./app.js";

const app = createStaySyncApp({ writeLog: (entry) => console.log(JSON.stringify(entry)) });
const staticFiles = new Map([["/", "index.html"], ["/app.js", "app.js"], ["/styles.css", "styles.css"]]);
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "GET" && staticFiles.has(url.pathname)) {
    const file = await readFile(new URL(`../public/${staticFiles.get(url.pathname)}`, import.meta.url));
    res.writeHead(200, { "content-type": url.pathname.endsWith(".css") ? "text/css" : url.pathname.endsWith(".js") ? "text/javascript" : "text/html" }); return res.end(file);
  }
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const response = await app.fetch(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }));
  res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
});
server.listen(Number(process.env.PORT ?? 8081), () => console.log("StaySync is running at http://localhost:8081"));
