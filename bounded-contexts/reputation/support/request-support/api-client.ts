import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
export { createReputationApiClient, ReputationApiError, reputationApi } from "../../client";
export type {
  ReviewSummary,
  ReputationApiClientOptions,
  ReviewDetail,
  ReviewListItem,
  ReviewOpportunity,
} from "../../client";
import { createReputationApiClient } from "../../client";

export function createReputationRequestApiClient(request: Request) {
  return createReputationApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/marketplace"),
    fetch: createForwardedAuthFetch(request),
  });
}
