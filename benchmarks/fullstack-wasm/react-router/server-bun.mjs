// Bun-native server for the same React Router build: Bun.serve plus React Router's
// Web-standard request handler, no Express. No response compression (k6 asks for identity).
import { createRequestHandler } from "react-router";
import * as build from "./build/server/index.js";

const handler = createRequestHandler(build, "production");
const immutable = { "cache-control": "public, max-age=31536000, immutable" };
const port = Number(process.env.PORT ?? 8080);

Bun.serve({
  port,
  hostname: "0.0.0.0",
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/assets/")) {
      const file = Bun.file(`build/client${pathname}`);
      if (await file.exists()) return new Response(file, { headers: immutable });
    }
    return handler(request);
  },
});
console.log(`react-router item page (Bun.serve) listening on ${port}`);
