import { hc } from "hono/client";
import { honoClientResource } from "@chase-sets/http/hono-client";
import { attachResponseMetadata, readApiErrorMessage, type ListResponse } from "@chase-sets/http/responses";
import type { buildInventoryApi } from "./api";
import type { InventoryCatalogItemSnapshot } from "./features/inventory-items/integrations/catalog/queries";
import type { InventoryImportBatch, InventoryImportBatchDetail } from "./features/import-batches/read-model/queries";
import type { ImportCsvRow } from "./features/import-batches/domain/csv";
import type { InventoryImportSourceProfile } from "./features/import-batches/domain/import-source-profiles";
import type { InventoryImportBatchJobStatus } from "./features/import-batches/api/runtime";
import type { InventoryAccountSellerSkuItemResolution } from "./features/import-batches/read-model/account-sku-mappings";

export type { InventoryCatalogItemSnapshot } from "./features/inventory-items/integrations/catalog/queries";
export type {
  InventoryImportBatch,
  InventoryImportBatchDetail,
  InventoryImportBatchRow,
} from "./features/import-batches/read-model/queries";
export type { ImportCsvRow } from "./features/import-batches/domain/csv";
export type { InventoryImportSourceProfile } from "./features/import-batches/domain/import-source-profiles";
export type { InventoryImportBatchJobStatus } from "./features/import-batches/api/runtime";
export type { InventoryAccountSellerSkuItemResolution } from "./features/import-batches/read-model/account-sku-mappings";
export type {
  InventoryItemDetail,
  InventoryEnsuredListingStock,
  InventoryItemListItem,
  InventoryListingStockSnapshot,
  InventoryHold,
  InventoryItemLedgerEntry,
} from "./features/inventory-items/api/contracts";
export type { InventoryStorageLocation } from "./features/storage-locations/api/contracts";
export type { InventoryRestockDecision } from "./features/restock-decisions/api/contracts";

import type {
  InventoryEnsuredListingStock,
  InventoryItemDetail,
  InventoryItemListItem,
} from "./features/inventory-items/api/contracts";
import type { InventoryStorageLocation } from "./features/storage-locations/api/contracts";
import type { InventoryRestockDecision } from "./features/restock-decisions/api/contracts";

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
  requestTimeoutMs?: number;
  recoverTransportErrorsAsGatewayTimeout?: boolean;
}

function resolveHeaders(headers?: HeadersInit | (() => HeadersInit)) {
  return typeof headers === "function" ? headers() : headers;
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new InventoryApiError(response.status, errorBody);
  }

  return attachResponseMetadata(await response.json(), response) as T;
}

function timeoutFetchSignal(timeoutMs: number, upstreamSignal?: AbortSignal) {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let removeUpstreamListener: (() => void) | null = null;
  const timeoutResponse = new Promise<Response>((resolve) => {
    timeout = setTimeout(() => {
      controller.abort();
      resolve(gatewayTimeoutResponse());
    }, timeoutMs);
  });

  if (upstreamSignal) {
    const abortFromUpstream = () => controller.abort();
    if (upstreamSignal.aborted) {
      controller.abort();
    } else {
      upstreamSignal.addEventListener("abort", abortFromUpstream, { once: true });
      removeUpstreamListener = () => upstreamSignal.removeEventListener("abort", abortFromUpstream);
    }
  }

  return {
    signal: controller.signal,
    wait: (request: Promise<Response>) => Promise.race([request, timeoutResponse]),
    cleanup: () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      removeUpstreamListener?.();
    },
  };
}

function gatewayTimeoutResponse() {
  return new Response(null, {
    status: 504,
    statusText: "Gateway Timeout",
  });
}

