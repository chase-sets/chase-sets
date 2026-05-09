import { hc } from "hono/client";
import type { HonoClientResource } from "@chase-sets/http/hono-client";
import type { ListResponse } from "@chase-sets/http/responses";
import { readApiErrorMessage } from "@chase-sets/http/responses";
import type { buildInventoryApi } from "./api";
import type { InventoryCatalogItemSnapshot } from "./features/inventory-items/integrations/catalog/queries";
import type {
  InventoryImportBatch,
  InventoryImportBatchDetail,
} from "./features/import-batches/read-model/queries";
import type { ImportCsvRow } from "./features/import-batches/domain/csv";

export type { InventoryCatalogItemSnapshot } from "./features/inventory-items/integrations/catalog/queries";
export type {
  InventoryImportBatch,
  InventoryImportBatchDetail,
  InventoryImportBatchRow,
} from "./features/import-batches/read-model/queries";
export type { ImportCsvRow } from "./features/import-batches/domain/csv";
export type {
  InventoryItemDetail,
  InventoryItemListItem,
  InventoryHold,
} from "./features/inventory-items/api/contracts";
export type { InventoryStorageLocation } from "./features/storage-locations/api/contracts";

import type {
  InventoryItemDetail,
  InventoryItemListItem,
} from "./features/inventory-items/api/contracts";
import type { InventoryStorageLocation } from "./features/storage-locations/api/contracts";

type InventoryApiApp = ReturnType<typeof buildInventoryApi>;

const DEFAULT_BASE_URL = "/api/inventory";

export class InventoryApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(readApiErrorMessage(body, `API error ${status}`));
  }
}

export interface InventoryApiClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit | (() => HeadersInit);
  credentials?: RequestCredentials;
}

function resolveHeaders(headers?: HeadersInit | (() => HeadersInit)) {
  return typeof headers === "function" ? headers() : headers;
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new InventoryApiError(response.status, errorBody);
  }

  return response.json() as Promise<T>;
}

export function createInventoryApiClient({
  baseUrl = DEFAULT_BASE_URL,
  fetch = globalThis.fetch,
  headers: initialHeaders,
  credentials = "include",
}: InventoryApiClientOptions = {}) {
  const configuredFetch: typeof globalThis.fetch = (input, init = {}) =>
    fetch(input, {
      ...init,
      credentials: init.credentials ?? credentials,
    });
  const client = hc<InventoryApiApp>(baseUrl, {
    fetch: configuredFetch,
  }) as unknown as HonoClientResource;
  const headers = resolveHeaders(initialHeaders);

  return {
    async listImportBatches(query = ""): Promise<ListResponse<InventoryImportBatch>> {
      return parseJsonResponse(
        await client["import-batches"].$get({
          query: Object.fromEntries(new URLSearchParams(query)),
          header: headers,
        }),
      );
    },
    async createImportBatch(body: Readonly<{
      csvText?: string;
      parsedRows?: readonly ImportCsvRow[];
      sourceFilename?: string | null;
    }>): Promise<InventoryImportBatchDetail> {
      return parseJsonResponse(
        await client["import-batches"].$post({ json: body, header: headers }),
      );
    },
    async getImportBatch(id: string): Promise<InventoryImportBatchDetail> {
      return parseJsonResponse(
        await client["import-batches"][":id"].$get({
          param: { id },
          header: headers,
        }),
      );
    },
    async commitImportBatch(id: string): Promise<InventoryImportBatchDetail> {
      return parseJsonResponse(
        await client["import-batches"][":id"].commit.$post({
          param: { id },
          header: headers,
        }),
      );
    },
    async listItems(query = ""): Promise<ListResponse<InventoryItemListItem>> {
      return parseJsonResponse(
        await client.items.$get({
          query: Object.fromEntries(new URLSearchParams(query)),
          header: headers,
        }),
      );
    },
    async getItem(id: string): Promise<InventoryItemDetail> {
      return parseJsonResponse(
        await client.items[":id"].$get({ param: { id }, header: headers }),
      );
    },
    async getCatalogItem(id: string): Promise<InventoryCatalogItemSnapshot> {
      return parseJsonResponse(
        await client["catalog-items"][":id"].$get({
          param: { id },
          header: headers,
        }),
      );
    },
    async createItem(body: Record<string, unknown>) {
      return parseJsonResponse(
        await client.items.$post({ json: body, header: headers }),
      );
    },
    async adjustItem(id: string, body: Record<string, unknown>) {
      return parseJsonResponse(
        await client.items[":id"].adjustments.$post({
          param: { id },
          json: body,
          header: headers,
        }),
      );
    },
    async createHold(id: string, body: Record<string, unknown>) {
      return parseJsonResponse(
        await client.items[":id"].holds.$post({
          param: { id },
          json: body,
          header: headers,
        }),
      );
    },
    async releaseHold(id: string, body: Record<string, unknown> = {}) {
      return parseJsonResponse(
        await client.holds[":id"].release.$post({
          param: { id },
          json: body,
          header: headers,
        }),
      );
    },
    async listStorageLocations(
      query = "",
    ): Promise<ListResponse<InventoryStorageLocation>> {
      return parseJsonResponse(
        await client["storage-locations"].$get({
          query: Object.fromEntries(new URLSearchParams(query)),
          header: headers,
        }),
      );
    },
    async createStorageLocation(body: Record<string, unknown>) {
      return parseJsonResponse(
        await client["storage-locations"].$post({ json: body, header: headers }),
      );
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

export const inventoryApi = createInventoryApiClient();
