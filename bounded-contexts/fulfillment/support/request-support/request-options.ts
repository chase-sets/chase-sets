import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
import type { FulfillmentApiClientOptions } from "./client";

export function fulfillmentRequestOptions(request: Request, headers?: HeadersInit): FulfillmentApiClientOptions {
  return {
    baseUrl: resolveRequestApiBaseUrl(request, "/api/marketplace"),
    fetch: createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "fulfillment" }),
    headers,
  };
}
