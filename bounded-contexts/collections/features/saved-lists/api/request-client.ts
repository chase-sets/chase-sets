import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
import { createCollectionsApiClient } from "./client";

export function createCollectionsRequestApiClient(request: Request) {
  return createCollectionsApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/collections"),
    fetch: createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "collections" }),
  });
}
