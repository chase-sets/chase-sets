import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
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
  InventoryRestockDecision,
  InventoryStorageLocation,
} from "../../client";
import { createInventoryApiClient, type InventoryApiClientOptions } from "../../client";

export function createInventoryRequestApiClient(
  request: Request,
  options: Pick<InventoryApiClientOptions, "requestTimeoutMs" | "recoverTransportErrorsAsGatewayTimeout"> = {},
) {
  return createInventoryApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/inventory"),
    fetch: createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "inventory" }),
    ...options,
  });
}
