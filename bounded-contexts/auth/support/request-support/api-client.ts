import {
  createPlatformInternalAuthHeaders,
  createForwardedAuthFetch,
  resolveRequestApiBaseUrl,
  resolvePlatformInternalAuthSecret,
} from "@chase-sets/platform-runtime/http";
export { authApi, AuthApiError, createAuthApiClient, createUcpOAuthApiClient } from "../../client";
export type { AuthApiClientOptions } from "../../client";
import { createAuthApiClient, createUcpOAuthApiClient } from "../../client";

export function createAuthRequestApiClient(request: Request) {
  return createAuthApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/auth", { requireInternalApiOrigin: true }),
    fetch: createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "auth" }),
  });
}

// Connected-agents self-service surface — UCP OAuth grant/mandate/activity
// routes are mounted at /ucp/oauth, not /api/auth, so this forwards to a distinct base path.
export function createUcpOAuthRequestApiClient(request: Request) {
  return createUcpOAuthApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/ucp/oauth", { requireInternalApiOrigin: true }),
    fetch: createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "auth" }),
  });
}

export function createInternalAuthRequestApiClient(request: Request) {
  const internalAuthSecret = resolvePlatformInternalAuthSecret({
    requireExplicitInProduction: true,
  });

  return createAuthApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/auth", { requireInternalApiOrigin: true }),
    fetch: createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "auth" }),
    headers: () => createPlatformInternalAuthHeaders(undefined, internalAuthSecret),
  });
}
