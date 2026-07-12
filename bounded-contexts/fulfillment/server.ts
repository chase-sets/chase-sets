export { createFulfillmentRequestApiClient } from "./support/request-support/api-client";
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
