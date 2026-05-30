import {
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  CHASE_SETS_READ_TARGET_CONTEXT_HEADER,
  encodeFreshWriteReceipt,
  readFreshWriteToken,
} from "@chase-sets/http/responses";

export const PLATFORM_INTERNAL_AUTH_HEADER = "x-chase-sets-internal-auth";
export const PLATFORM_INTERNAL_AUTH_SECRET_ENV = "PLATFORM_INTERNAL_AUTH_SECRET";
export const CHASE_SETS_INTERNAL_API_ORIGIN_ENV = "CHASE_SETS_INTERNAL_API_ORIGIN";
const DEFAULT_DEV_INTERNAL_AUTH_SECRET = "dev-platform-internal-auth-secret";

export function resolvePlatformInternalAuthSecret(options: Readonly<{ requireExplicitInProduction?: boolean }> = {}) {
  const configured = process.env[PLATFORM_INTERNAL_AUTH_SECRET_ENV]?.trim();
  if (options.requireExplicitInProduction && process.env.NODE_ENV === "production" && !configured) {
    throw new Error(`${PLATFORM_INTERNAL_AUTH_SECRET_ENV} is required for internal platform API calls in production.`);
  }

  return configured || DEFAULT_DEV_INTERNAL_AUTH_SECRET;
}

export function createPlatformInternalAuthHeaders(
  initHeaders?: HeadersInit,
  secret = resolvePlatformInternalAuthSecret(),
): Headers {
  const headers = new Headers(initHeaders);
  headers.set(PLATFORM_INTERNAL_AUTH_HEADER, secret);
  return headers;
}

export function createForwardedAuthHeaders(
  request: Request,
  initHeaders?: HeadersInit,
  options: Readonly<{ readTargetContextName?: string }> = {},
): Headers {
  const headers = new Headers(initHeaders);
  const cookie = request.headers.get("cookie");
  const authorization = request.headers.get("authorization");
  const freshWrite = readFreshWriteToken(request);

  if (cookie && !headers.has("cookie")) {
    headers.set("cookie", cookie);
  }

  if (authorization && !headers.has("authorization")) {
    headers.set("authorization", authorization);
  }

  if (freshWrite && !headers.has(CHASE_SETS_READ_AFTER_WRITE_HEADER)) {
    headers.set(CHASE_SETS_READ_AFTER_WRITE_HEADER, encodeFreshWriteReceipt(freshWrite));
  }

  if (options.readTargetContextName && !headers.has(CHASE_SETS_READ_TARGET_CONTEXT_HEADER)) {
    headers.set(CHASE_SETS_READ_TARGET_CONTEXT_HEADER, options.readTargetContextName);
  }

  return headers;
}

export function createForwardedAuthFetch(
  request: Request,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  options: Readonly<{ readTargetContextName?: string }> = {},
): typeof globalThis.fetch {
  return (input, init = {}) =>
    fetchImpl(input, {
      ...init,
      credentials: init.credentials ?? "include",
      headers: createForwardedAuthHeaders(request, init.headers, options),
    });
}

export function resolveRequestApiBaseUrl(request: Request, apiBasePath: string): string {
  const internalApiOrigin = resolveInternalApiOrigin();
  if (internalApiOrigin) {
    return new URL(apiBasePath, `${internalApiOrigin}/`).toString().replace(/\/$/, "");
  }

  return `${resolvePublicRequestOrigin(request)}${apiBasePath}`;
}

function firstForwardedValue(value: string | null) {
  return value?.split(",")[0]?.trim().toLowerCase();
}

function isLocalHost(host: string) {
  const hostname = (host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0])?.toLowerCase() ?? "";
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function resolvePublicRequestOrigin(request: Request): string {
  const url = new URL(request.url);
  const forwardedProto = firstForwardedValue(request.headers.get("x-forwarded-proto"));
  const forwardedHost = firstForwardedValue(request.headers.get("x-forwarded-host"));
  const host = forwardedHost || request.headers.get("host") || url.host;
  const protocol =
    forwardedProto === "http" || forwardedProto === "https" ? forwardedProto : url.protocol.replace(/:$/, "");

  return `${protocol === "http" && !isLocalHost(host) ? "https" : protocol}://${host}`;
}

export function resolveInternalApiOrigin(
  env: Readonly<Record<string, string | undefined>> = readProcessEnv(),
): string | null {
  const configured = env[CHASE_SETS_INTERNAL_API_ORIGIN_ENV]?.trim();
  if (!configured) {
    return null;
  }

  const url = new URL(configured);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function readProcessEnv(): Readonly<Record<string, string | undefined>> {
  return typeof process === "undefined" ? {} : process.env;
}
