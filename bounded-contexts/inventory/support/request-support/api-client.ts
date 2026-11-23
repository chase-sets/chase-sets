import { inventoryRequestOptions, type InventoryRequestClientOptions } from "./request-options";
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

export function createInventoryRequestApiClient(request: Request, options?: InventoryRequestClientOptions) {
  return createInventoryApiClient(inventoryRequestOptions(request, options));
}
