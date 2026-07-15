import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
export type { BalanceCreditResolver, BalanceCreditResolution } from "./features/payments/api/balance-credit-resolver";
export { normalizeRequestedBalanceCreditAmount } from "./features/payments/api/balance-credit-request";
export type { PaymentServices } from "./features/payments/api/runtime";
export type { PaymentsCheckoutStatus } from "./features/payments/api/contracts";
export type { PaymentsPaymentDetail } from "./features/payments/api/contracts";
export type { PaymentElementDefaultValues } from "./features/payments/ui/account-payment/account-payment-contracts";
export {
  marketplaceCheckoutFeePaymentMethodCategories,
  normalizeMarketplaceCheckoutFeePaymentMethodCategory,
  quoteMarketplaceCheckoutFee,
} from "./features/payments/api/marketplace-checkout-fee-policy";
export type {
  MarketplaceCheckoutFeePaymentMethodCategory,
  MarketplaceCheckoutFeeQuote,
} from "./features/payments/api/marketplace-checkout-fee-policy";
export type { PaymentsSavedCheckoutInstrument } from "./client";
export type { PaymentsServices } from "./support/runtime-support/services";
export type {
  PaymentProcessorGateway,
  PaymentProcessorPublicConfig,
  PaymentProcessorWebhookEvent,
} from "@chase-sets/payment-processing";
export { PaymentsDomainError } from "./support/runtime-support/common";
export { createPaymentsUcpHandoff } from "./support/ucp-support/payment-handlers";
export { createRemoteUcpAp2MandateVerifier } from "./support/ucp-support/ap2-mandate-verifier";
export type { UcpAp2MandateVerifier, UcpPaymentHandlerHandoff } from "./support/ucp-support/payment-handlers";
export type { RemoteUcpAp2MandateVerifierConfig } from "./support/ucp-support/ap2-mandate-verifier";
import {
  createPaymentsApiClient,
  createPaymentsRequestApiHeaders,
  type PaymentsRequestApiClientOptions,
} from "./support/request-support/api-client";
export { hasPaymentsFreshReadAfterWriteSource } from "./support/request-support/api-client";

export function createPaymentsRequestApiClient(request: Request, options: PaymentsRequestApiClientOptions = {}) {
  return createPaymentsApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/marketplace"),
    fetch: createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "payments" }),
    headers: createPaymentsRequestApiHeaders(options),
  });
}
