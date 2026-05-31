import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
import { createPlatformOperationsApiClient } from "./client";

export function createPlatformOperationsRequestApiClient(request: Request) {
  return createPlatformOperationsApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/platform"),
    fetch: createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "platform-operations" }),
  });
}
