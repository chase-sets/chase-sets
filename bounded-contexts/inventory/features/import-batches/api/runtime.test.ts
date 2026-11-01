import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type {
  PgQueryResult,
  PgQueryable,
  PgTransactionalPool,
  PostgresEventStore,
} from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId, InventoryItemId } from "@chase-sets/primitives/typed-ids";
import { inventoryDraftListingMessageSchema } from "@chase-sets/inventory-draft-listing";
import type { InventoryCatalogItemServices } from "../../inventory-items/integrations/catalog/runtime";
import type {
  InventoryProductSchema,
  InventorySelectedOptionEntry,
} from "../../inventory-items/integrations/catalog/versioning";
import type { InventoryItemServices } from "../../inventory-items/api/runtime";
import {
  createInventoryImportBatchRuntime,
  createInventoryImportRowValidator,
  type CreateInventoryImportBatch,
  serializeCreateBatchInputForIdempotency,
  shouldDeferImportBatchParentClaimForCreateUnitMiss,
} from "./runtime";
import { inventoryImportBatchSchemaSql, inventoryImportBatchSchemaMigrations } from "../read-model/schema";
import { inventoryImportSourceProfiles, type InventoryImportSourceKey } from "../domain/import-source-profiles";
import { readFileSync } from "node:fs";
import { prepareInventoryImportSnapshot } from "./safe-snapshot";
import { contractInventoryImportSources } from "./source-migration";
import type { InventoryImportBatchStatus } from "../read-model/queries";
import { ImportRowResolveConflict } from "../domain/row-resolve-conflict";
import { inventoryImportBatchRoutes } from "./route";
import type { InventoryApiEnv } from "../../../api";
import { createInventoryMutationRuntime } from "../../../support/runtime-support/mutation-attempt";

type StoredBatch = Readonly<{
  batch_id: string;
  account_id: string;
  status: InventoryImportBatchStatus;
  source_key: string;
  adapter_version: number;
  quantity_mode: "add" | "replace";
  default_storage_location_id: string | null;
  total_count: number;
  accepted_count: number;
  rejected_count: number;
  committed_count: number;
  created_at: string;
  updated_at: string;
}>;

type StoredRow = Readonly<{
  row_id: string;
  batch_id: string;
  row_number: number;
  status: "accepted" | "rejected" | "committed";
  raw_row: Readonly<Record<string, string>>;
  external_reference: unknown;
  row_fingerprint: string;
  quantity_mode: "add" | "replace";
  quantity_delta: number | null;
  set_quantity: number | null;
  source_price_amount: string | null;
  resolution_status: "native" | "resolved" | "unresolved";
  catalog_item_id: string | null;
  product_id: string | null;
  selected_options: readonly InventorySelectedOptionEntry[];
  storage_location_id: string | null;
  total_quantity: number | null;
  acquisition_occurred_at: string | null;
  acquisition_cost_amount: string | null;
  acquisition_cost_currency_code: string | null;
  seller_sku: string | null;
  listing_price_amount: string | null;
  listing_price_currency_code: string | null;
  listing_quantity_cap: number | null;
  row_note: string | null;
  validation_errors: readonly string[];
  committed_inventory_item_id: string | null;
  committed_listing_id: string | null;
  committed_at: string | null;
  created_at: string;
  updated_at: string;
}>;

type StoredLocation = Readonly<{
  storage_location_id: string;
  account_id: string;
  name: string;
  description: string | null;
  ship_from_code: string;
  ship_from_address?: Readonly<{
    name: string;
    line1: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  }>;
  is_archived: boolean;
  updated_at: string;
}>;

type StoredInventoryItem = Readonly<{
  item_id: string;
  account_id: string;
  catalog_catalog_item_id: string;
  product_id?: string;
  storage_location_id: string;
  total_quantity: number;
  selected_options: readonly InventorySelectedOptionEntry[];
  acquisition_cost_amount: string | null;
  acquisition_cost_currency_code: string | null;
  updated_at: string;
}>;

type StoredAccountSkuMapping = Readonly<{
  mapping_id: string;
  account_id: string;
  seller_sku: string;
  normalized_seller_sku: string;
  catalog_item_id: string;
  selected_options: readonly InventorySelectedOptionEntry[];
  updated_at: string;
}>;

const now = "2026-05-09T00:00:00.000Z";

/** Mirrors the `to_char(... 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` row_version projection. */
function rowVersionOf(updatedAt: string) {
  return new Date(updatedAt).toISOString().replace(/Z$/, "000Z");
}

function rowFacts(
  detail: Readonly<{ rows: readonly { row_id: string; row_version: string; row_fingerprint: string }[] }>,
  rowId: string,
) {
  const row = detail.rows.find((candidate) => candidate.row_id === rowId);
  if (!row) throw new Error(`Fixture row ${rowId} is missing.`);
  return { expectedRowVersion: row.row_version, expectedRowFingerprint: row.row_fingerprint };
}

const productSchema = {
  canonicalDimensionOrder: [{ dimensionId: "condition", dimensionName: "Condition" }],
  dimensions: [
    {
      dimensionId: "condition",
      dimensionName: "Condition",
      required: true,
      appliesWhen: [],
      allowedOptions: [{ optionId: "near_mint", code: "NM", label: "Near Mint" }],
    },
  ],
} satisfies InventoryProductSchema;

const formConditionProductSchema = {
  canonicalDimensionOrder: [
    { dimensionId: "dim_form", dimensionName: "Form" },
    { dimensionId: "dim_condition", dimensionName: "Condition" },
  ],
  dimensions: [
    {
      dimensionId: "dim_form",
      dimensionName: "Form",
      required: true,
      appliesWhen: [],
      allowedOptions: [
        { optionId: "opt_raw", code: "raw", label: "Raw" },
        { optionId: "opt_graded", code: "graded", label: "Graded" },
      ],
    },
    {
      dimensionId: "dim_condition",
      dimensionName: "Condition",
      required: true,
      appliesWhen: [{ dimensionId: "dim_form", optionIds: ["opt_raw"] }],
      allowedOptions: [
        { optionId: "opt_near_mint", code: "near-mint", label: "Near Mint" },
        { optionId: "opt_damaged", code: "damaged", label: "Damaged" },
      ],
    },
  ],
} satisfies InventoryProductSchema;

class ImportBatchDb implements PgQueryable {
  public readonly queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  public readonly batches = new Map<string, StoredBatch>();
  public rows: StoredRow[] = [];
  public readonly locations = new Map<string, StoredLocation>();
  public readonly items = new Map<string, StoredInventoryItem>();
  public accountSkuMappings: StoredAccountSkuMapping[] = [];
  private resolveWrites = 0;

  public async query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    this.queries.push({ sql, values });

    if (sql.includes("FROM inventory_import_account_sku_mappings")) {
      const accountId = String(values[0]);
      const normalizedSellerSku = String(values[1]);
      const rows = this.accountSkuMappings
        .filter((mapping) => mapping.account_id === accountId && mapping.normalized_seller_sku === normalizedSellerSku)
        .sort(
          (left, right) =>
            right.updated_at.localeCompare(left.updated_at) ||
            left.seller_sku.localeCompare(right.seller_sku) ||
            left.catalog_item_id.localeCompare(right.catalog_item_id),
        );
      return this.result(rows as Row[]);
    }

    if (sql.includes("UPDATE inventory_import_account_sku_mappings")) {
      const mappingId = String(values[0]);
      const accountId = String(values[5]);
      this.accountSkuMappings = this.accountSkuMappings.map((mapping) =>
        mapping.mapping_id === mappingId && mapping.account_id === accountId
          ? {
              ...mapping,
              seller_sku: String(values[1]),
              normalized_seller_sku: String(values[2]),
              catalog_item_id: String(values[3]),
              selected_options: JSON.parse(String(values[4])) as InventorySelectedOptionEntry[],
              updated_at: now,
            }
          : mapping,
      );
      return this.result([]);
    }

    if (sql.includes("INSERT INTO inventory_import_account_sku_mappings")) {
      this.accountSkuMappings = [
        ...this.accountSkuMappings,
        {
          mapping_id: String(values[0]),
          account_id: String(values[1]),
          seller_sku: String(values[2]),
          normalized_seller_sku: String(values[3]),
          catalog_item_id: String(values[4]),
          selected_options: JSON.parse(String(values[5])) as InventorySelectedOptionEntry[],
          updated_at: now,
        },
      ];
      return this.result([]);
    }

    if (sql.includes("FROM inventory_storage_locations") && sql.includes("storage_location_id = $1")) {
      const location = this.locations.get(String(values[0]));
      const rows = location && (!values[1] || location.account_id === values[1]) ? [location] : [];
      return this.result(rows as Row[]);
    }

    if (sql.includes("FROM inventory_storage_locations") && sql.includes("account_id = $1")) {
      const accountId = String(values[0]);
      const rows = [...this.locations.values()]
        .filter((location) => location.account_id === accountId)
        .filter((location) => !sql.includes("is_archived = false") || !location.is_archived)
        .sort(
          (left, right) => Number(left.is_archived) - Number(right.is_archived) || left.name.localeCompare(right.name),
        );
      return this.result(rows as Row[]);
    }

    if (sql.includes("item.catalog_catalog_item_id AS catalog_item_id")) {
      const accountId = String(values[0]);
      const rows = [...this.items.values()]
        .filter((item) => item.account_id === accountId)
        .sort(
          (left, right) => right.updated_at.localeCompare(left.updated_at) || left.item_id.localeCompare(right.item_id),
        )
        .map((item) => ({
          catalog_item_id: item.catalog_catalog_item_id,
          storage_location_id: item.storage_location_id,
          total_quantity: item.total_quantity,
          selected_options: item.selected_options,
          acquisition_cost_amount: item.acquisition_cost_amount,
          acquisition_cost_currency_code: item.acquisition_cost_currency_code,
        }));
      return this.result(rows as Row[]);
    }

    if (sql.includes("FROM inventory_items AS item")) {
      const selectedOptions = String(values[3] ?? "[]");
      const rows = [...this.items.values()]
        .filter((item) => item.account_id === values[0])
        .filter((item) => item.catalog_catalog_item_id === values[1])
        .filter((item) => item.product_id === undefined || item.product_id === values[2])
        .filter((item) => JSON.stringify(item.selected_options) === selectedOptions)
        .filter((item) => item.storage_location_id === values[4])
        .map((item) => ({ item_id: item.item_id, total_quantity: item.total_quantity, held_quantity: 0 }));
      return this.result(rows as Row[]);
    }

    if (sql.includes("INSERT INTO inventory_import_batches")) {
      const batch = {
        batch_id: String(values[0]),
        account_id: String(values[1]),
        status: "uploaded",
        source_key: values[2] as StoredBatch["source_key"],
        adapter_version: Number(values[3]),
        quantity_mode: values[4] as StoredBatch["quantity_mode"],
        default_storage_location_id: typeof values[5] === "string" ? values[5] : null,
        total_count: 0,
        accepted_count: 0,
        rejected_count: 0,
        committed_count: 0,
        created_at: now,
        updated_at: now,
      } satisfies StoredBatch;
      this.batches.set(batch.batch_id, batch);
      return this.result([]);
    }

    if (sql.includes("INSERT INTO inventory_import_batch_rows")) {
      this.rows = [
        ...this.rows,
        {
          row_id: String(values[0]),
          batch_id: String(values[1]),
          row_number: Number(values[2]),
          status: values[3] as StoredRow["status"],
          raw_row: JSON.parse(String(values[4])) as Record<string, string>,
          external_reference: typeof values[5] === "string" ? JSON.parse(String(values[5])) : null,
          row_fingerprint: String(values[6]),
          quantity_mode: values[7] as StoredRow["quantity_mode"],
          quantity_delta: typeof values[8] === "number" ? values[8] : null,
          set_quantity: typeof values[9] === "number" ? values[9] : null,
          source_price_amount: typeof values[10] === "string" ? values[10] : null,
          resolution_status: values[11] as StoredRow["resolution_status"],
          catalog_item_id: typeof values[12] === "string" ? values[12] : null,
          product_id: typeof values[13] === "string" ? values[13] : null,
          selected_options: JSON.parse(String(values[14])) as InventorySelectedOptionEntry[],
          storage_location_id: typeof values[15] === "string" ? values[15] : null,
          total_quantity: typeof values[16] === "number" ? values[16] : null,
          acquisition_occurred_at: typeof values[17] === "string" ? new Date(values[17]).toISOString() : null,
          acquisition_cost_amount: typeof values[18] === "string" ? values[18] : null,
          acquisition_cost_currency_code:
            typeof (JSON.parse(String(values[4])) as Record<string, unknown>).acquisitionCostCurrencyCode === "string"
              ? String((JSON.parse(String(values[4])) as Record<string, unknown>).acquisitionCostCurrencyCode)
              : null,
          seller_sku: typeof values[19] === "string" ? values[19] : null,
          listing_price_amount: typeof values[20] === "string" ? values[20] : null,
          listing_price_currency_code:
            typeof (JSON.parse(String(values[4])) as Record<string, unknown>).listingPriceCurrencyCode === "string"
              ? String((JSON.parse(String(values[4])) as Record<string, unknown>).listingPriceCurrencyCode)
              : null,
          listing_quantity_cap: typeof values[21] === "number" ? values[21] : null,
          row_note: typeof values[22] === "string" ? values[22] : null,
          validation_errors: JSON.parse(String(values[23])) as string[],
          committed_inventory_item_id: null,
          committed_listing_id: null,
          committed_at: null,
          created_at: now,
          updated_at: now,
        },
      ];
      return this.result([]);
    }

