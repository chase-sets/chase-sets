import {
  createForwardedAuthFetch,
  resolveRequestApiBaseUrl,
} from "@chase-sets/bounded-context-runtime";
export type {
  PaymentProcessorGateway,
  PaymentProcessorPublicConfig,
  PaymentProcessorWebhookEvent,
} from "./processor-gateway";
export { PaymentsDomainError } from "./common";
import { createPaymentsApiClient } from "./client";

export function createPaymentsRequestApiClient(request: Request) {
  return createPaymentsApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/marketplace"),
    fetch: createForwardedAuthFetch(request),
  });
}
