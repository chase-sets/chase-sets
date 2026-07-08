import type { MiddlewareHandler } from "hono";
import {
  MCP_CLIENT_CAPABILITIES_HEADER,
  MCP_CLIENT_NAME_HEADER,
  MCP_CLIENT_VERSION_HEADER,
  MCP_METHOD_HEADER,
  MCP_NAME_HEADER,
  MCP_PROTOCOL_VERSION_HEADER,
  MCP_SESSION_ID_HEADER,
} from "./mcp-protocol";
import { resolvePublicRequestOrigin } from "./http";

export type McpHttpOriginPolicyOptions = Readonly<{
  allowedOrigins?: readonly string[];
  allowedOriginHostSuffixes?: readonly string[];
  trustForwardedHeaders?: boolean;
}>;

const DEFAULT_ALLOWED_ORIGIN_HOST_SUFFIXES = ["chasesets.com", "chasesets.test"] as const;
const CORS_ALLOWED_HEADERS = [
  "Accept",
  "Authorization",
  "Content-Digest",
  "Content-Type",
  "Idempotency-Key",
  "Last-Event-ID",
  "Signature",
  "Signature-Input",
  "UCP-Agent",
  MCP_CLIENT_CAPABILITIES_HEADER,
  MCP_CLIENT_NAME_HEADER,
  MCP_CLIENT_VERSION_HEADER,
  MCP_METHOD_HEADER,
  MCP_NAME_HEADER,
  MCP_PROTOCOL_VERSION_HEADER,
  MCP_SESSION_ID_HEADER,
] as const;
const CORS_EXPOSED_HEADERS = [MCP_SESSION_ID_HEADER, "WWW-Authenticate"] as const;

function parseOrigin(value: string) {
  try {
    const origin = new URL(value);
    return origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash
      ? null
      : origin;
  } catch {
    return null;
  }
}

function normalizedHostname(url: URL) {
  return url.hostname.toLowerCase().replace(/\.$/, "");
}

function isLocalHostName(hostname: string) {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".localhost")
  );
}

function isHostOrSubdomain(hostname: string, suffix: string) {
  const normalizedSuffix = suffix.toLowerCase().replace(/^\./, "");
  return hostname === normalizedSuffix || hostname.endsWith(`.${normalizedSuffix}`);
}

function isAllowedOrigin(request: Request, origin: URL, options: McpHttpOriginPolicyOptions) {
  const requestOrigin = new URL(resolvePublicRequestOrigin(request, options));
  const originHost = normalizedHostname(origin);
  const requestHost = normalizedHostname(requestOrigin);

  if (origin.origin === requestOrigin.origin) {
    return true;
  }

  if (isLocalHostName(originHost) && isLocalHostName(requestHost)) {
    return true;
  }

  if (options.allowedOrigins?.some((allowedOrigin) => parseOrigin(allowedOrigin)?.origin === origin.origin)) {
    return true;
  }

  const allowedHostSuffixes = options.allowedOriginHostSuffixes ?? DEFAULT_ALLOWED_ORIGIN_HOST_SUFFIXES;
  return origin.protocol === "https:" && allowedHostSuffixes.some((suffix) => isHostOrSubdomain(originHost, suffix));
}

function appendVary(headers: Headers, value: string) {
  const existing = headers.get("Vary");
  if (!existing) {
    headers.set("Vary", value);
    return;
  }

  const values = existing.split(",").map((entry) => entry.trim().toLowerCase());
  if (!values.includes(value.toLowerCase())) {
    headers.set("Vary", `${existing}, ${value}`);
  }
}

function applyCorsHeaders(headers: Headers, origin: URL) {
  headers.set("Access-Control-Allow-Origin", origin.origin);
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", CORS_ALLOWED_HEADERS.join(", "));
  headers.set("Access-Control-Expose-Headers", CORS_EXPOSED_HEADERS.join(", "));
  headers.set("Access-Control-Max-Age", "600");
  appendVary(headers, "Origin");
}

function mcpForbiddenOriginResponse() {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32003,
        message: "Invalid Origin header for MCP endpoint.",
      },
    }),
    {
      status: 403,
      headers: {
        "Content-Type": "application/json",
        Vary: "Origin",
      },
    },
  );
}

export function createMcpHttpOriginPolicyMiddleware(options: McpHttpOriginPolicyOptions = {}): MiddlewareHandler {
  return async (c, next) => {
    const originValue = c.req.header("Origin");
    const origin = originValue ? parseOrigin(originValue) : null;

    if (originValue && (!origin || !isAllowedOrigin(c.req.raw, origin, options))) {
      return mcpForbiddenOriginResponse();
    }

    if (c.req.method === "OPTIONS") {
      const headers = new Headers();
      if (origin) {
        applyCorsHeaders(headers, origin);
      }
      return new Response(null, { status: 204, headers });
    }

    await next();

    if (origin) {
      applyCorsHeaders(c.res.headers, origin);
    }
  };
}
