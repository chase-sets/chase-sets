import {
  createInventoryRequestApiClient,
  type InventoryRecordListItem,
} from "@chase-sets/inventory/server";

export type { InventoryRecordListItem };

export function createMarketplaceInventoryRecordLookup(request: Request) {
  const api = createInventoryRequestApiClient(request);

  return {
    listRecords(query = "") {
      return api.listRecords(query);
    },
  };
}