    if (sql.includes("UPDATE inventory_import_batches AS batch")) {
      this.refreshBatch(String(values[0]));
      return this.result([]);
    }

    if (sql.includes("UPDATE inventory_import_batch_rows") && sql.includes("resolution_status = 'resolved'")) {
      const rowId = String(values[0]);
      // Each fence predicate applies only when the SQL carries it, so a mutant that drops one is observable.
      const fenced = (row: StoredRow) =>
        row.row_id === rowId &&
        row.batch_id === values[20] &&
        (!sql.includes("status <> 'committed'") || row.status !== "committed") &&
        (!sql.includes("updated_at = $22::timestamptz") || rowVersionOf(row.updated_at) === values[21]) &&
        (!sql.includes("row_fingerprint = $23") || row.row_fingerprint === values[22]) &&
        (!sql.includes("batch.account_id = $24") || this.batches.get(row.batch_id)?.account_id === values[23]);
      const matched = this.rows.find(fenced);
      const writtenAt = new Date(Date.parse(now) + ++this.resolveWrites).toISOString();
      this.rows = this.rows.map((row) =>
        row === matched
          ? {
              ...row,
              status: values[1] as StoredRow["status"],
              external_reference: typeof values[2] === "string" ? JSON.parse(String(values[2])) : null,
              row_fingerprint: String(values[3]),
              quantity_mode: values[4] as StoredRow["quantity_mode"],
              quantity_delta: typeof values[5] === "number" ? values[5] : null,
              set_quantity: typeof values[6] === "number" ? values[6] : null,
              source_price_amount: typeof values[7] === "string" ? values[7] : null,
              resolution_status: "resolved",
              catalog_item_id: String(values[8]),
              product_id: String(values[9]),
              selected_options: JSON.parse(String(values[10])) as InventorySelectedOptionEntry[],
              storage_location_id: String(values[11]),
              total_quantity: typeof values[12] === "number" ? values[12] : null,
              acquisition_occurred_at: typeof values[13] === "string" ? new Date(values[13]).toISOString() : null,
              acquisition_cost_amount: typeof values[14] === "string" ? values[14] : null,
              seller_sku: typeof values[15] === "string" ? values[15] : null,
              listing_price_amount: typeof values[16] === "string" ? values[16] : null,
              listing_quantity_cap: typeof values[17] === "number" ? values[17] : null,
              row_note: typeof values[18] === "string" ? values[18] : null,
              validation_errors: JSON.parse(String(values[19])) as string[],
              updated_at: writtenAt,
            }
          : row,
      );
      return this.result(matched ? ([{ row_id: rowId }] as unknown as Row[]) : []);
    }

    if (sql.includes("UPDATE inventory_import_batch_rows")) {
      const rowId = String(values[0]);
      this.rows = this.rows.map((row) =>
        row.row_id === rowId
          ? {
              ...row,
              status: "committed",
              committed_inventory_item_id: String(values[1]),
              committed_listing_id: typeof values[2] === "string" ? values[2] : null,
              committed_at: row.committed_at ?? String(values[3] ?? now),
              updated_at: now,
            }
          : row,
      );
      return this.result([]);
    }

    if (sql.includes("INSERT INTO inventory_import_draft_listing_outbox")) {
      return this.result([]);
    }

    if (sql.includes("FROM inventory_import_batches") && sql.includes("COUNT(*)")) {
      const accountId = String(values[0]);
      return this.result([
        {
          count: String([...this.batches.values()].filter((batch) => batch.account_id === accountId).length),
        } as Row,
      ]);
    }

    if (sql.includes("FROM inventory_import_batches") && sql.includes("WHERE batch_id = $1")) {
      const batch = this.batches.get(String(values[0]));
      const rows = batch && batch.account_id === values[1] ? [batch] : [];
      return this.result(rows as Row[]);
    }

    if (
      sql.includes("FROM inventory_import_batch_rows") &&
      (sql.includes("WHERE batch_id = $1") ||
        sql.includes("WHERE rows.batch_id = $1") ||
        sql.includes("WHERE import_row.batch_id = $1"))
    ) {
      const rows = this.rows
        .filter((row) => row.batch_id === values[0])
        .sort((left, right) => left.row_number - right.row_number)
        .map((row) => (sql.includes("AS row_version") ? { ...row, row_version: rowVersionOf(row.updated_at) } : row));
      return this.result(
        (sql.includes("LIMIT $2 OFFSET $3")
          ? rows.slice(Number(values[2]), Number(values[2]) + Number(values[1]))
          : rows) as Row[],
      );
    }

    if (sql.includes("FROM inventory_import_batches")) {
      const accountId = String(values[0]);
      const rows = [...this.batches.values()].filter((batch) => batch.account_id === accountId);
      return this.result(rows as Row[]);
    }

    throw new Error(`Unexpected import batch query: ${sql}`);
  }

  private refreshBatch(batchId: string) {
    const batch = this.batches.get(batchId);
    if (!batch) {
      return;
    }

    const rows = this.rows.filter((row) => row.batch_id === batchId);
    const acceptedCount = rows.filter((row) => row.status === "accepted" || row.status === "committed").length;
    const committedCount = rows.filter((row) => row.status === "committed").length;
    const rejectedCount = rows.filter((row) => row.status === "rejected").length;
    this.batches.set(batchId, {
      ...batch,
      total_count: rows.length,
      accepted_count: acceptedCount,
      rejected_count: rejectedCount,
      committed_count: committedCount,
      status: rows.length > 0 && acceptedCount > 0 && committedCount === acceptedCount ? "committed" : "uploaded",
      updated_at: now,
    });
  }

  private result<Row>(rows: Row[]): PgQueryResult<Row> {
    return { rows, rowCount: rows.length };
  }
}

function catalogServices(): InventoryCatalogItemServices {
  return {
    getExternalProductReference: async (providerKey, externalKey) => {
      if (
        (providerKey === "tcgplayer" && externalKey === "sku:tcg_sku_1") ||
        (providerKey === "shopify" && externalKey === "variant:987")
      ) {
        return {
          provider_key: providerKey,
          external_key: externalKey,
          catalog_item_id: "cat_active",
          selected_options: [{ dimensionId: "condition", optionId: "near_mint" }],
          updated_at: now,
        };
      }

      return null;
    },
    getExternalCatalogItemReference: async (providerKey, externalKey) => {
      if (providerKey === "tcgplayer" && externalKey === "product:12345") {
        return {
          provider_key: providerKey,
          external_key: externalKey,
          catalog_item_id: "cat_active",
          updated_at: now,
        };
      }

      return null;
    },
    getCatalogItemByGtin: async (gtin) => {
      if (gtin === "00307418529636") {
        return {
          gtin,
          catalog_item_id: "cat_active",
          product_form: "booster-box",
          updated_at: now,
        };
      }

      return null;
    },
    getCatalogItem: async (itemId) => {
      if (itemId === "cat_unknown") {
        return null;
      }

      return {
        catalog_item_id: itemId,
        language_code: "en",
        title: itemId,
        subtitle: null,
        blueprint_id: null,
        status: itemId === "cat_inactive" ? "draft" : "active",
        product_schema:
          itemId === "cat_form_condition"
            ? formConditionProductSchema
            : itemId === "cat_bad_schema"
              ? { ...productSchema, canonicalDimensionOrder: [] }
              : productSchema,
        updated_at: now,
      };
    },
    projectors: [],
  };
}

function itemServices(
  onCreate: (params: Parameters<InventoryItemServices["createItem"]>[0]) => void,
  onAdjust: (params: Parameters<InventoryItemServices["adjustItem"]>[0]) => void,
): InventoryItemServices {
  return {
    commandHandler: async () => {
      throw new Error("Not used by import batch tests.");
    },
    createItem: async (params) => {
      const itemId = params.itemIdOverride ?? ("inv_generated" as InventoryItemId);
      onCreate(params);
      return { itemId, version: 1 };
    },
    adjustItem: async (params) => {
      onAdjust(params);
      return { itemId: params.itemId, version: 2 };
    },
    ensureListingStock: vi.fn(async () => undefined) as never,
    listItems: async () => ({ items: [], total: 0 }),
    getItem: async () => null,
    projectors: [],
  };
}

function runtime(
  db: ImportBatchDb,
  itemIds: InventoryItemId[] = [],
  adjustments: Array<Parameters<InventoryItemServices["adjustItem"]>[0]> = [],
  creations: Array<Parameters<InventoryItemServices["createItem"]>[0]> = [],
  catalogItems: InventoryCatalogItemServices = catalogServices(),
) {
  const services = createInventoryImportBatchRuntime({
    db,
    catalogItems,
    items: itemServices(
      (params) => {
        creations.push(params);
        itemIds.push(params.itemIdOverride ?? ("inv_generated" as InventoryItemId));
      },
      (params) => adjustments.push(params),
    ),
    draftListingCreator: vi.fn(async (params) => ({
      listingId: params.listingIdOverride,
      version: 1,
      feeQuoteFingerprint: "fee_1",
    })),
  });
  const validateRow = createInventoryImportRowValidator({ db, catalogItems });
  return {
    ...services,
    // These unit tests seed review fixtures through the production validator.
    // Durable acceptance and worker transactions are exercised by the DB suite.
    createBatch: async (params: CreateInventoryImportBatch, _context: EventStoreContext) => {
      const snapshot = prepareInventoryImportSnapshot(params);
      const batchId = `imb_unit_${db.batches.size + 1}`;
      for (const sourceRow of snapshot.rows) {
        const row = await validateRow(params.accountId, sourceRow, snapshot.header.quantityMode);
        db.rows.push({
          row_id: `imr_${batchId.slice(4)}_${sourceRow.rowNumber}`,
          batch_id: batchId,
          row_number: sourceRow.rowNumber,
          status: row.status,
          raw_row: {
            ...sourceRow.rawRow,
            ...(row.acquisitionCostCurrencyCode
              ? { acquisitionCostCurrencyCode: row.acquisitionCostCurrencyCode }
              : {}),
            ...(row.listingPriceCurrencyCode ? { listingPriceCurrencyCode: row.listingPriceCurrencyCode } : {}),
          },
          external_reference: row.externalReference,
          row_fingerprint: row.rowFingerprint,
          quantity_mode: row.quantityMode,
          quantity_delta: row.quantityDelta,
          set_quantity: row.setQuantity,
          source_price_amount: row.sourcePriceAmount,
          resolution_status: row.resolutionStatus,
          catalog_item_id: row.catalogItemId,
          product_id: row.productId,
          selected_options: row.selectedOptions,
          storage_location_id: row.storageLocationId,
          total_quantity: row.totalQuantity,
          acquisition_occurred_at: row.acquisitionOccurredAt,
          acquisition_cost_amount: row.acquisitionCostAmount,
          acquisition_cost_currency_code: row.acquisitionCostCurrencyCode,
          seller_sku: row.sellerSku,
          listing_price_amount: row.listingPriceAmount,
          listing_price_currency_code: row.listingPriceCurrencyCode,
          listing_quantity_cap: row.listingQuantityCap,
          row_note: row.rowNote,
          validation_errors: row.validationErrors,
          committed_inventory_item_id: null,
          committed_listing_id: null,
          committed_at: null,
          created_at: now,
          updated_at: now,
        });
      }
      const rows = db.rows.filter((row) => row.batch_id === batchId);
      db.batches.set(batchId, {
        batch_id: batchId,
        account_id: params.accountId,
        status: "uploaded",
        source_key: snapshot.header.sourceKey,
        adapter_version: snapshot.header.adapterVersion,
        quantity_mode: snapshot.header.quantityMode,
        default_storage_location_id: snapshot.header.defaultStorageLocationId,
        total_count: rows.length,
        accepted_count: rows.filter((row) => row.status === "accepted").length,
        rejected_count: rows.filter((row) => row.status === "rejected").length,
        committed_count: 0,
        created_at: now,
        updated_at: now,
      });
      return (await services.getBatch(batchId, params.accountId))!;
    },
  };
}

