import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
export { createSellerMetricsApiClient, SellerMetricsApiError } from "./seller-metrics-client";
export type {
  SellerBehavioralMetricsChips,
  SellerBehavioralMetricsSummary,
  SellerMetricsApiClientOptions,
} from "./seller-metrics-client";
import { createSellerMetricsApiClient } from "./seller-metrics-client";

export function createSellerMetricsRequestApiClient(request: Request) {
  return createSellerMetricsApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/marketplace"),
    fetch: createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "marketplace" }),
  });
}
