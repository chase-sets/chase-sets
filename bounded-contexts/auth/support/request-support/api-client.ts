import {
  createPlatformInternalAuthHeaders,
  createForwardedAuthFetch,
  resolveRequestApiBaseUrl,
  resolvePlatformInternalAuthSecret,
} from "@chase-sets/platform-runtime/http";
export { authApi, AuthApiError, createAuthApiClient } from "../../client";
export type { AuthApiClientOptions } from "../../client";
import { createAuthApiClient } from "../../client";

export function createAuthRequestApiClient(request: Request) {
  return createAuthApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/auth"),
    fetch: createForwardedAuthFetch(request),
  });
}

export function createInternalAuthRequestApiClient(request: Request) {
  const internalAuthSecret = resolvePlatformInternalAuthSecret({
    requireExplicitInProduction: true,
  });

  return createAuthApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/auth"),
    fetch: createForwardedAuthFetch(request),
    headers: () => createPlatformInternalAuthHeaders(undefined, internalAuthSecret),
  });
}
