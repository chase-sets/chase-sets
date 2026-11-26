import type { ListResponse } from "@chase-sets/http/responses";
import { createStorageLocationClient } from "./features/storage-locations/api/client";
import {
  createInventoryClientTransport,
  parseJsonResponse,
  type InventoryApiClientOptions,
} from "./features/storage-locations/api/transport";
import type { InventoryMutationReceipt } from "./support/runtime-support/mutation-attempt";
import type { InventoryCatalogItemSnapshot } from "./features/inventory-items/integrations/catalog/queries";
import type {
  InventoryImportBatch,
  InventoryImportBatchDetail,
  InventoryImportBatchResolution,
} from "./features/import-batches/read-model/queries";
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
  InventoryAdjustItemRequest,
  InventoryCreateItemRequest,
  InventoryItemDetail,
  InventoryEnsuredListingStock,
  InventoryItemListItem,
  InventoryListingStockSnapshot,
  InventoryHold,
  InventoryItemLedgerEntry,
  InventoryOfflineSaleRequest,
  InventoryOfflineSaleResult,
} from "./features/inventory-items/api/contracts";
export { inventoryOfflineSaleChannels } from "@chase-sets/event-core/public-event-payloads";
export type { InventoryOfflineSaleChannel } from "@chase-sets/event-core/public-event-payloads";
export type { InventoryStorageLocation } from "./features/storage-locations/api/contracts";
export type { InventoryRestockDecision } from "./features/restock-decisions/api/contracts";
export type { InventoryRecoveredItemRow } from "./features/recovered-items/read-model/queries";

import type {
  InventoryAdjustItemRequest,
  InventoryCreateItemRequest,
  InventoryEnsuredListingStock,
  InventoryItemDetail,
  InventoryItemListItem,
  InventoryOfflineSaleRequest,
  InventoryOfflineSaleResult,
} from "./features/inventory-items/api/contracts";
import type { InventoryRestockDecision, RecordRestockDecisionInput } from "./features/restock-decisions/api/contracts";
import type { InventoryRecoveredItemRow } from "./features/recovered-items/read-model/queries";

export { InventoryApiError } from "./features/storage-locations/api/transport";
export type { InventoryApiClientOptions } from "./features/storage-locations/api/transport";

export function createInventoryApiClient(options: InventoryApiClientOptions = {}) {
  const transport = createInventoryClientTransport(options);
  const { client, headers } = transport;

  return {
    async getMutationAttempt(id: string): Promise<InventoryMutationReceipt | null> {
      const response = await client["mutation-attempts"][":id"].$get({ param: { id }, header: headers });
      if (response.status === 404) return null;
      return parseJsonResponse<InventoryMutationReceipt>(response);
    },
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
    async getImportBatch(id: string, query = ""): Promise<InventoryImportBatchDetail> {
      return parseJsonResponse(
        await client["import-batches"][":id"].$get({
          param: { id },
          query: Object.fromEntries(new URLSearchParams(query)),
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
        expectedRowVersion: string;
        expectedRowFingerprint: string;
      }>,
    ): Promise<InventoryImportBatchResolution> {
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
    async createItem(body: InventoryCreateItemRequest) {
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
    async adjustItem(id: string, body: InventoryAdjustItemRequest) {
      return parseJsonResponse(
        await client.items[":id"].adjustments.$post({
          param: { id },
          json: body,
          header: headers,
        }),
      );
    },
    async recordOfflineSale(id: string, body: InventoryOfflineSaleRequest): Promise<InventoryOfflineSaleResult> {
      return parseJsonResponse(
        await client.items[":id"]["offline-sales"].$post({
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
    async listRecoveredItems(query = ""): Promise<ListResponse<InventoryRecoveredItemRow>> {
      return parseJsonResponse(
        await client["recovered-items"].$get({
          query: Object.fromEntries(new URLSearchParams(query)),
          header: headers,
        }),
      );
    },
    async getRecoveredItem(
      id: string,
    ): Promise<InventoryRecoveredItemRow & { audit: readonly unknown[]; values: readonly unknown[] }> {
      return parseJsonResponse(await client["recovered-items"][":id"].$get({ param: { id }, header: headers }));
    },
    async getRecoveredItemMetrics(): Promise<Record<string, string | number>> {
      return parseJsonResponse(await client["recovered-items"].metrics.$get({ header: headers }));
    },
    async executeRecoveredItemAction(id: string, body: Record<string, unknown>) {
      return parseJsonResponse(
        await client["recovered-items"][":id"].actions.$post({ param: { id }, json: body, header: headers }),
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
    async extendCheckoutReservation(id: string, body: Readonly<{ checkoutSessionId: string; lineKey?: string }>) {
      return parseJsonResponse(
        await client["checkout-reservations"][":id"].extend.$post({
          param: { id },
          json: body,
          header: headers,
        }),
      );
    },
    async releaseCheckoutReservation(id: string, body: Readonly<{ checkoutSessionId: string; lineKey?: string }>) {
      return parseJsonResponse(
        await client["checkout-reservations"][":id"].release.$post({
          param: { id },
          json: body,
          header: headers,
        }),
      );
    },
    async recordRestockDecision(id: string, body: RecordRestockDecisionInput) {
      return parseJsonResponse(
        await client["restock-decisions"][":id"].decision.$post({
          param: { id },
          json: body,
          header: headers,
        }),
      );
    },
    ...createStorageLocationClient(transport),
  };
}

export const inventoryApi = createInventoryApiClient();