const context = {
  tenantId: "tnt_1",
  audit: {
    performedByUserId: "usr_1",
    forAccountId: "acc_1",
  },
} as EventStoreContext;

function dbWithLocations() {
  const db = new ImportBatchDb();
  db.locations.set("loc_active", {
    storage_location_id: "loc_active",
    account_id: "acc_1",
    name: "Active shelf",
    description: null,
    ship_from_code: "CHI",
    ship_from_address: {
      name: "Seller",
      line1: "1 Main St",
      city: "Chicago",
      state: "IL",
      postalCode: "60601",
      country: "US",
    },
    is_archived: false,
    updated_at: now,
  });
  db.locations.set("loc_archived", {
    storage_location_id: "loc_archived",
    account_id: "acc_1",
    name: "Archived shelf",
    description: null,
    ship_from_code: "CHI",
    is_archived: true,
    updated_at: now,
  });
  db.locations.set("loc_back_room", {
    storage_location_id: "loc_back_room",
    account_id: "acc_1",
    name: "Back Room",
    description: null,
    ship_from_code: "CHI",
    is_archived: false,
    updated_at: now,
  });
  return db;
}

function addAccountSkuMapping(
  db: ImportBatchDb,
  input: Readonly<{
    mappingId?: string;
    accountId?: string;
    sellerSku: string;
    catalogItemId?: string;
    selectedOptions?: readonly InventorySelectedOptionEntry[];
  }>,
) {
  db.accountSkuMappings = [
    ...db.accountSkuMappings,
    {
      mapping_id: input.mappingId ?? `sku_map_${db.accountSkuMappings.length + 1}`,
      account_id: input.accountId ?? "acc_1",
      seller_sku: input.sellerSku,
      normalized_seller_sku: input.sellerSku.trim().toLowerCase(),
      catalog_item_id: input.catalogItemId ?? "cat_active",
      selected_options: input.selectedOptions ?? [{ dimensionId: "condition", optionId: "near_mint" }],
      updated_at: now,
    },
  ];
}

