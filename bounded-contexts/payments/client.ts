export {
  PaymentsApiError,
  createPaymentsApiClient,
  paymentsApi,
} from "./web";
export type { PaymentsApiClientOptions } from "./web";

import {
  createForwardedAuthFetch,
  resolveRequestApiBaseUrl,
} from "@chase-sets/bounded-context-runtime";
import { createPaymentsApiClient } from "./web";

export function createPaymentsRequestApiClient(request: Request) {
  return createPaymentsApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/marketplace"),
    fetch: createForwardedAuthFetch(request),
  });
}
