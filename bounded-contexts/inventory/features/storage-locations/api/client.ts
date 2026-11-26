import type { ListResponse } from "@chase-sets/http/responses";
import { parseJsonResponse, type InventoryClientTransport } from "./transport";
import type { InventoryStorageLocation } from "./contracts";

export function createStorageLocationClient({ client, headers }: InventoryClientTransport) {
  return {
    async listStorageLocations(query = ""): Promise<ListResponse<InventoryStorageLocation>> {
      return parseJsonResponse(
        await client["storage-locations"].$get({
          query: Object.fromEntries(new URLSearchParams(query)),
          header: headers,
        }),
      );
    },
    async createStorageLocation(body: Record<string, unknown>) {
      return parseJsonResponse(await client["storage-locations"].$post({ json: body, header: headers }));
    },
    async updateStorageLocation(id: string, body: Record<string, unknown>) {
      return parseJsonResponse(
        await client["storage-locations"][":id"].$patch({
          param: { id },
          json: body,
          header: headers,
        }),
      );
    },
  };
}
