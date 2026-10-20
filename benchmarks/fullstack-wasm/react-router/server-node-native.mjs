// Node counterpart of server-bun.mjs: node:http plus React Router's fetch-style
// request listener, no Express. No response compression (k6 asks for identity).
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequestListener } from "@react-router/node";

const build = await import("./build/server/index.js");
const listener = createRequestListener({ build, mode: "production" });
const port = Number(process.env.PORT ?? 8080);

createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://local").pathname;
  if (pathname.startsWith("/assets/")) {
    const file = `build/client${pathname}`;
    const info = await stat(file).catch(() => null);
    if (info?.isFile()) {
      const type = pathname.endsWith(".css") ? "text/css" : "application/javascript";
      res.writeHead(200, { "content-type": type, "content-length": info.size, "cache-control": "public, max-age=31536000, immutable" });
      createReadStream(file).pipe(res);
      return;
    }
  }
  return listener(req, res);
}).listen(port, "0.0.0.0", () => console.log(`react-router item page (node:http) listening on ${port}`));
