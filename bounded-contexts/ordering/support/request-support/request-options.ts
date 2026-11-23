import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
import type { OrderingApiClientOptions } from "./client";

export function orderingRequestOptions(request: Request): OrderingApiClientOptions {
  return {
    baseUrl: resolveRequestApiBaseUrl(request, "/api/marketplace"),
    fetch: createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "ordering" }),
  };
}
