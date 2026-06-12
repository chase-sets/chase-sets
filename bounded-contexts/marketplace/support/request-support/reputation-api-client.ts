import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
export { createReputationApiClient, ReputationApiError, reputationApi } from "./reputation-client";
export type {
  ReviewSummary,
  ReputationApiClientOptions,
  ReviewDetail,
  ReviewListItem,
  ReviewOpportunity,
} from "./reputation-client";
import { createReputationApiClient } from "./reputation-client";

export function createReputationRequestApiClient(request: Request) {
  return createReputationApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/marketplace"),
    fetch: createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "marketplace" }),
  });
}
