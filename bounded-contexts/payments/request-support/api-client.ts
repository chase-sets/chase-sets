import {
  createForwardedAuthFetch,
  resolveRequestApiBaseUrl,
} from "@chase-sets/bounded-context-runtime";
export {
  createPaymentsApiClient,
  PaymentsApiError,
  paymentsApi,
} from "../client";
export type {
  PaymentsApiClientOptions,
  PaymentsPaymentDetail,
} from "../client";
import { createPaymentsApiClient } from "../client";

export function createPaymentsRequestApiClient(request: Request) {
  return createPaymentsApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/marketplace"),
    fetch: createForwardedAuthFetch(request),
  });
}
