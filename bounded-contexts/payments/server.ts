import {
  createForwardedAuthFetch,
  resolveRequestApiBaseUrl,
} from "@chase-sets/platform-runtime/http";
export type {
  PaymentProcessorGateway,
  PaymentProcessorPublicConfig,
  PaymentProcessorWebhookEvent,
} from "./processor-gateway";
export { PaymentsDomainError } from "./common";
export { createFakePaymentProcessorGateway } from "./fake-gateway";
export { createStripePaymentProcessorGateway } from "./stripe-gateway";
import { createPaymentsApiClient } from "./request-support/api-client";

export function createPaymentsRequestApiClient(request: Request) {
  return createPaymentsApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/marketplace"),
    fetch: createForwardedAuthFetch(request),
  });
}
