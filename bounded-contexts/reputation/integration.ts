import {
  createForwardedAuthFetch,
  resolveRequestApiBaseUrl,
} from "@chase-sets/bounded-context-runtime";
import { createReputationApiClient } from "./client";

export type { ReputationReviewOpportunity } from "./reviews/ui/contracts";

export function createReputationRequestIntegrationClient(request: Request) {
  return createReputationApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/marketplace"),
    fetch: createForwardedAuthFetch(request),
  });
}
