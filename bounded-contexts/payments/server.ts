import {
  createForwardedAuthFetch,
  resolveRequestApiBaseUrl,
} from "@chase-sets/platform-runtime/http";
export type {
  BalanceCreditResolver,
  BalanceCreditResolution,
} from "./features/payments/api/balance-credit-resolver";
export { normalizeRequestedBalanceCreditAmount } from "./features/payments/api/balance-credit-request";
export type { PaymentServices } from "./features/payments/api/runtime";
export type { PaymentsServices } from "./support/runtime-support/services";
export type {
  PaymentProcessorGateway,
  PaymentProcessorPublicConfig,
  PaymentProcessorWebhookEvent,
} from "@chase-sets/payment-processing";
export { PaymentsDomainError } from "./support/runtime-support/common";
export { createPaymentsUcpHandoff } from "./support/ucp-support/payment-handlers";
export type { UcpPaymentHandlerHandoff } from "./support/ucp-support/payment-handlers";
import { createPaymentsApiClient } from "./support/request-support/api-client";

export function createPaymentsRequestApiClient(request: Request) {
  return createPaymentsApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/marketplace"),
    fetch: createForwardedAuthFetch(request),
  });
}
