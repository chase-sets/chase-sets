import {
  createForwardedAuthFetch,
  resolveRequestApiBaseUrl,
} from "@chase-sets/platform-runtime/http";
export {
  createInventoryApiClient,
  InventoryApiError,
  inventoryApi,
} from "../../client";
export type {
  InventoryApiClientOptions,
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
  InventoryStorageLocation,
} from "../../client";
import { createInventoryApiClient } from "../../client";

export function createInventoryRequestApiClient(request: Request) {
  return createInventoryApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/inventory"),
    fetch: createForwardedAuthFetch(request),
  });
}
