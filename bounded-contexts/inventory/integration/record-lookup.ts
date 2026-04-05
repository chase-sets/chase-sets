import { createInventoryRequestApiClient } from "../request-support/api-client";
export type { InventoryRecordListItem } from "../records/client/contracts";

export function createInventoryRecordLookupPort(request: Request) {
  const api = createInventoryRequestApiClient(request);

  return {
    listRecords(query = "") {
      return api.listRecords(query);
    },
  };
}
