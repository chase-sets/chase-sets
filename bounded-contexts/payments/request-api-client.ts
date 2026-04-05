import {
  createForwardedAuthFetch,
  resolveRequestApiBaseUrl,
} from "@chase-sets/bounded-context-runtime";
import { createPaymentsApiClient } from "./client";

export function createPaymentsRequestApiClient(request: Request) {
  return createPaymentsApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/marketplace"),
    fetch: createForwardedAuthFetch(request),
  });
}
