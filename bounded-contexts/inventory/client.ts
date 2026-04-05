import { hc } from "hono/client";
import type { ListResponse } from "@chase-sets/http/responses";
import type { buildInventoryApi } from "./api";
import type { InventoryCatalogItemSnapshot } from "./catalog-items/queries";

export type { InventoryCatalogItemSnapshot } from "./catalog-items/queries";
export type {
  InventoryRecordDetail,
  InventoryRecordListItem,
  InventoryHold,
} from "./records/client/contracts";
export type { InventoryStorageLocation } from "./storage-locations/client/contracts";

import type {
  InventoryRecordDetail,
  InventoryRecordListItem,
} from "./records/client/contracts";
import type { InventoryStorageLocation } from "./storage-locations/client/contracts";

type InventoryApiApp = ReturnType<typeof buildInventoryApi>;

const DEFAULT_BASE_URL = "/api/inventory";

export class InventoryApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(
      typeof body === "object" && body !== null && "error" in body
        ? String((body as Record<string, unknown>).error)
        : `API error ${status}`,
    );
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
  const client = hc<InventoryApiApp>(baseUrl, { fetch: configuredFetch }) as any;
  const headers = resolveHeaders(initialHeaders);

  return {
    async listRecords(query = ""): Promise<ListResponse<InventoryRecordListItem>> {
      return parseJsonResponse(
        await client.records.$get({
          query: Object.fromEntries(new URLSearchParams(query)),
          header: headers,
        }),
      );
    },
    async getRecord(id: string): Promise<InventoryRecordDetail> {
      return parseJsonResponse(
        await client.records[":id"].$get({ param: { id }, header: headers }),
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
    async createRecord(body: Record<string, unknown>) {
      return parseJsonResponse(
        await client.records.$post({ json: body, header: headers }),
      );
    },
    async adjustRecord(id: string, body: Record<string, unknown>) {
      return parseJsonResponse(
        await client.records[":id"].adjustments.$post({
          param: { id },
          json: body,
          header: headers,
        }),
      );
    },
    async createHold(id: string, body: Record<string, unknown>) {
      return parseJsonResponse(
        await client.records[":id"].holds.$post({
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
