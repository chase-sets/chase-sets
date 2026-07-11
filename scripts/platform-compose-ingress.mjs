#!/usr/bin/env node
// Minimal path-based reverse proxy standing in for the Kubernetes ingress
// (infrastructure/helm/platform templates) in the CI compose boot+smoke job.
// Real preview/staging/production ingress routes each domain's
// `/.well-known`, `/ucp`, `/mcp`, and `/api...` paths straight to the
// platform-api Service and everything else to that domain's web service; a
// browser (or platform-smoke.mjs) never reaches the web app process for API
// paths. Compose has no ingress layer, so this process fills that gap for
// exactly one domain per invocation, using the SAME prefix list the Helm
// chart renders (`platformApiIngressPrefixes`) so the two can never drift.
import { createServer } from "node:http";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readOption } from "./lib/cli-options.mjs";
import { platformApiIngressPrefixes } from "./render-platform-helm-values.mjs";

// Headers that describe the hop from the client to *this* proxy and must
// never be forwarded verbatim to the upstream: `host` would make the
// upstream see the proxy's own origin, and `content-length`/`connection`
// are recomputed by undici for the outbound request. Node's fetch (undici)
// always derives the outbound Host from the request URL and silently
// ignores an explicit `host` header override, so -- exactly like the real
// nginx ingress -- the client's original domain is instead forwarded via
// `x-forwarded-host`/`x-forwarded-proto` (see the `xForwardedHeaders` call
// below), which platform-api already trusts
// (CHASE_SETS_TRUST_FORWARDED_HEADERS=true; resolvePublicRequestOrigin in
// infrastructure/platform-runtime/http.ts) to compute UCP/absolute-URL
// responses for the domain actually requested (landing vs. marketplace vs.
// admin), not the api-target's own host.
const hopByHopRequestHeaders = new Set(["host", "connection", "content-length"]);

function xForwardedHeaders(request) {
  const forwardedHost = request.headers.host;
  if (!forwardedHost) {
    return {};
  }
  return {
    "x-forwarded-host": forwardedHost,
    "x-forwarded-proto": "http",
  };
}

export function shouldRouteToApi(pathname, prefixes = platformApiIngressPrefixes) {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`) || pathname === "/api");
}

function forwardableRequestHeaders(headers) {
  const forwarded = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || hopByHopRequestHeaders.has(name.toLowerCase())) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        forwarded.append(name, entry);
      }
    } else {
      forwarded.set(name, value);
    }
  }
  return forwarded;
}

export function createComposeIngressServer({ label, webTarget, apiTarget, fetchImpl = fetch }) {
  return createServer(async (request, response) => {
    const pathname = request.url ?? "/";
    const targetBase = shouldRouteToApi(pathname) ? apiTarget : webTarget;

    try {
      const headers = forwardableRequestHeaders(request.headers);
      for (const [name, value] of Object.entries(xForwardedHeaders(request))) {
        if (!headers.has(name)) {
          headers.set(name, value);
        }
      }

      const upstreamResponse = await fetchImpl(new URL(pathname, targetBase), {
        method: request.method,
        headers,
        body: request.method && !["GET", "HEAD"].includes(request.method) ? request : undefined,
        duplex: "half",
        redirect: "manual",
      });

      const responseHeaders = {};
      for (const [name, value] of upstreamResponse.headers) {
        if (name.toLowerCase() === "content-encoding") {
          continue;
        }
        responseHeaders[name] = value;
      }
      response.writeHead(upstreamResponse.status, responseHeaders);

      if (upstreamResponse.body) {
        for await (const chunk of upstreamResponse.body) {
          response.write(chunk);
        }
      }
      response.end();
    } catch (error) {
      response.writeHead(502, { "content-type": "text/plain" });
      response.end(
        `platform-compose-ingress (${label}) failed to reach ${targetBase}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });
}

function parseArgs(argv) {
  const port = Number(readOption(argv, "--port"));
  const webTarget = readOption(argv, "--web-target");
  const apiTarget = readOption(argv, "--api-target");
  const label = readOption(argv, "--label") ?? "compose-ingress";

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("platform-compose-ingress requires --port <number>.");
  }
  if (!webTarget || !apiTarget) {
    throw new Error(
      "Usage: node ./scripts/platform-compose-ingress.mjs --port <port> --web-target <url> --api-target <url> [--label <name>]",
    );
  }

  return { port, webTarget, apiTarget, label };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const server = createComposeIngressServer(options);
  server.listen(options.port, "0.0.0.0", () => {
    console.log(
      `platform-compose-ingress (${options.label}) listening on :${options.port} -> web ${options.webTarget}, api ${options.apiTarget}`,
    );
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
