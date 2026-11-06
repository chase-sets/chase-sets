export { createFulfillmentRequestApiClient } from "./support/request-support/api-client";
export { createSellerShippingSetupServices, createSellerCheckoutReadinessReader } from "./features/seller-checkout-readiness/api/runtime";
export type { SellerShippingSetupServices, SellerShippingSetupResult, SellerShippingOriginResolution } from "./features/seller-checkout-readiness/api/runtime";
export type { SellerShippingOrigin, SellerShippingSetupInput } from "./features/seller-checkout-readiness/domain/shipping-setup";
export type { SellerCheckoutReadinessOwner, SellerCheckoutReadinessKey, SellerCheckoutReadinessReader, SellerCheckoutReadinessResult } from "./features/seller-checkout-readiness/domain/contract";
/**
 * Support-safe shipment-by-reference lookups for the unified
 * support-reference router, assembled in the `platform-api` composition
 * root behind Platform Operations' `supportReferenceLookupCrossContext`
 * host port -- Platform Operations never imports Fulfillment's domain code directly.
 */
export {
  lookupShipmentBySupportId,
  lookupShipmentBySupportReference,
} from "./features/shipments/read-model/support-lookup";
export type { FulfillmentSupportLookupRow } from "./features/shipments/read-model/support-lookup";
export { createShipByAttentionSourceFromReadModel } from "./features/shipments/read-model/seller-attention-source";