export function createInventoryApiClient({
  baseUrl = DEFAULT_BASE_URL,
  fetch = globalThis.fetch,
  headers: initialHeaders,
  credentials = "include",
  requestTimeoutMs,
  recoverTransportErrorsAsGatewayTimeout = false,
}: InventoryApiClientOptions = {}) {
  const configuredFetch: typeof globalThis.fetch = async (input, init = {}) => {
    const timeout =
      typeof requestTimeoutMs === "number" && Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0
        ? timeoutFetchSignal(requestTimeoutMs, init.signal ?? undefined)
        : null;

    try {
      const request = fetch(input, {
        ...init,
        credentials: init.credentials ?? credentials,
        ...(timeout ? { signal: timeout.signal } : {}),
      });
      return await (timeout ? timeout.wait(request) : request);
    } catch (error) {
      if (recoverTransportErrorsAsGatewayTimeout) {
        return gatewayTimeoutResponse();
      }

      throw error;
    } finally {
      timeout?.cleanup();
    }
  };
  const client = honoClientResource(
    hc<InventoryApiApp>(baseUrl, {
      fetch: configuredFetch,
    }),
  );
  const headers = resolveHeaders(initialHeaders);

  return {
    async listImportSources(): Promise<ListResponse<InventoryImportSourceProfile>> {
      return parseJsonResponse(
        await client["import-batches"].sources.$get({
          header: headers,
        }),
      );
    },
    async listImportBatches(query = ""): Promise<ListResponse<InventoryImportBatch>> {
      return parseJsonResponse(
        await client["import-batches"].$get({
          query: Object.fromEntries(new URLSearchParams(query)),
          header: headers,
        }),
      );
    },
    async createImportBatch(
      body: Readonly<{
        csvText?: string;
        parsedRows?: readonly ImportCsvRow[];
        sourceKey?: string;
        quantityMode?: string;
        defaultStorageLocationId?: string | null;
        sourceFilename?: string | null;
      }>,
    ): Promise<InventoryImportBatchJobStatus> {
      return parseJsonResponse(await client["import-batches"].$post({ json: body, header: headers }));
    },
    async getImportBatch(id: string): Promise<InventoryImportBatchDetail> {
      return parseJsonResponse(
        await client["import-batches"][":id"].$get({
          param: { id },
          header: headers,
        }),
      );
    },
    async commitImportBatch(id: string): Promise<InventoryImportBatchJobStatus> {
      return parseJsonResponse(
        await client["import-batches"][":id"].commit.$post({
          param: { id },
          header: headers,
        }),
      );
    },
    async resolveImportBatchRow(
      id: string,
      rowId: string,
      body: Readonly<{
        catalogItemId: string;
        selectedOptions: readonly { dimensionId: string; optionId: string }[];
        storageLocationId: string;
      }>,
    ): Promise<InventoryImportBatchDetail> {
      return parseJsonResponse(
        await client["import-batches"][":id"].rows[":rowId"].resolve.$post({
          param: { id, rowId },
          json: body,
          header: headers,
        }),
      );
    },
    async resolveAccountSkuMappingsToInventoryItems(
      sellerSkus: readonly string[],
    ): Promise<ListResponse<InventoryAccountSellerSkuItemResolution>> {
      return parseJsonResponse(
        await client["import-batches"]["account-sku-mappings"]["resolve-inventory-items"].$post({
          json: { sellerSkus },
          header: headers,
        }),
      );
    },
    async listItems(query = ""): Promise<ListResponse<InventoryItemListItem> & { limit: number; offset: number }> {
      return parseJsonResponse(
        await client.items.$get({
          query: Object.fromEntries(new URLSearchParams(query)),
          header: headers,
        }),
      );
    },
    async getItem(id: string): Promise<InventoryItemDetail> {
      return parseJsonResponse(await client.items[":id"].$get({ param: { id }, header: headers }));
    },
    async getCatalogItem(id: string): Promise<InventoryCatalogItemSnapshot> {
      return parseJsonResponse(
        await client["catalog-items"][":id"].$get({
          param: { id },
          header: headers,
        }),
      );
    },
    async searchCatalogItems(query = ""): Promise<ListResponse<InventoryCatalogItemSnapshot>> {
      return parseJsonResponse(
        await client["catalog-items"].$get({
          query: Object.fromEntries(new URLSearchParams(query)),
          header: headers,
        }),
      );
    },
    async createItem(body: Record<string, unknown>) {
      return parseJsonResponse(await client.items.$post({ json: body, header: headers }));
    },
    async ensureListingStock(body: Record<string, unknown>): Promise<InventoryEnsuredListingStock> {
      return parseJsonResponse(
        await client.items["listing-stock"].ensure.$post({
          json: body,
          header: headers,
        }),
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
    async listRestockDecisions(query = ""): Promise<ListResponse<InventoryRestockDecision>> {
      return parseJsonResponse(
        await client["restock-decisions"].$get({
          query: Object.fromEntries(new URLSearchParams(query)),
          header: headers,
        }),
      );
    },
    async createCheckoutReservation(body: Record<string, unknown>) {
      return parseJsonResponse(
        await client["checkout-reservations"].$post({
          json: body,
          header: headers,
        }),
      );
    },
    async extendCheckoutReservation(id: string, body: Record<string, unknown>) {
      return parseJsonResponse(
        await client["checkout-reservations"][":id"].extend.$post({
          param: { id },
          json: body,
          header: headers,
        }),
      );
    },
    async releaseCheckoutReservation(id: string, body: Record<string, unknown>) {
      return parseJsonResponse(
        await client["checkout-reservations"][":id"].release.$post({
          param: { id },
          json: body,
          header: headers,
        }),
      );
    },
    async recordRestockDecision(id: string, body: Record<string, unknown>) {
      return parseJsonResponse(
        await client["restock-decisions"][":id"].decision.$post({
          param: { id },
          json: body,
          header: headers,
        }),
      );
    },
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

export const inventoryApi = createInventoryApiClient();
