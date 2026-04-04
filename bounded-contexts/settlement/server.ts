import {
  createForwardedAuthFetch,
  resolveRequestApiBaseUrl,
} from "@chase-sets/bounded-context-runtime";
import { createSettlementApiClient } from "./client";

export function createSettlementRequestApiClient(request: Request) {
  return createSettlementApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/settlement"),
    fetch: createForwardedAuthFetch(request),
  });
}
