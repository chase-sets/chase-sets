import { createInventoryRequestApiClient } from "@chase-sets/inventory/server";
import type { BulkRepriceInventorySkuGateway } from "../../features/bulk-reprice-ingestion/api/runtime";

/**
 * The web-request-layer implementation of bulk reprice ingestion's
 * inventory port (m113 bulk reprice ingestion): an HTTP call to Inventory's batch SKU-resolution
 * endpoint, forwarding the inbound request's auth. Mirrors
 * `marketplace-listings.ts` in this same directory -- request-support is
 * the only place pricing is allowed to hold a cross-context request client
 * (`allowedContextDependencies` + `isAllowedServerSurfaceConsumer`, see
 * scripts/check-structure/run.mjs).
 */
export function createPricingInventorySkuGateway(request: Request): BulkRepriceInventorySkuGateway {
  const inventoryApi = createInventoryRequestApiClient(request);
  return {
    resolveSellerSkusToInventoryItems: async (sellerSkus) => {
      const result = await inventoryApi.resolveAccountSkuMappingsToInventoryItems(sellerSkus);
      return result.items;
    },
  };
}
