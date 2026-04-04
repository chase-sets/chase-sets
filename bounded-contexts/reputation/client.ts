export {
  ReputationApiError,
  createReputationApiClient,
  reputationApi,
} from "./web";
export type { ReputationApiClientOptions } from "./web";

import {
  createForwardedAuthFetch,
  resolveRequestApiBaseUrl,
} from "@chase-sets/bounded-context-runtime";
import { createReputationApiClient } from "./web";

export function createReputationRequestApiClient(request: Request) {
  return createReputationApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/marketplace"),
    fetch: createForwardedAuthFetch(request),
  });
}
