import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { join, resolve } from "node:path";

const distRoot = resolve("dist");
const backendOrigin = "http://127.0.0.1:8001";
const port = Number(process.env.PORT || 5180);

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function contentType(pathname) {
  const ext = pathname.match(/\.[^.]+$/)?.[0] || ".html";
  return contentTypes[ext] || "application/octet-stream";
}

async function serveStatic(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = decodeURIComponent(url.pathname);
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = resolve(join(distRoot, requested));
  const safePath = filePath.startsWith(distRoot) && existsSync(filePath) ? filePath : join(distRoot, "index.html");
  const info = await stat(safePath);
  res.writeHead(200, {
    "content-length": info.size,
    "content-type": contentType(safePath),
    "cache-control": safePath.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable",
  });
  createReadStream(safePath).pipe(res);
}

function proxyHttp(req, res) {
  const target = new URL(req.url || "/", backendOrigin);
  const proxy = httpRequest(
    target,
    {
      method: req.method,
      headers: { ...req.headers, host: target.host },
    },
    (upstream) => {
      res.writeHead(upstream.statusCode || 502, upstream.headers);
      upstream.pipe(res);
    },
  );
  proxy.on("error", (error) => {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: error.message }));
  });
  req.pipe(proxy);
}

const server = createServer((req, res) => {
  const pathname = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`).pathname;
  if (pathname === "/favicon.ico") {
    res.writeHead(204, { "cache-control": "public, max-age=86400" });
    res.end();
    return;
  }
  if (pathname.startsWith("/assets/") || pathname === "/" || pathname.endsWith(".html")) {
    serveStatic(req, res).catch((error) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    });
    return;
  }
  proxyHttp(req, res);
});

server.on("upgrade", (req, socket) => {
  const target = new URL(req.url || "/", backendOrigin);
  const proxy = httpRequest({
    host: target.hostname,
    port: target.port,
    path: target.pathname + target.search,
    method: req.method,
    headers: { ...req.headers, host: target.host },
  });
  proxy.on("upgrade", (upstream, upstreamSocket, head) => {
    socket.write(
      `HTTP/${upstream.httpVersion} ${upstream.statusCode} ${upstream.statusMessage}\r\n` +
        Object.entries(upstream.headers).map(([key, value]) => `${key}: ${value}`).join("\r\n") +
        "\r\n\r\n",
    );
    upstreamSocket.write(head);
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
  });
  proxy.on("error", () => socket.destroy());
  proxy.end();
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Share proxy listening at http://127.0.0.1:${port}`);
});
