import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
import type { InventoryApiClientOptions } from "./client";
export { createInventoryApiClient, InventoryApiError, inventoryApi } from "../../client";
export type {
  InventoryApiClientOptions,
  InventoryAccountSellerSkuItemResolution,
  InventoryCatalogItemSnapshot,
  InventoryImportBatch,
  InventoryImportBatchDetail,
  InventoryImportBatchRow,
  ImportCsvRow,
  InventoryHold,
  InventoryEnsuredListingStock,
  InventoryItemDetail,
  InventoryItemListItem,
  InventoryListingStockSnapshot,
  InventoryOfflineSaleRequest,
  InventoryOfflineSaleResult,
  InventoryRestockDecision,
  InventoryRecoveredItemRow,
  InventoryStorageLocation,
} from "../../client";
import { createInventoryApiClient } from "../../client";

export type InventoryRequestClientOptions = Pick<
  InventoryApiClientOptions,
  "requestTimeoutMs" | "recoverTransportErrorsAsGatewayTimeout" | "mutationAttemptId"
>;

export function inventoryRequestOptions(
  request: Request,
  options: InventoryRequestClientOptions = {},
): InventoryApiClientOptions {
  return {
    baseUrl: resolveRequestApiBaseUrl(request, "/api/inventory"),
    fetch: createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "inventory" }),
    ...options,
  };
}

export function createInventoryRequestApiClient(request: Request, options?: InventoryRequestClientOptions) {
  return createInventoryApiClient(inventoryRequestOptions(request, options));
}