describe("inventory import batch runtime", () => {
  it.each([
    { status: "committing", ready: 1, rollout: true, message: "Import commit is already running." },
    { status: "committed", ready: 0, rollout: true, message: "Import batch has no accepted rows waiting to commit." },
    { status: "uploaded", ready: 0, rollout: true, message: "Import batch has no accepted rows waiting to commit." },
    {
      status: "ready-to-commit",
      ready: 1,
      rollout: false,
      message: "Import stock progression is disabled; Product review remains available.",
    },
    {
      status: "expired",
      ready: 1,
      rollout: false,
      message: "Import batch expired; create a new import from the source.",
    },
    ...(["validating", "failed-safe", "ambiguous"] as const).map((status) => ({
      status,
      ready: 1,
      rollout: false,
      message: "Import validation must finish before committing rows.",
    })),
  ] as const)(
    "enqueue refusal precedes all writes: $status/$ready/$rollout",
    async ({ status, ready, rollout, message }) => {
      const db = dbWithLocations();
      const batch = await runtime(db).createBatch(
        {
          accountId: "acc_1" as AccountId,
          parsedRows: [
            {
              rowNumber: 1,
              values: {
                catalogItemId: "cat_active",
                storageLocationId: "loc_active",
                totalQuantity: "2",
                "option:condition": "near_mint",
              },
            },
          ],
        },
        context,
      );
      db.batches.set(batch.batch_id, {
        ...db.batches.get(batch.batch_id)!,
        status,
        accepted_count: ready,
        committed_count: 0,
      });
      const services = createInventoryImportBatchRuntime({
        db,
        catalogItems: catalogServices(),
        items: itemServices(
          () => undefined,
          () => undefined,
        ),
        importProductRollout: { normalizationEnabled: true, stockProgressionEnabled: rollout },
      });
      const before = db.queries.length;
      await expect(
        services.enqueueCommitBatchJob({ accountId: "acc_1" as AccountId, batchId: batch.batch_id }, context),
      ).rejects.toThrow(message);
      expect(db.queries.slice(before).every(({ sql }) => /^\s*SELECT\b/.test(sql))).toBe(true);
    },
  );

  it.each([undefined, true, false])(
    "getBatch applies the host stock-progression rollout to can_commit: %s",
    async (stockProgressionEnabled) => {
      const db = dbWithLocations();
      const batch = await runtime(db).createBatch(
        {
          accountId: "acc_1" as AccountId,
          parsedRows: [
            {
              rowNumber: 1,
              values: {
                catalogItemId: "cat_active",
                storageLocationId: "loc_active",
                totalQuantity: "2",
                "option:condition": "near_mint",
              },
            },
          ],
        },
        context,
      );
      const services = createInventoryImportBatchRuntime({
        db,
        items: itemServices(
          () => undefined,
          () => undefined,
        ),
        catalogItems: catalogServices(),
        importProductRollout:
          stockProgressionEnabled === undefined
            ? undefined
            : {
                normalizationEnabled: true,
                stockProgressionEnabled,
              },
      });
      expect(await services.getBatch(batch.batch_id, "acc_1", { limit: 0 })).toMatchObject({
        rows: [],
        can_commit: stockProgressionEnabled !== false,
        commit_ready_count: 1,
      });
    },
  );

  it.each(["native-csv", "saved-list"] as const)(
    "resolveRow answers the next needs-seller row: %s",
    async (sourceKey) => {
      const db = dbWithLocations();
      const services = runtime(db);
      const batch = await services.createBatch(
        {
          accountId: "acc_1" as AccountId,
          sourceKey,
          defaultStorageLocationId: "loc_active",
          parsedRows: Array.from({ length: 101 }, (_, index) => ({
            rowNumber: index + 1,
            values: {
              catalogItemId: index === 0 || index === 100 ? "cat_unknown" : "cat_active",
              storageLocationId: "loc_active",
              totalQuantity: "2",
              "option:condition": "near_mint",
            },
          })),
        },
        context,
      );
      const resolve = (current: typeof batch, rowId: string) =>
        services.resolveRow(
          {
            accountId: "acc_1" as AccountId,
            batchId: batch.batch_id,
            rowId,
            ...rowFacts(current, rowId),
            catalogItemId: "cat_active",
            storageLocationId: "loc_active",
            selectedOptions: [{ dimensionId: "condition", optionId: "near_mint" }],
          },
          context,
        );
      const next = await resolve(batch, batch.rows[0]!.row_id);
      expect(next).toMatchObject({
        next_needs_seller_row_id: `imr_${batch.batch_id.slice(4)}_101`,
        can_commit: true,
        commit_ready_count: 100,
      });
      expect(next.rows[0]?.needs_seller).toBe(false);
      // Row 101 sits beyond the first 100-row page; the resolve authority still decides it from the full batch.
      expect((await resolve(next, next.next_needs_seller_row_id!)).next_needs_seller_row_id).toBeNull();
    },
  );

  const sources = inventoryImportSourceProfiles.map((profile) => profile.sourceKey);
  const cases = [
    "missing",
    "nonexistent",
    "inactive",
    "source-mismatched",
    "option-incomplete",
    "schema-invalid",
    "schema-definition-invalid",
    "complete",
  ] as const;
  function sourceValues(kind: (typeof cases)[number]): Record<string, string> {
    const values: Record<string, string> = {
      catalogItemId:
        kind === "nonexistent"
          ? "cat_unknown"
          : kind === "inactive"
            ? "cat_inactive"
            : kind === "schema-definition-invalid"
              ? "cat_bad_schema"
              : "cat_active",
      storageLocationId: "loc_active",
      totalQuantity: "2",
      Quantity: "2",
      Price: "3.00",
      Currency: "USD",
      listingPriceAmount: "3.00",
      listingPriceCurrencyCode: "USD",
      listingQuantityCap: "2",
      "option:condition": "near_mint",
      sellerSku: "review-sku",
      "Seller SKU": "review-sku",
      SKU: "review-sku",
    };
    if (kind === "missing") delete values.catalogItemId;
    if (kind === "option-incomplete") delete values["option:condition"];
    if (kind === "schema-invalid") values["option:unknown"] = "invalid";
    if (kind === "source-mismatched") values.productId = "stale_product";
    return values;
  }

  it.each(sources.flatMap((sourceKey) => cases.map((kind) => ({ sourceKey, kind }))))(
    "AC-01 $sourceKey/$kind validates final Product state and rejects the old-native behavior",
    async ({ sourceKey, kind }) => {
      const services = runtime(dbWithLocations());
      const batch = await services.createBatch(
        {
          accountId: "acc_1" as AccountId,
          sourceKey,
          defaultStorageLocationId: "loc_active",
          parsedRows: [{ rowNumber: 1, values: sourceValues(kind) }],
        },
        context,
      );
      const row = batch.rows[0]!;
      if (kind === "complete") {
        expect(row).toMatchObject({
          status: "accepted",
          product_id: "cat_active::condition:near_mint",
          resolution_status: "native",
        });
      } else {
        expect(row).toMatchObject({ status: "rejected", product_id: null, resolution_status: "unresolved" });
        expect(row.validation_errors.length).toBeGreaterThan(0);
      }
    },
  );

  it.each(
    sources.flatMap((sourceKey) => cases.filter((kind) => kind !== "complete").map((kind) => ({ sourceKey, kind }))),
  )(
    "AC-08 $sourceKey/$kind confirms fresh selection without stale source veto; only native SKU persists",
    async ({ sourceKey, kind }) => {
      const db = dbWithLocations();
      const creations: Array<Parameters<InventoryItemServices["createItem"]>[0]> = [];
      const services = runtime(db, [], [], creations);
      const values = sourceValues(kind);
      values["option:Condition"] = "stale-duplicate";
      const batch = await services.createBatch(
        {
          accountId: "acc_1" as AccountId,
          sourceKey,
          defaultStorageLocationId: "loc_active",
          parsedRows: [{ rowNumber: 1, values }],
        },
        context,
      );
      const before = db.queries.length;
      const resolved = await services.resolveRow(
        {
          accountId: "acc_1" as AccountId,
          batchId: batch.batch_id,
          rowId: batch.rows[0]!.row_id,
          ...rowFacts(batch, batch.rows[0]!.row_id),
          catalogItemId: "cat_active",
          storageLocationId: "loc_active",
          selectedOptions: [{ dimensionId: "condition", optionId: "near_mint" }],
        },
        context,
      );
      expect(resolved.rows[0]).toMatchObject({
        status: "accepted",
        product_id: "cat_active::condition:near_mint",
        resolution_status: "resolved",
      });
      const mappingWrites = db.queries
        .slice(before)
        .filter(({ sql }) => /(?:INSERT INTO|UPDATE) inventory_import_account_sku_mappings/.test(sql));
      expect(mappingWrites).toHaveLength(sourceKey === "native-csv" ? 1 : 0);
      await services.commitBatch({ accountId: "acc_1" as AccountId, batchId: batch.batch_id }, context);
      expect(creations).toHaveLength(1);
    },
  );

  it.each(sources)("AC-02 explicit %s identity performs zero candidate lookups", async (sourceKey) => {
    const db = dbWithLocations();
    const catalog = catalogServices();
    const productLookup = vi.spyOn(catalog, "getExternalProductReference");
    const itemLookup = vi.spyOn(catalog, "getExternalCatalogItemReference");
    const gtinLookup = vi.spyOn(catalog, "getCatalogItemByGtin");
    const services = runtime(db, [], [], [], catalog);
    const batch = await services.createBatch(
      {
        accountId: "acc_1" as AccountId,
        sourceKey,
        defaultStorageLocationId: "loc_active",
        parsedRows: [
          {
            rowNumber: 1,
            values: {
              ...sourceValues("complete"),
              "Product ID": "12345",
              GTIN: "00307418529636",
              "Variant Barcode": "00307418529636",
            },
          },
        ],
      },
      context,
    );
    expect(batch.rows[0]?.product_id).toBe("cat_active::condition:near_mint");
    expect(productLookup).not.toHaveBeenCalled();
    expect(itemLookup).not.toHaveBeenCalled();
    expect(gtinLookup).not.toHaveBeenCalled();
    expect(db.queries.filter(({ sql }) => sql.includes("FROM inventory_import_account_sku_mappings"))).toHaveLength(0);
  });

  it.each(["invalid-gtin", "mapped-invalid-high", "missing-high-valid-lower", "ambiguous-sku"])(
    "AC-02 ordered candidate lookup control %s",
    async (kind) => {
      const db = dbWithLocations();
      const catalog = { ...catalogServices() };
      const events: string[] = [];
      catalog.getCatalogItemByGtin = vi.fn(async (gtin) => {
        events.push(`gtin:${gtin}`);
        return null;
      });
      catalog.getExternalCatalogItemReference = vi.fn(async (_provider, key) => {
        events.push(key);
        return (key === "product:12345" && kind !== "ambiguous-sku") || key === "handle:lower"
          ? { provider_key: "tcgplayer", external_key: key, catalog_item_id: "cat_active", updated_at: now }
          : null;
      });
      catalog.getExternalProductReference = vi.fn(async (_provider, key) => {
        events.push(key);
        return kind === "mapped-invalid-high"
          ? {
              provider_key: "tcgplayer",
              external_key: key,
              catalog_item_id: "cat_inactive",
              selected_options: [{ dimensionId: "condition", optionId: "near_mint" }],
              updated_at: now,
            }
          : null;
      });
      if (kind === "ambiguous-sku") {
        addAccountSkuMapping(db, { sellerSku: "review-sku", catalogItemId: "cat_active" });
        addAccountSkuMapping(db, { sellerSku: "review-sku", catalogItemId: "cat_other" });
      }
      const sourceKey: InventoryImportSourceKey =
        kind === "invalid-gtin" || kind === "ambiguous-sku" ? "shopify-csv" : "tcgplayer-csv";
      const values = sourceValues("complete");
      delete values.catalogItemId;
      values["Product ID"] = "12345";
      values["Variant ID"] = "missing";
      values["Variant SKU"] = "review-sku";
      values["Variant Barcode"] = "00307418529635";
      values.Handle = "lower";
      const batch = await runtime(db, [], [], [], catalog).createBatch(
        {
          accountId: "acc_1" as AccountId,
          sourceKey,
          defaultStorageLocationId: "loc_active",
          parsedRows: [{ rowNumber: 1, values }],
        },
        context,
      );
      if (kind === "mapped-invalid-high" || kind === "ambiguous-sku") {
        expect(batch.rows[0]).toMatchObject({ product_id: null, resolution_status: "unresolved" });
        if (kind === "mapped-invalid-high") expect(events).not.toContain("product:12345");
        if (kind === "ambiguous-sku") {
          expect(events).not.toContain("handle:lower");
          expect(events.some((entry) => entry.startsWith("gtin:"))).toBe(false);
        }
      } else {
        expect(batch.rows[0]?.product_id).toBe("cat_active::condition:near_mint");
        expect(events).toContain("product:12345");
        expect(events.some((entry) => entry.startsWith("gtin:"))).toBe(false);
      }
    },
  );

  it("AC-02 valid GTIN precedes the stable profile order", async () => {
    const catalog = catalogServices();
    const gtin = vi.spyOn(catalog, "getCatalogItemByGtin");
    const product = vi.spyOn(catalog, "getExternalProductReference");
    const values = sourceValues("complete");
    delete values.catalogItemId;
    values["Variant ID"] = "mapped-lower";
    values["Variant Barcode"] = "00307418529636";
    const batch = await runtime(dbWithLocations(), [], [], [], catalog).createBatch(
      {
        accountId: "acc_1" as AccountId,
        sourceKey: "shopify-csv",
        defaultStorageLocationId: "loc_active",
        parsedRows: [{ rowNumber: 1, values }],
      },
      context,
    );
    expect(batch.rows[0]?.resolution_status).toBe("resolved");
    expect(gtin).toHaveBeenCalledWith("00307418529636");
    expect(product).not.toHaveBeenCalled();
  });

  it("AC-09 both live callers retain the one validator; deleting either caller fails the census", () => {
    const source = readFileSync(new URL("./runtime.ts", import.meta.url), "utf8");
    const callerNames = ["resolveBatchRow", "processNextCreateBatchWorkUnit"];
    const census = (text: string) =>
      callerNames.every((name) => {
        const start = text.indexOf(`async function ${name}(`);
        const end = text.indexOf("\n  async function ", start + 1);
        return start >= 0 && /await validateRow\(/.test(text.slice(start, end < 0 ? undefined : end));
      });
    expect(census(source)).toBe(true);
    for (const name of callerNames) {
      const start = source.indexOf(`async function ${name}(`);
      const end = source.indexOf("\n  async function ", start + 1);
      const body = source.slice(start, end < 0 ? undefined : end);
      expect(census(source.replace(body, body.replace("await validateRow(", "await omittedValidator(")))).toBe(false);
    }
  });

  it("AC-08 native confirmation with a blank SKU never persists a mapping", async () => {
    const db = dbWithLocations();
    const services = runtime(db);
    const values = sourceValues("source-mismatched");
    delete values.sellerSku;
    delete values["Seller SKU"];
    delete values.SKU;
    const batch = await services.createBatch(
      { accountId: "acc_1" as AccountId, parsedRows: [{ rowNumber: 1, values }] },
      context,
    );
    const before = db.queries.length;
    const resolved = await services.resolveRow(
      {
        accountId: "acc_1" as AccountId,
        batchId: batch.batch_id,
        rowId: batch.rows[0]!.row_id,
        ...rowFacts(batch, batch.rows[0]!.row_id),
        catalogItemId: "cat_active",
        storageLocationId: "loc_active",
        selectedOptions: [{ dimensionId: "condition", optionId: "near_mint" }],
      },
      context,
    );
    expect(resolved.rows[0]?.status).toBe("accepted");
    expect(
      db.queries
        .slice(before)
        .filter(({ sql }) => /(?:INSERT INTO|UPDATE) inventory_import_account_sku_mappings/.test(sql)),
    ).toHaveLength(0);
  });
  it("creates the Product resolution scan index only through the concurrent migration", () => {
    expect(inventoryImportBatchSchemaSql).not.toContain("inventory_import_batch_rows_product_resolution_scan_idx");
    const migration = inventoryImportBatchSchemaMigrations.find(
      ({ migrationId }) => migrationId === "20261006_inventory_import_product_resolution_scan",
    );
    expect(migration?.statements).toEqual([
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS inventory_import_batch_rows_product_resolution_scan_idx
  ON inventory_import_batch_rows (created_at, row_id)
  WHERE status = 'rejected' AND committed_at IS NULL`,
    ]);
  });

  it("expands safe readers without recreating contracted private upload columns", () => {
    expect(inventoryImportBatchSchemaSql).not.toMatch(/\b(?:csv_text|parsed_rows|source_filename)\b/);
    expect(inventoryImportBatchSchemaSql).toContain("ADD COLUMN IF NOT EXISTS snapshot_version integer NULL");
    expect(inventoryImportBatchSchemaSql).toContain("ADD COLUMN IF NOT EXISTS seller_sku text NULL");
    expect(inventoryImportBatchSchemaSql).toContain(
      "ADD COLUMN IF NOT EXISTS listing_price_amount numeric(12, 2) NULL",
    );
    expect(inventoryImportBatchSchemaSql).toContain("ADD COLUMN IF NOT EXISTS committed_listing_id text NULL");
    expect(inventoryImportBatchSchemaSql).toContain("CREATE TABLE IF NOT EXISTS inventory_import_account_sku_mappings");
    expect(inventoryImportBatchSchemaSql).toContain("inventory_import_account_sku_mappings_lookup_idx");
  });

  it("drops the raw-source columns only in the ledgered contraction after the safe-snapshot readers", () => {
    const migrationIds = inventoryImportBatchSchemaMigrations.map(({ migrationId }) => migrationId);
    const contraction =
      inventoryImportBatchSchemaMigrations[migrationIds.indexOf("20261016_inventory_import_safe_snapshots") + 1];
    expect(contraction?.migrationId).toBe("20261020_inventory_import_raw_source_contraction");
    expect(contraction?.dataStep).toBe(contractInventoryImportSources);
    expect(contraction?.statements.map((sql) => sql.replace(/\s+/g, " ").trim())).toEqual([
      "SET LOCAL lock_timeout = '5s'",
      "ALTER TABLE inventory_import_batch_job_inputs DROP COLUMN IF EXISTS csv_text, DROP COLUMN IF EXISTS parsed_rows, DROP COLUMN IF EXISTS source_filename",
      "ALTER TABLE inventory_import_batches DROP COLUMN IF EXISTS source_filename",
    ]);
    for (const migration of inventoryImportBatchSchemaMigrations.filter((candidate) => candidate !== contraction))
      expect(migration.statements.join("\n")).not.toMatch(/\b(?:csv_text|parsed_rows|source_filename)\b/);
  });

  it("names a dropped raw-source column in no runtime SQL", () => {
    for (const file of [
      "./runtime.ts",
      "./source-migration.ts",
      "../read-model/queries.ts",
      "../read-model/seller-attention-source.ts",
    ]) {
      const literals = readFileSync(new URL(file, import.meta.url), "utf8").match(/`[^`]*`|"(?:[^"\\\n]|\\.)*"/g) ?? [];
      expect(
        literals.filter(
          (text) =>
            /\b(?:SELECT|INSERT|UPDATE|DELETE|ALTER)\b/.test(text) &&
            /\b(?:csv_text|parsed_rows|source_filename)\b/.test(text),
        ),
        file,
      ).toEqual([]);
    }
  });

  it("never contracts import sources from a worker poll", async () => {
    const statements: string[] = [];
    const query = (async (sql: string) => {
      statements.push(sql);
      return { rows: [], rowCount: 0 };
    }) as PgQueryable["query"];
    const services = runtime({ query, connect: async () => ({ query, release: () => undefined }) } as never);

    expect(await services.processNextImportBatchJob({ claimOwnerId: "poll-synthetic", claimTtlMs: 30_000 })).toBe(0);

    expect(statements.length).toBeGreaterThan(0);
    expect(
      statements.filter((sql) => /inventory-import-source-cutover|information_schema|\bLOCK\s+TABLE\b/i.test(sql)),
    ).toEqual([]);
  });

  it("only defers parent job reconciliation while create work-unit capacity is exhausted", () => {
    expect(shouldDeferImportBatchParentClaimForCreateUnitMiss("workflow_budget_exhausted")).toBe(true);
    expect(shouldDeferImportBatchParentClaimForCreateUnitMiss("job_budget_exhausted")).toBe(true);
    expect(shouldDeferImportBatchParentClaimForCreateUnitMiss("none_available")).toBe(false);
    expect(shouldDeferImportBatchParentClaimForCreateUnitMiss("claimed")).toBe(false);
    expect(shouldDeferImportBatchParentClaimForCreateUnitMiss(undefined)).toBe(false);
  });

  it("does not touch import storage or claim more work after shutdown", async () => {
    const db = dbWithLocations();
    const query = vi.spyOn(db, "query");
    const services = runtime(db);
    const controller = new AbortController();
    controller.abort();
    expect(
      await services.processNextImportBatchJob({
        claimOwnerId: "stopped",
        claimTtlMs: 30_000,
        signal: controller.signal,
      }),
    ).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it("compares retried staged input independently of JSON object key order", () => {
    const base = {
      accountId: "acc_1" as AccountId,
      sourceKey: "saved-list" as const,
      quantityMode: "add" as const,
    };
    const original = serializeCreateBatchInputForIdempotency({
      ...base,
      parsedRows: [{ rowNumber: 1, values: { sourceLineId: "sll_1", totalQuantity: "2" } }],
    });
    const jsonbReload = serializeCreateBatchInputForIdempotency({
      ...base,
      parsedRows: [{ rowNumber: 1, values: { totalQuantity: "2", sourceLineId: "sll_1" } }],
    });

    expect(jsonbReload).toBe(original);
  });

  it("rejects empty queued import validation before staging a durable job", async () => {
    const services = runtime(dbWithLocations());

    await expect(
      services.enqueueCreateBatchJob(
        {
          accountId: "acc_1" as AccountId,
          csvText: "catalogItemId,storageLocationId,totalQuantity,option:condition\n",
        },
        context,
      ),
    ).rejects.toThrow("Import CSV must include at least one row.");
  });

  it("rejects Saved List imports outside the authorized account", async () => {
    const services = runtime(dbWithLocations());
    const wrongAccountContext: EventStoreContext = {
      tenantId: "tnt_1" as never,
      audit: { performedByUserId: "usr_1" as never, forAccountId: "acc_other" as AccountId },
    };

    await expect(
      services.createSavedListImportBatch(
        {
          requestId: "request_1",
          accountId: "acc_1" as AccountId,
          source: { sourceKind: "saved-list", listId: "svl_1", listVersion: 1, lines: [] },
        },
        wrongAccountContext,
      ),
    ).rejects.toThrow("does not match the authorized account");
  });

  it("routes Saved List rows with no location through canonical review and row repair", async () => {
    const services = runtime(dbWithLocations());
    const batch = await services.createBatch(
      {
        accountId: "acc_1" as AccountId,
        sourceKey: "saved-list",
        quantityMode: "add",
        parsedRows: [
          {
            rowNumber: 1,
            values: {
              sourceListId: "svl_1",
              sourceListVersion: "4",
              sourceLineId: "sll_1",
              sourceRowId: "saved-list:svl_1:v4:sll_1",
              catalogItemId: "cat_active",
              productId: "cat_active::condition:near_mint",
              totalQuantity: "2",
              "option:condition": "near_mint",
            },
          },
        ],
      },
      context,
    );

    expect(batch.rows[0]).toMatchObject({
      status: "rejected",
      catalog_item_id: "cat_active",
      product_id: "cat_active::condition:near_mint",
      acquisition_cost_amount: null,
    });
    expect(batch.rows[0]?.validation_errors).toContain("storageLocationId or defaultStorageLocationId is required.");

    const repaired = await services.resolveRow(
      {
        batchId: batch.batch_id,
        rowId: batch.rows[0]!.row_id,
        ...rowFacts(batch, batch.rows[0]!.row_id),
        accountId: "acc_1" as AccountId,
        catalogItemId: "cat_active",
        selectedOptions: [{ dimensionId: "condition", optionId: "near_mint" }],
        storageLocationId: "loc_active",
      },
      context,
    );
    expect(repaired.rows[0]).toMatchObject({ status: "accepted", storage_location_id: "loc_active" });
  });

  it("keeps changed Saved List Product evidence in review", async () => {
    const services = runtime(dbWithLocations());
    const batch = await services.createBatch(
      {
        accountId: "acc_1" as AccountId,
        sourceKey: "saved-list",
        quantityMode: "add",
        parsedRows: [
          {
            rowNumber: 1,
            values: {
              sourceListId: "svl_1",
              sourceListVersion: "4",
              sourceLineId: "sll_1",
              sourceRowId: "saved-list:svl_1:v4:sll_1",
              catalogItemId: "cat_active",
              productId: "stale_product",
              storageLocationId: "loc_active",
              totalQuantity: "2",
              "option:condition": "near_mint",
            },
          },
        ],
      },
      context,
    );

    expect(batch.rows[0]?.status).toBe("rejected");
    expect(batch.rows[0]?.validation_errors).toContain(
      "The source Product no longer matches the current Catalog selection.",
    );
  });

  it("builds native CSV templates from account active storage locations only", async () => {
    const services = runtime(dbWithLocations());

    const template = await services.getNativeCsvTemplate({ accountId: "acc_1" as AccountId });

    expect(template).toContain(
      "catalogItemId,storageLocationId,totalQuantity,acquisitionOccurredAt,option:form,option:condition,acquisitionCostAmount,acquisitionCostCurrencyCode,sellerSku,listingPriceAmount,listingPriceCurrencyCode,listingQuantityCap,rowNote",
    );
    expect(template).toContain("loc_active");
    expect(template).toContain("Example for Active shelf");
    expect(template).not.toContain("loc_archived");
  });

  it("exports current account inventory in native CSV import format", async () => {
    const db = dbWithLocations();
    db.items.set("inv_1", {
      item_id: "inv_1",
      account_id: "acc_1",
      catalog_catalog_item_id: "cat_active",
      storage_location_id: "loc_active",
      total_quantity: 6,
      selected_options: [{ dimensionId: "condition", optionId: "near_mint" }],
      acquisition_cost_amount: "1.25",
      acquisition_cost_currency_code: "CAD",
      updated_at: now,
    });
    db.items.set("inv_other", {
      item_id: "inv_other",
      account_id: "acc_other",
      catalog_catalog_item_id: "cat_other",
      storage_location_id: "loc_active",
      total_quantity: 99,
      selected_options: [],
      acquisition_cost_amount: null,
      acquisition_cost_currency_code: null,
      updated_at: now,
    });
    const services = runtime(db);

    const csv = await services.getNativeCsvExport({ accountId: "acc_1" as AccountId });

    expect(csv).toBe(
      [
        "catalogItemId,storageLocationId,totalQuantity,acquisitionOccurredAt,option:condition,acquisitionCostAmount,acquisitionCostCurrencyCode,sellerSku,listingPriceAmount,listingPriceCurrencyCode,listingQuantityCap,rowNote",
        "cat_active,loc_active,6,,near_mint,1.25,CAD,,,,,",
      ].join("\n"),
    );
    expect(csv).not.toContain("cat_other");
  });

  it("accepts valid dynamic option rows and rejects row-level validation failures", async () => {
    const services = runtime(dbWithLocations());
    const batch = await services.createBatch(
      {
        accountId: "acc_1" as AccountId,
        sourceFilename: "stock.csv",
        csvText: [
          "catalogItemId,storageLocationId,totalQuantity,option:condition,acquisitionCostAmount,acquisitionCostCurrencyCode,listingPriceAmount,listingPriceCurrencyCode,listingQuantityCap",
          "cat_active,loc_active,2,near_mint,1.25,CAD,4.50,USD,1",
          "cat_unknown,loc_active,2,near_mint,,,,,",
          "cat_inactive,loc_active,2,near_mint,,,,,",
          "cat_active,loc_active,2,bad_option,,,,,",
          "cat_active,loc_archived,2,near_mint,,,,,",
          "cat_active,loc_active,0,near_mint,,,,,",
          "cat_active,loc_active,2,near_mint,bad-money,CAD,,,",
          "cat_active,loc_active,2,near_mint,,,4.50,,",
          "cat_active,loc_active,2,near_mint,,,4.50,US,1",
          "cat_active,loc_active,2,near_mint,1.25,,,,",
          "cat_active,loc_active,2,near_mint,1.25,cad,,,",
        ].join("\n"),
      },
      context,
    );

    expect(batch.total_count).toBe(11);
    expect(batch.accepted_count).toBe(1);
    expect(batch.rejected_count).toBe(10);
    expect(batch.rows[0]).toMatchObject({
      status: "accepted",
      product_id: "cat_active::condition:near_mint",
      selected_options: [{ dimensionId: "condition", optionId: "near_mint" }],
      acquisition_cost_amount: "1.25",
      acquisition_cost_currency_code: "CAD",
      listing_price_amount: "4.50",
      listing_price_currency_code: "USD",
      listing_quantity_cap: 1,
    });
    expect(batch.rows.slice(1).flatMap((row) => row.validation_errors)).toEqual(
      expect.arrayContaining([
        "Catalog item was not found.",
        "Catalog item must be active.",
        "Selected options must use an allowed option for Condition.",
        "Storage location is archived.",
        "add imports require totalQuantity to be a non-zero whole number.",
        "acquisitionCostAmount must be a zero-or-greater decimal amount.",
        "acquisitionCostAmount and acquisitionCostCurrencyCode must be supplied together.",
        "acquisitionCostCurrencyCode must be an uppercase three-letter ISO-4217 code.",
        "listingQuantityCap is required when listingPriceAmount is set.",
        "listingPriceCurrencyCode is required when listingPriceAmount is set.",
        "listingPriceCurrencyCode must be a three-letter ISO-4217 code.",
      ]),
    );
  });

  it("accepts native option columns that use visible dimension and option labels", async () => {
    const services = runtime(dbWithLocations());
    const batch = await services.createBatch(
      {
        accountId: "acc_1" as AccountId,
        csvText: [
          "catalogItemId,storageLocationId,totalQuantity,option:form,option:condition,listingPriceAmount,listingPriceCurrencyCode,listingQuantityCap",
          "cat_form_condition,loc_active,1,Raw,Damaged,5.55,USD,1",
          "cat_form_condition,loc_active,2,Raw,Near Mint,6.66,USD,1",
          "cat_unknown,loc_active,3,Raw,Near Mint,7.77,USD,1",
        ].join("\n"),
      },
      context,
    );

    expect(batch).toMatchObject({
      total_count: 3,
      accepted_count: 2,
      rejected_count: 1,
    });
    expect(batch.rows[0]).toMatchObject({
      status: "accepted",
      product_id: "cat_form_condition::dim_form:opt_raw|dim_condition:opt_damaged",
      selected_options: [
        { dimensionId: "dim_form", optionId: "opt_raw" },
        { dimensionId: "dim_condition", optionId: "opt_damaged" },
      ],
      listing_price_amount: "5.55",
      listing_price_currency_code: "USD",
      listing_quantity_cap: 1,
    });
    expect(batch.rows[1]).toMatchObject({
      status: "accepted",
      product_id: "cat_form_condition::dim_form:opt_raw|dim_condition:opt_near_mint",
      selected_options: [
        { dimensionId: "dim_form", optionId: "opt_raw" },
        { dimensionId: "dim_condition", optionId: "opt_near_mint" },
      ],
      listing_price_amount: "6.66",
      listing_price_currency_code: "USD",
      listing_quantity_cap: 1,
    });
    expect(batch.rows[2]).toMatchObject({
      status: "rejected",
      validation_errors: ["Catalog item was not found."],
    });
  });

  it("accepts storage location labels when storageLocationId is omitted", async () => {
    const services = runtime(dbWithLocations());
    const batch = await services.createBatch(
      {
        accountId: "acc_1" as AccountId,
        csvText: [
          "catalogItemId,storageLocation,totalQuantity,option:condition",
          "cat_active,Active shelf,2,near_mint",
        ].join("\n"),
      },
      context,
    );

    expect(batch).toMatchObject({
      accepted_count: 1,
      rejected_count: 0,
    });
    expect(batch.rows[0]).toMatchObject({
      status: "accepted",
      storage_location_id: "loc_active",
    });
  });

  it("matches friendly storage location headers with normalized label text", async () => {
    const services = runtime(dbWithLocations());
    const batch = await services.createBatch(
      {
        accountId: "acc_1" as AccountId,
        csvText: [
          "catalogItemId,Storage Location Name,totalQuantity,option:condition",
          "cat_active,back-room,2,near_mint",
        ].join("\n"),
      },
      context,
    );

    expect(batch.rows[0]).toMatchObject({
      status: "accepted",
      storage_location_id: "loc_back_room",
    });
  });

  it("rejects unknown storage location labels with valid active choices", async () => {
    const services = runtime(dbWithLocations());
    const batch = await services.createBatch(
      {
        accountId: "acc_1" as AccountId,
        csvText: ["catalogItemId,Location,totalQuantity,option:condition", "cat_active,Missing shelf,2,near_mint"].join(
          "\n",
        ),
      },
      context,
    );

    expect(batch.rows[0]).toMatchObject({
      status: "rejected",
      storage_location_id: null,
      validation_errors: [
        "Storage location 'Missing shelf' was not found. Valid active storage locations: Active shelf, Back Room.",
      ],
    });
  });

  it("rejects ambiguous duplicate storage location labels", async () => {
    const db = dbWithLocations();
    db.locations.set("loc_active_duplicate", {
      storage_location_id: "loc_active_duplicate",
      account_id: "acc_1",
      name: "Active Shelf",
      description: null,
      ship_from_code: "CHI",
      is_archived: false,
      updated_at: now,
    });
    const services = runtime(db);
    const batch = await services.createBatch(
      {
        accountId: "acc_1" as AccountId,
        csvText: [
          "catalogItemId,Location Name,totalQuantity,option:condition",
          "cat_active,active-shelf,2,near_mint",
        ].join("\n"),
      },
      context,
    );

    expect(batch.rows[0]).toMatchObject({
      status: "rejected",
      storage_location_id: null,
      validation_errors: ["Storage location 'active-shelf' is ambiguous. Use storageLocationId instead."],
    });
  });

  it("accepts native rows resolved by account-scoped seller SKU mappings", async () => {
    const db = dbWithLocations();
    addAccountSkuMapping(db, { sellerSku: "Box-A-001" });
    const services = runtime(db);
    const batch = await services.createBatch(
      {
        accountId: "acc_1" as AccountId,
        csvText: ["Seller SKU,storageLocationId,totalQuantity", "Box-A-001,loc_active,2"].join("\n"),
      },
      context,
    );

    expect(batch).toMatchObject({
      accepted_count: 1,
      rejected_count: 0,
    });
    expect(batch.rows[0]).toMatchObject({
      status: "accepted",
      resolution_status: "resolved",
      external_reference: {
        providerKey: "account",
        externalKey: "sku:box-a-001",
        targetIntent: "account-sku",
      },
      catalog_item_id: "cat_active",
      product_id: "cat_active::condition:near_mint",
      selected_options: [{ dimensionId: "condition", optionId: "near_mint" }],
      seller_sku: "Box-A-001",
    });
  });

  it("keeps seller SKU mappings isolated by account", async () => {
    const db = dbWithLocations();
    addAccountSkuMapping(db, { accountId: "acc_other", sellerSku: "Shared-SKU", catalogItemId: "cat_other" });
    addAccountSkuMapping(db, { accountId: "acc_1", sellerSku: "Shared-SKU", catalogItemId: "cat_active" });
    const services = runtime(db);
    const batch = await services.createBatch(
      {
        accountId: "acc_1" as AccountId,
        csvText: ["sellerSku,storageLocationId,totalQuantity", "Shared-SKU,loc_active,2"].join("\n"),
      },
      context,
    );

    expect(batch.rows[0]).toMatchObject({
      status: "accepted",
      catalog_item_id: "cat_active",
    });
  });

  it("rejects unknown native seller SKUs for review", async () => {
    const services = runtime(dbWithLocations());
    const batch = await services.createBatch(
      {
        accountId: "acc_1" as AccountId,
        csvText: ["sellerSku,storageLocationId,totalQuantity", "missing-sku,loc_active,2"].join("\n"),
      },
      context,
    );

    expect(batch.rows[0]).toMatchObject({
      status: "rejected",
      resolution_status: "unresolved",
      catalog_item_id: null,
      validation_errors: ["Seller SKU 'missing-sku' is not mapped for this account.", "Catalog item id is required."],
    });
  });

  it("persists picker-fixed native seller SKU mappings so reruns auto-accept", async () => {
    const db = dbWithLocations();
    const services = runtime(db);
    const firstBatch = await services.createBatch(
      {
        accountId: "acc_1" as AccountId,
        csvText: ["sellerSku,storageLocationId,totalQuantity", "box-a-101,loc_active,2"].join("\n"),
      },
      context,
    );

    const fixedBatch = await services.resolveRow(
      {
        accountId: "acc_1" as AccountId,
        batchId: firstBatch.batch_id,
        rowId: firstBatch.rows[0]!.row_id,
        ...rowFacts(firstBatch, firstBatch.rows[0]!.row_id),
        catalogItemId: "cat_active",
        selectedOptions: [{ dimensionId: "condition", optionId: "near_mint" }],
        storageLocationId: "loc_active",
      },
      context,
    );
    const rerunBatch = await services.createBatch(
      {
        accountId: "acc_1" as AccountId,
        csvText: ["sellerSku,storageLocationId,totalQuantity", "box-a-101,loc_active,2"].join("\n"),
      },
      context,
    );

    expect(fixedBatch).toMatchObject({
      accepted_count: 1,
      rejected_count: 0,
    });
    expect(fixedBatch.rows[0]).toMatchObject({
      status: "accepted",
      resolution_status: "resolved",
      catalog_item_id: "cat_active",
      product_id: "cat_active::condition:near_mint",
      validation_errors: [],
    });
    expect(db.accountSkuMappings).toEqual([
      expect.objectContaining({
        account_id: "acc_1",
        seller_sku: "box-a-101",
        normalized_seller_sku: "box-a-101",
        catalog_item_id: "cat_active",
        selected_options: [{ dimensionId: "condition", optionId: "near_mint" }],
      }),
    ]);
    expect(rerunBatch.rows[0]).toMatchObject({
      status: "accepted",
      resolution_status: "resolved",
      catalog_item_id: "cat_active",
      selected_options: [{ dimensionId: "condition", optionId: "near_mint" }],
    });
  });

  it("updates one existing account seller SKU mapping from a picker fix", async () => {
    const db = dbWithLocations();
    addAccountSkuMapping(db, { sellerSku: "stale-sku", catalogItemId: "cat_unknown", selectedOptions: [] });
    const services = runtime(db);
    const batch = await services.createBatch(
      {
        accountId: "acc_1" as AccountId,
        csvText: ["sellerSku,storageLocationId,totalQuantity", "stale-sku,loc_active,2"].join("\n"),
      },
      context,
    );

    await services.resolveRow(
      {
        accountId: "acc_1" as AccountId,
        batchId: batch.batch_id,
        rowId: batch.rows[0]!.row_id,
        ...rowFacts(batch, batch.rows[0]!.row_id),
        catalogItemId: "cat_active",
        selectedOptions: [{ dimensionId: "condition", optionId: "near_mint" }],
        storageLocationId: "loc_active",
      },
      context,
    );

    expect(db.accountSkuMappings).toHaveLength(1);
    expect(db.accountSkuMappings[0]).toMatchObject({
      seller_sku: "stale-sku",
      catalog_item_id: "cat_active",
      selected_options: [{ dimensionId: "condition", optionId: "near_mint" }],
    });
  });

  it("rejects duplicate seller SKU mappings instead of guessing", async () => {
    const db = dbWithLocations();
    addAccountSkuMapping(db, { mappingId: "sku_map_1", sellerSku: "duplicate-sku", catalogItemId: "cat_active" });
    addAccountSkuMapping(db, { mappingId: "sku_map_2", sellerSku: "duplicate-sku", catalogItemId: "cat_other" });
    const services = runtime(db);
    const batch = await services.createBatch(
      {
        accountId: "acc_1" as AccountId,
        csvText: ["sellerSku,storageLocationId,totalQuantity", "duplicate-sku,loc_active,2"].join("\n"),
      },
      context,
    );

    expect(batch.rows[0]).toMatchObject({
      status: "rejected",
      catalog_item_id: null,
      validation_errors: [
        "Seller SKU 'duplicate-sku' has multiple mappings for this account: cat_active (condition:near_mint), cat_other (condition:near_mint).",
        "Catalog item id is required.",
      ],
    });
  });

  it("rejects picker fixes when duplicate seller SKU mappings name conflicting choices", async () => {
    const db = dbWithLocations();
    addAccountSkuMapping(db, { mappingId: "sku_map_1", sellerSku: "duplicate-sku", catalogItemId: "cat_active" });
    addAccountSkuMapping(db, { mappingId: "sku_map_2", sellerSku: "duplicate-sku", catalogItemId: "cat_other" });
    const services = runtime(db);
    const batch = await services.createBatch(
      {
        accountId: "acc_1" as AccountId,
        csvText: ["sellerSku,storageLocationId,totalQuantity", "duplicate-sku,loc_active,2"].join("\n"),
      },
      context,
    );

    await expect(
      services.resolveRow(
        {
          accountId: "acc_1" as AccountId,
          batchId: batch.batch_id,
          rowId: batch.rows[0]!.row_id,
          ...rowFacts(batch, batch.rows[0]!.row_id),
          catalogItemId: "cat_active",
          selectedOptions: [{ dimensionId: "condition", optionId: "near_mint" }],
          storageLocationId: "loc_active",
        },
        context,
      ),
    ).rejects.toThrow(
      "Seller SKU 'duplicate-sku' has multiple mappings for this account: cat_active (condition:near_mint), cat_other (condition:near_mint).",
    );
  });

  it("keeps explicit and default storage location ids ahead of row labels", async () => {
    const services = runtime(dbWithLocations());
    const batch = await services.createBatch(
      {
        accountId: "acc_1" as AccountId,
        defaultStorageLocationId: "loc_back_room",
        csvText: [
          "catalogItemId,storageLocationId,storageLocation,totalQuantity,option:condition",
          "cat_active,loc_active,Missing shelf,2,near_mint",
          "cat_active,,Missing shelf,2,near_mint",
        ].join("\n"),
      },
      context,
    );

    expect(batch).toMatchObject({
      accepted_count: 2,
      rejected_count: 0,
    });
    expect(batch.rows[0]).toMatchObject({ storage_location_id: "loc_active" });
    expect(batch.rows[1]).toMatchObject({ storage_location_id: "loc_back_room" });
  });

  it("keeps rejected-only validation batches reviewable", async () => {
    const services = runtime(dbWithLocations());
    const batch = await services.createBatch(
      {
        accountId: "acc_1" as AccountId,
        csvText: "catalogItemId,storageLocationId,totalQuantity,option:condition\ncat_active,loc_active,2,",
      },
      context,
    );

    expect(batch).toMatchObject({
      status: "uploaded",
      total_count: 1,
      accepted_count: 0,
      rejected_count: 1,
      committed_count: 0,
    });
    expect(batch.rows[0]?.validation_errors).toContain("Selected options must include Condition.");
  });

  it("commits accepted rows idempotently without duplicating inventory or draft listings", async () => {
    const itemIds: InventoryItemId[] = [];
    const db = dbWithLocations();
    const services = runtime(db, itemIds);
    const batch = await services.createBatch(
      {
        accountId: "acc_1" as AccountId,
        csvText: [
          "catalogItemId,storageLocationId,totalQuantity,option:condition,listingPriceAmount,listingPriceCurrencyCode,listingQuantityCap",
          "cat_active,loc_active,3,near_mint,5.00,USD,2",
        ].join("\n"),
      },
      context,
    );

    const firstCommit = await services.commitBatch(
      { accountId: "acc_1" as AccountId, batchId: batch.batch_id },
      context,
    );
    const queriesBeforeReplay = db.queries.length;
    const secondCommit = await services.commitBatch(
      { accountId: "acc_1" as AccountId, batchId: batch.batch_id },
      context,
    );

    expect(itemIds).toHaveLength(1);
    expect(firstCommit.rows[0]?.committed_inventory_item_id).toBe(itemIds[0]);
    expect(firstCommit.rows[0]?.committed_listing_id).toBeDefined();
    const outboxInsert = db.queries.find((query) =>
      query.sql.includes("INSERT INTO inventory_import_draft_listing_outbox"),
    );
    expect(outboxInsert).toBeDefined();
    expect(outboxInsert?.values[0]).toBe(firstCommit.rows[0]?.row_id);
    const outboxMessage = inventoryDraftListingMessageSchema.parse(JSON.parse(String(outboxInsert?.values[6])));
    expect(outboxMessage).toMatchObject({
      messageId: firstCommit.rows[0]?.row_id,
      snapshot: { committedAt: expect.any(String) },
    });
    expect(outboxMessage.snapshot.committedAt).toBe(firstCommit.rows[0]?.committed_at);
    expect(secondCommit).toEqual(firstCommit);
    expect(db.queries.slice(queriesBeforeReplay).some((query) => query.sql.trimStart().startsWith("UPDATE"))).toBe(
      false,
    );
    expect(secondCommit.rows[0]).toMatchObject(firstCommit.rows[0] ?? {});
    const existingTargetQuery = db.queries.find(
      (query) => query.sql.includes("FROM inventory_items AS item") && query.sql.includes("inventory_holds"),
    );
    expect(existingTargetQuery?.sql).toContain("LEFT JOIN LATERAL");
    expect(existingTargetQuery?.sql).toContain("WHERE inventory_holds.item_id = item.item_id");
    expect(existingTargetQuery?.sql).not.toContain("GROUP BY item_id");
  });

  it("preserves an import-supplied acquisition occurrence through staging and inventory creation", async () => {
    const db = dbWithLocations();
    const creations: Array<Parameters<InventoryItemServices["createItem"]>[0]> = [];
    const services = runtime(db, [], [], creations);
    const batch = await services.createBatch(
      {
        accountId: "acc_1" as AccountId,
        sourceKey: "tcgplayer-csv",
        defaultStorageLocationId: "loc_active",
        csvText: [
          "Product ID,Quantity,Acquired At,Condition,TCG Marketplace Price,Currency",
          "12345,2,2026-05-01T12:30:00-05:00,Near Mint,10.00,USD",
        ].join("\n"),
      },
      context,
    );

    expect(batch.rows[0]).toMatchObject({
      acquisition_occurred_at: "2026-05-01T17:30:00.000Z",
      status: "accepted",
    });
    await services.commitBatch({ accountId: "acc_1" as AccountId, batchId: batch.batch_id }, context);
    expect(creations[0]?.acquisitionOccurrence).toEqual({
      kind: "occurred",
      occurredAt: "2026-05-01T17:30:00.000Z",
      source: "import-supplied",
    });
  });

  it("preserves a native import's source-authored acquisition denomination through inventory creation", async () => {
    const creations: Array<Parameters<InventoryItemServices["createItem"]>[0]> = [];
    const services = runtime(dbWithLocations(), [], [], creations);
    const batch = await services.createBatch(
      {
        accountId: "acc_1" as AccountId,
        csvText: [
          "catalogItemId,storageLocationId,totalQuantity,option:condition,acquisitionCostAmount,acquisitionCostCurrencyCode",
          "cat_active,loc_active,2,near_mint,1.25,CAD",
        ].join("\n"),
      },
      context,
    );

    expect(batch.rows[0]).toMatchObject({
      status: "accepted",
      acquisition_cost_amount: "1.25",
      acquisition_cost_currency_code: "CAD",
    });
    await services.commitBatch({ accountId: "acc_1" as AccountId, batchId: batch.batch_id }, context);
    expect(creations[0]).toMatchObject({
      acquisitionCostAmount: "1.25",
      acquisitionCostCurrencyCode: "CAD",
    });
  });

  it("rejects timezone-less acquisition occurrence input instead of substituting import time", async () => {
    const services = runtime(dbWithLocations());
    const batch = await services.createBatch(
      {
        accountId: "acc_1" as AccountId,
        csvText: [
          "catalogItemId,storageLocationId,totalQuantity,option:condition,acquisitionOccurredAt",
          "cat_active,loc_active,2,near_mint,2026-09-01T12:30:00",
        ].join("\n"),
      },
      context,
    );

    expect(batch.rows[0]).toMatchObject({ acquisition_occurred_at: null, status: "rejected" });
    expect(batch.rows[0]?.validation_errors).toContain(
      "acquisitionOccurredAt must be a valid timezone-bearing RFC3339 instant.",
    );
  });

  it("maps replace and signed add adjustments to correction or intake and emits nothing for zero", async () => {
    const db = dbWithLocations();
    const adjustments: Array<Parameters<InventoryItemServices["adjustItem"]>[0]> = [];
    const services = runtime(db, [], adjustments);
    const replaceBatch = await services.createBatch(
      {
        accountId: "acc_1" as AccountId,
        quantityMode: "replace",
        csvText: [
          "catalogItemId,storageLocationId,totalQuantity,option:condition,acquisitionOccurredAt",
          "cat_active,loc_active,12,near_mint,2026-05-01T10:00:00Z",
          "cat_active,loc_active,8,near_mint,",
          "cat_active,loc_active,10,near_mint,",
        ].join("\n"),
      },
      context,
    );
    db.items.set("inv_existing", {
      item_id: "inv_existing",
      account_id: "acc_1",
      catalog_catalog_item_id: "cat_active",
      product_id: replaceBatch.rows[0]?.product_id ?? undefined,
      storage_location_id: "loc_active",
      total_quantity: 10,
      selected_options: [{ dimensionId: "condition", optionId: "near_mint" }],
      acquisition_cost_amount: null,
      acquisition_cost_currency_code: null,
      updated_at: now,
    });

    await services.commitBatch({ accountId: "acc_1" as AccountId, batchId: replaceBatch.batch_id }, context);

    const addBatch = await services.createBatch(
      {
        accountId: "acc_1" as AccountId,
        quantityMode: "add",
        csvText: [
          "catalogItemId,storageLocationId,totalQuantity,option:condition,acquisitionOccurredAt",
          "cat_active,loc_active,3,near_mint,2026-05-02T10:00:00Z",
          "cat_active,loc_active,-2,near_mint,",
          "cat_active,loc_active,0,near_mint,",
        ].join("\n"),
      },
      context,
    );
    db.rows = db.rows.map((row) =>
      row.batch_id === addBatch.batch_id && row.total_quantity === null
        ? { ...row, status: "accepted", quantity_delta: 0, validation_errors: [] }
        : row,
    );
    await services.commitBatch({ accountId: "acc_1" as AccountId, batchId: addBatch.batch_id }, context);

    expect(adjustments.map(({ quantityDelta, reasonCode }) => ({ quantityDelta, reasonCode }))).toEqual([
      { quantityDelta: 2, reasonCode: "correction" },
      { quantityDelta: -2, reasonCode: "correction" },
      { quantityDelta: 3, reasonCode: "intake" },
      { quantityDelta: -2, reasonCode: "correction" },
    ]);
    expect(adjustments[0]?.acquisitionOccurrence).toEqual({
      kind: "occurred",
      occurredAt: "2026-05-01T10:00:00.000Z",
      source: "import-supplied",
    });
    expect(adjustments[1]).not.toHaveProperty("acquisitionOccurrence");
    expect(adjustments[2]?.acquisitionOccurrence).toEqual({
      kind: "occurred",
      occurredAt: "2026-05-02T10:00:00.000Z",
      source: "import-supplied",
    });
    expect(adjustments[3]).not.toHaveProperty("acquisitionOccurrence");
  });

  it("marks mixed imports committed after accepted rows commit while preserving rejected rows", async () => {
    const itemIds: InventoryItemId[] = [];
    const db = dbWithLocations();
    const services = runtime(db, itemIds);
    const batch = await services.createBatch(
      {
        accountId: "acc_1" as AccountId,
        csvText: [
          "catalogItemId,storageLocationId,totalQuantity,option:condition,listingPriceAmount,listingPriceCurrencyCode,listingQuantityCap",
          "cat_active,loc_active,2,near_mint,4.44,USD,1",
          "cat_unknown,loc_active,2,near_mint,,,",
        ].join("\n"),
      },
      context,
    );

    const committed = await services.commitBatch({ accountId: "acc_1" as AccountId, batchId: batch.batch_id }, context);

    expect(itemIds).toHaveLength(1);
    expect(committed).toMatchObject({
      status: "committed",
      total_count: 2,
      accepted_count: 1,
      rejected_count: 1,
      committed_count: 1,
    });
    expect(committed.rows).toEqual([
      expect.objectContaining({
        status: "committed",
        committed_inventory_item_id: itemIds[0],
      }),
      expect.objectContaining({
        status: "rejected",
        validation_errors: ["Catalog item was not found."],
        committed_inventory_item_id: null,
      }),
    ]);
  });

  it("resolves mapped TCGplayer rows and rejects unmapped external references", async () => {
    const services = runtime(dbWithLocations());
    const batch = await services.createBatch(
      {
        accountId: "acc_1" as AccountId,
        sourceKey: "tcgplayer-csv",
        quantityMode: "replace",
        defaultStorageLocationId: "loc_active",
        csvText: [
          "TCGplayer SKU,Product Name,Set Name,Condition,Quantity,TCG Marketplace Price,Currency",
          "tcg_sku_1,Charizard,Base Set,Near Mint,4,12.50,USD",
          "tcg_unknown,Pikachu,Jungle,Lightly Played,2,1.25,USD",
        ].join("\n"),
      },
      context,
    );

    expect(batch).toMatchObject({
      source_key: "tcgplayer-csv",
      quantity_mode: "replace",
      accepted_count: 1,
      rejected_count: 1,
    });
    expect(batch.rows[0]).toMatchObject({
      status: "accepted",
      resolution_status: "resolved",
      external_reference: {
        providerKey: "tcgplayer",
        externalKey: "sku:tcg_sku_1",
      },
      catalog_item_id: "cat_active",
      seller_sku: "tcg_sku_1",
      set_quantity: 4,
      source_price_amount: "12.50",
      listing_price_currency_code: "USD",
    });
    expect(batch.rows[1]?.validation_errors).toContain(
      "External product reference is not mapped to a Chase Sets catalog item.",
    );
  });

  it("tries ordered external reference candidates before sending rows to review", async () => {
    const services = runtime(dbWithLocations());
    const batch = await services.createBatch(
      {
        accountId: "acc_1" as AccountId,
        sourceKey: "tcgplayer-csv",
        quantityMode: "replace",
        defaultStorageLocationId: "loc_active",
        csvText: [
          "TCGplayer SKU,Product ID,Product Name,Set Name,Condition,Quantity,TCG Marketplace Price,Currency",
          "missing_sku,12345,Pikachu,Jungle,Near Mint,4,12.50,USD",
        ].join("\n"),
      },
      context,
    );

    expect(batch).toMatchObject({
      accepted_count: 1,
      rejected_count: 0,
    });
    expect(batch.rows[0]).toMatchObject({
      resolution_status: "resolved",
      external_reference: {
        providerKey: "tcgplayer",
        externalKey: "product:12345",
      },
      catalog_item_id: "cat_active",
      selected_options: [{ dimensionId: "condition", optionId: "near_mint" }],
    });
  });

  it("resolves TCGplayer Product ID-only rows only when selected options are inferable", async () => {
    const services = runtime(dbWithLocations());
    const batch = await services.createBatch(
      {
        accountId: "acc_1" as AccountId,
        sourceKey: "tcgplayer-csv",
        quantityMode: "replace",
        defaultStorageLocationId: "loc_active",
        csvText: [
          "Product ID,Product Name,Set Name,Condition,Quantity,TCG Marketplace Price,Currency",
          "12345,Pikachu,Jungle,Near Mint,4,12.50,USD",
          "12345,Pikachu,Jungle,Damaged,2,1.25,USD",
        ].join("\n"),
      },
      context,
    );

    expect(batch).toMatchObject({
      accepted_count: 1,
      rejected_count: 1,
    });
    expect(batch.rows[0]).toMatchObject({
      status: "accepted",
      resolution_status: "resolved",
      external_reference: {
        providerKey: "tcgplayer",
        externalKey: "product:12345",
      },
      catalog_item_id: "cat_active",
      selected_options: [{ dimensionId: "condition", optionId: "near_mint" }],
    });
    expect(batch.rows[1]).toMatchObject({
      status: "rejected",
      resolution_status: "unresolved",
      catalog_item_id: "cat_active",
      product_id: null,
    });
    expect(batch.rows[1]?.validation_errors).toContain("Selected options must include Condition.");
  });

  it("accepts mapped Shopify exports through the same import workflow", async () => {
    const services = runtime(dbWithLocations());
    const batch = await services.createBatch(
      {
        accountId: "acc_1" as AccountId,
        sourceKey: "shopify-csv",
        quantityMode: "replace",
        defaultStorageLocationId: "loc_active",
        csvText:
          "Title,Variant ID,Variant SKU,Variant Inventory Qty,Variant Price,Currency\nCharizard,987,box-1,2,9.50,USD",
      },
      context,
    );

    expect(batch.rows[0]).toMatchObject({
      status: "accepted",
      resolution_status: "resolved",
      external_reference: {
        providerKey: "shopify",
        externalKey: "variant:987",
      },
      listing_price_amount: "9.50",
      listing_price_currency_code: "USD",
      listing_quantity_cap: 2,
    });
  });

  it("bounds staged input retention deletes", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const services = createInventoryImportBatchRuntime({
      db: {
        query: async <Row = Record<string, unknown>>(sql: string, values: readonly unknown[] = []) => {
          calls.push({ sql, values });
          return { rows: [] as Row[], rowCount: 0 };
        },
      },
      catalogItems: catalogServices(),
      items: itemServices(
        () => undefined,
        () => undefined,
      ),
      draftListingCreator: vi.fn(async (params) => ({
        listingId: params.listingIdOverride,
        version: 1,
        feeQuoteFingerprint: "fee_1",
      })),
    });

    await services.pruneImportBatchJobRetention({
      completedBefore: "2026-05-01T00:00:00.000Z",
      stagedInputCreatedBefore: "2026-05-02T00:00:00.000Z",
      limit: 17,
    });

    const stagedInputDelete = calls.find((call) => call.sql.includes("inventory_import_batch_job_inputs AS input"));
    expect(stagedInputDelete?.sql).toContain("WITH expired AS");
    expect(stagedInputDelete?.sql).toContain("LIMIT $2");
    expect(stagedInputDelete?.sql).toContain("status IN ('queued', 'running')");
    expect(stagedInputDelete?.values[1]).toBe(17);
  });
});

describe("issue-7169-ac7 resolve authority", () => {
  const unresolvedRows = [
    {
      rowNumber: 1,
      values: {
        catalogItemId: "cat_unknown",
        storageLocationId: "loc_active",
        totalQuantity: "2",
        "option:condition": "near_mint",
      },
    },
  ];
  const fix = {
    accountId: "acc_1" as AccountId,
    catalogItemId: "cat_active",
    storageLocationId: "loc_active",
    selectedOptions: [{ dimensionId: "condition", optionId: "near_mint" }],
  };
  const resolveWrites = (db: ImportBatchDb) =>
    db.queries.filter(
      (query) => query.sql.includes("UPDATE inventory_import_batch_rows") && query.sql.includes("'resolved'"),
    ).length;

  async function seeded(sourceKey: InventoryImportSourceKey = "native-csv") {
    const db = dbWithLocations();
    const services = runtime(db);
    const batch = await services.createBatch(
      {
        accountId: "acc_1" as AccountId,
        sourceKey,
        defaultStorageLocationId: "loc_active",
        parsedRows: unresolvedRows,
      },
      context,
    );
    return { db, services, batch, rowId: batch.rows[0]!.row_id };
  }

  async function refusal(work: Promise<unknown>) {
    const error = await work.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ImportRowResolveConflict);
    return (error as ImportRowResolveConflict).code;
  }

  it("accepts the caller's current row facts and moves the row version", async () => {
    const { db, services, batch, rowId } = await seeded();
    const resolved = await services.resolveRow(
      { ...fix, batchId: batch.batch_id, rowId, ...rowFacts(batch, rowId) },
      context,
    );
    expect(resolved.rows[0]).toMatchObject({ status: "accepted", resolution_status: "resolved" });
    expect(resolved.rows[0]!.row_version).not.toBe(batch.rows[0]!.row_version);
    expect(resolveWrites(db)).toBe(1);
  });

  it("stale-resolve-wins: refuses facts the caller read before another resolve, without a write", async () => {
    const { db, services, batch, rowId } = await seeded();
    await services.resolveRow({ ...fix, batchId: batch.batch_id, rowId, ...rowFacts(batch, rowId) }, context);
    const before = structuredClone(db.rows);
    const batchBefore = structuredClone(db.batches.get(batch.batch_id));
    expect(
      await refusal(
        services.resolveRow(
          { ...fix, batchId: batch.batch_id, rowId, storageLocationId: "loc_active", ...rowFacts(batch, rowId) },
          context,
        ),
      ),
    ).toBe("stale_row_facts");
    expect(db.rows).toEqual(before);
    expect(db.batches.get(batch.batch_id)).toEqual(batchBefore);
  });

  it("terminal-row-reruns: refuses a committed row even with its current facts, without a write", async () => {
    const { db, services, batch, rowId } = await seeded();
    db.rows = db.rows.map((row) => ({ ...row, status: "committed" as const, committed_at: now }));
    const current = (await services.getBatch(batch.batch_id, "acc_1" as AccountId))!;
    const before = structuredClone(db.rows);
    expect(
      await refusal(
        services.resolveRow({ ...fix, batchId: batch.batch_id, rowId, ...rowFacts(current, rowId) }, context),
      ),
    ).toBe("terminal_row");
    expect(db.rows).toEqual(before);
    expect(resolveWrites(db)).toBe(0);
  });

  it.each([
    ["date-only version", "2026-05-09", "fp", "invalid_row_facts"],
    ["offset version", "2026-05-09T00:00:00.000000+00:00", "fp", "invalid_row_facts"],
    ["PostgreSQL text version", "2026-05-09 00:00:00.000000+00", "fp", "invalid_row_facts"],
    ["millisecond version", "2026-05-09T00:00:00.000Z", "fp", "invalid_row_facts"],
    ["numeric version", 1746748800000, "fp", "invalid_row_facts"],
    ["null version", null, "fp", "invalid_row_facts"],
    ["missing version", undefined, "fp", "invalid_row_facts"],
    ["impossible version", "2026-02-30T25:61:00.000000Z", "fp", "invalid_row_facts"],
    ["empty version", "", "fp", "missing_row_facts"],
    ["empty fingerprint", "2026-05-09T00:00:00.000000Z", "", "missing_row_facts"],
    ["numeric fingerprint", "2026-05-09T00:00:00.000000Z", 7, "invalid_row_facts"],
    ["control fingerprint", "2026-05-09T00:00:00.000000Z", "fp\u0000", "invalid_row_facts"],
    ["oversized fingerprint", "2026-05-09T00:00:00.000000Z", "f".repeat(2049), "invalid_row_facts"],
  ] as const)("refuses malformed caller facts before any read: %s", async (_case, version, fingerprint, code) => {
    const { db, services, batch, rowId } = await seeded();
    const queries = db.queries.length;
    expect(
      await refusal(
        services.resolveRow(
          {
            ...fix,
            batchId: batch.batch_id,
            rowId,
            expectedRowVersion: version as never,
            expectedRowFingerprint: fingerprint as never,
          },
          context,
        ),
      ),
    ).toBe(code);
    expect(db.queries).toHaveLength(queries);
  });

  it("refuses a cross-batch row and an unknown batch as row_not_found", async () => {
    const { db, services, batch, rowId } = await seeded();
    const other = await services.createBatch(
      { accountId: "acc_1" as AccountId, defaultStorageLocationId: "loc_active", parsedRows: unresolvedRows },
      context,
    );
    const otherRowId = other.rows[0]!.row_id;
    expect(
      await refusal(
        services.resolveRow(
          { ...fix, batchId: batch.batch_id, rowId: otherRowId, ...rowFacts(other, otherRowId) },
          context,
        ),
      ),
    ).toBe("row_not_found");
    expect(
      await refusal(services.resolveRow({ ...fix, batchId: "imb_missing", rowId, ...rowFacts(batch, rowId) }, context)),
    ).toBe("row_not_found");
    expect(resolveWrites(db)).toBe(0);
  });

  it("fails a legacy empty-fingerprint row closed", async () => {
    const { db, services, batch, rowId } = await seeded();
    db.rows = db.rows.map((row) => ({ ...row, row_fingerprint: "" }));
    expect(
      await refusal(
        services.resolveRow(
          {
            ...fix,
            batchId: batch.batch_id,
            rowId,
            expectedRowVersion: batch.rows[0]!.row_version,
            expectedRowFingerprint: "legacy",
          },
          context,
        ),
      ),
    ).toBe("missing_row_facts");
    expect(resolveWrites(db)).toBe(0);
  });

  it.each(["validating", "committing", "failed-safe", "ambiguous", "expired"] as const)(
    "refuses while the batch is %s",
    async (status) => {
      const { db, services, batch, rowId } = await seeded();
      db.batches.set(batch.batch_id, { ...db.batches.get(batch.batch_id)!, status });
      expect(
        await refusal(
          services.resolveRow({ ...fix, batchId: batch.batch_id, rowId, ...rowFacts(batch, rowId) }, context),
        ),
      ).toBe("batch_not_resolvable");
      expect(resolveWrites(db)).toBe(0);
    },
  );

  it.each(["partial", "committed"] as const)("resolves a nonterminal row while the batch is %s", async (status) => {
    const { db, services, batch, rowId } = await seeded();
    db.batches.set(batch.batch_id, { ...db.batches.get(batch.batch_id)!, status });
    const resolved = await services.resolveRow(
      { ...fix, batchId: batch.batch_id, rowId, ...rowFacts(batch, rowId) },
      context,
    );
    expect(resolved.rows[0]).toMatchObject({ status: "accepted" });
  });

  describe("through the HTTP route and the real mutation attempt executor", () => {
    function attemptStore(db: ImportBatchDb) {
      const receipts = new Map<string, Record<string, unknown>>();
      let pending = new Map<string, Record<string, unknown>>();
      const query = async (sql: string, values: readonly unknown[] = []) => {
        if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|SELECT pg_advisory_xact_lock|SELECT set_config)/.test(sql)) {
          if (sql === "COMMIT") {
            for (const [key, receipt] of pending) receipts.set(key, receipt);
            pending = new Map();
          }
          if (sql === "ROLLBACK") pending = new Map();
          return { rows: [], rowCount: 0 };
        }
        if (sql.startsWith("SELECT * FROM inventory_mutation_attempts")) {
          const receipt = pending.get(String(values[0])) ?? receipts.get(String(values[0]));
          return { rows: receipt ? [receipt] : [], rowCount: receipt ? 1 : 0 };
        }
        if (sql.includes("INSERT INTO inventory_mutation_attempts")) {
          const [attemptKey, tenantId, actorUserId, accountId, family, targetId, intentHash, requestingAccountId] =
            values;
          pending.set(String(attemptKey), {
            attempt_key: attemptKey,
            tenant_id: tenantId,
            actor_user_id: actorUserId,
            account_id: accountId,
            requesting_account_id: requestingAccountId,
            family,
            target_id: targetId,
            intent_hash: intentHash,
            fingerprint_version: 1,
            receipt_version: 1,
            status: "accepted",
          });
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("UPDATE inventory_mutation_attempts SET status = 'succeeded'")) {
          const accepted = pending.get(String(values[0]));
          if (!accepted) return { rows: [], rowCount: 0 };
          pending.set(String(values[0]), {
            ...accepted,
            status: "succeeded",
            result: JSON.parse(String(values[7])),
            result_hash: values[8],
            completed_at: now,
          });
          return { rows: [{ attempt_key: values[0] }], rowCount: 1 };
        }
        return db.query(sql, values);
      };
      const pool = { query, connect: async () => ({ query, release: () => undefined }) };
      return { pool: pool as unknown as PgTransactionalPool, receipts };
    }

    async function attemptedApp() {
      const seed = await seeded();
      const store = attemptStore(seed.db);
      const mutations = createInventoryMutationRuntime(store.pool, {} as PostgresEventStore);
      const services = createInventoryImportBatchRuntime({
        db: mutations.db,
        catalogItems: catalogServices(),
        items: itemServices(
          () => undefined,
          () => undefined,
        ),
        executeMutation: mutations.execute,
      });
      const app = new Hono<InventoryApiEnv>();
      app.use("*", async (c, next) => {
        c.set("actor", { accountId: "acc_1", permissions: ["inventory.manage"] } as never);
        c.set("context", context);
        await next();
      });
      app.route("/", inventoryImportBatchRoutes(services));
      const post = (attemptId: string, body: Record<string, unknown>) =>
        app.request(`/${seed.batch.batch_id}/rows/${seed.rowId}/resolve`, {
          method: "POST",
          headers: { "content-type": "application/json", "Inventory-Mutation-Attempt": attemptId },
          body: JSON.stringify(body),
        });
      const body = (detail: typeof seed.batch, overrides: Record<string, unknown> = {}) => ({
        catalogItemId: fix.catalogItemId,
        selectedOptions: fix.selectedOptions,
        storageLocationId: fix.storageLocationId,
        ...rowFacts(detail, seed.rowId),
        ...overrides,
      });
      return { ...seed, ...store, post, body };
    }

    it("accepts only the current row version fingerprint and stable attempt", async () => {
      const { db, receipts, post, body, batch, rowId } = await attemptedApp();
      const attempt = "2f1d6c4e-8a3b-4c5d-9e6f-7a8b9c0d1e2f";

      const first = await post(attempt, body(batch));
      expect(first.status).toBe(200);
      expect(((await first.json()) as { rows: Array<{ status: string }> }).rows[0]?.status).toBe("accepted");
      expect([...receipts.values()]).toEqual([
        expect.objectContaining({
          family: "import-resolve-row",
          target_id: rowId,
          status: "succeeded",
          result: { batchId: batch.batch_id, rowId },
        }),
      ]);
      expect(resolveWrites(db)).toBe(1);
      const afterFirst = structuredClone(db.rows);

      // Same attempt, same caller facts: replays the receipt without a second write.
      expect((await post(attempt, body(batch))).status).toBe(200);
      expect(resolveWrites(db)).toBe(1);
      expect(db.rows).toEqual(afterFirst);

      // New attempt still carrying the facts read before the first write: stale, no write, no receipt.
      const stale = await post("3a2b1c0d-9e8f-4a6b-8c4d-2e1f0a9b8c7d", body(batch));
      expect(stale.status).toBe(409);
      expect(await stale.json()).toEqual({
        error: { code: "stale_row_facts", message: new ImportRowResolveConflict("stale_row_facts").message },
      });
      expect(db.rows).toEqual(afterFirst);
      expect(receipts.size).toBe(1);

      // The first attempt reused with a different fix: changed intent, no write.
      const changed = await post(attempt, body(batch, { storageLocationId: "loc_other" }));
      expect(changed.status).toBe(409);
      expect(((await changed.json()) as { error: { code: string } }).error.code).toBe("attempt_conflict");
      expect(db.rows).toEqual(afterFirst);
      expect(receipts.size).toBe(1);
    });

    it("rolls a refused attempted resolve back without a receipt, so the same attempt can retry", async () => {
      const { db, receipts, post, body, batch } = await attemptedApp();
      db.batches.set(batch.batch_id, { ...db.batches.get(batch.batch_id)!, status: "committing" });
      const attempt = "4b3c2d1e-0f9a-4b7c-8d5e-3f2a1b0c9d8e";
      const refused = await post(attempt, body(batch));
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("batch_not_resolvable");
      expect(receipts.size).toBe(0);
      db.batches.set(batch.batch_id, { ...db.batches.get(batch.batch_id)!, status: "uploaded" });
      expect((await post(attempt, body(batch))).status).toBe(200);
      expect(receipts.size).toBe(1);
    });
  });
});
