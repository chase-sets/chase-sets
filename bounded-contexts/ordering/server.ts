export { createOrderingRequestApiClient, OrderingApiError } from "./support/request-support/api-client";
export type { CheckoutFulfillmentPreview, PurchaseDetail, SaleDetail } from "./support/request-support/api-client";
export { createOrderingUcpHandlers } from "./support/ucp-support/orders";
export { resolveOrderRecipient, resolveShipmentOrderId } from "./features/orders/read-model/queries";
/**
 * Support-safe order-by-reference lookups for the unified support-reference
 * router, assembled in the `platform-api` composition root behind
 * Platform Operations' `supportReferenceLookupCrossContext` host port --
 * Platform Operations never imports Ordering's domain code directly.
 */
export { lookupOrderBySupportId, lookupOrderBySupportReference } from "./features/orders/read-model/support-lookup";
export type { OrderingSupportLookupRow } from "./features/orders/read-model/support-lookup";
export { createLocalTaxQuoteResolver, zeroTaxQuoteResolver } from "./features/tax-quotes/domain/tax-quote";
export type {
  LocalTaxRule,
  TaxDestinationAddress,
  TaxQuote,
  TaxQuoteInput,
  TaxQuoteResolver,
} from "./features/tax-quotes/domain/tax-quote";
