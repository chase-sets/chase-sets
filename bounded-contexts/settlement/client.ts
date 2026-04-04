export {
  SettlementApiError,
  createSettlementApiClient,
  settlementApi,
} from "./web";
export type { SettlementApiClientOptions } from "./web";

import {
  createForwardedAuthFetch,
  resolveRequestApiBaseUrl,
} from "@chase-sets/bounded-context-runtime";
import { createSettlementApiClient } from "./web";

export function createSettlementRequestApiClient(request: Request) {
  return createSettlementApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/settlement"),
    fetch: createForwardedAuthFetch(request),
  });
}
