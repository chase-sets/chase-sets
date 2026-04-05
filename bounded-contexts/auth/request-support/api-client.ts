import {
  createForwardedAuthFetch,
  resolveRequestApiBaseUrl,
} from "@chase-sets/bounded-context-runtime";
export {
  authApi,
  AuthApiError,
  createAuthApiClient,
} from "../client";
export type { AuthApiClientOptions } from "../client";
import { createAuthApiClient } from "../client";

export function createAuthRequestApiClient(request: Request) {
  return createAuthApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/auth"),
    fetch: createForwardedAuthFetch(request),
  });
}
