import {
  createForwardedAuthFetch,
  resolveRequestApiBaseUrl,
} from "@chase-sets/platform-runtime/http";
export type {
  BalanceCreditResolver,
  BalanceCreditResolution,
} from "./features/payments/api/balance-credit-resolver";
export { normalizeRequestedBalanceCreditAmount } from "./features/payments/api/balance-credit-request";
export type {
  PaymentProcessorGateway,
  PaymentProcessorPublicConfig,
  PaymentProcessorWebhookEvent,
} from "./support/runtime-support/processor-gateway";
export { PaymentsDomainError } from "./support/runtime-support/common";
export { createFakePaymentProcessorGateway } from "./support/runtime-support/fake-gateway";
export { createStripePaymentProcessorGateway } from "./support/runtime-support/stripe-gateway";
import { createPaymentsApiClient } from "./support/request-support/api-client";

export function createPaymentsRequestApiClient(request: Request) {
  return createPaymentsApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/marketplace"),
    fetch: createForwardedAuthFetch(request),
  });
}
