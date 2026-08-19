import { describe, expect, it, vi } from "vitest";
import type { PgQueryResult, PgQueryable } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId, InventoryItemId } from "@chase-sets/primitives/typed-ids";
import type { InventoryCatalogItemServices } from "../../inventory-items/integrations/catalog/runtime";
import type {
  InventoryProductSchema,
  InventorySelectedOptionEntry,
} from "../../inventory-items/integrations/catalog/versioning";
import type { InventoryItemServices } from "../../inventory-items/api/runtime";
import {
  createInventoryImportBatchRuntime,
  serializeCreateBatchInputForIdempotency,
  shouldDeferImportBatchParentClaimForCreateUnitMiss,
} from "./runtime";
import { inventoryImportBatchSchemaSql } from "../read-model/schema";

type StoredBatch = Readonly<{
  batch_id: string;
  account_id: string;
  status: "uploaded" | "committed";
  source_key: string;
  adapter_version: number;
  quantity_mode: "add" | "replace";
  default_storage_location_id: string | null;
  source_filename: string | null;
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
  acquisition_cost_amount: string | null;
  seller_sku: string | null;
  listing_price_amount: string | null;
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
        source_filename: typeof values[6] === "string" ? values[6] : null,
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
          acquisition_cost_amount: typeof values[17] === "string" ? values[17] : null,
          seller_sku: typeof values[18] === "string" ? values[18] : null,
          listing_price_amount: typeof values[19] === "string" ? values[19] : null,
          listing_quantity_cap: typeof values[20] === "number" ? values[20] : null,
          row_note: typeof values[21] === "string" ? values[21] : null,
          validation_errors: JSON.parse(String(values[22])) as string[],
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
      this.rows = this.rows.map((row) =>
        row.row_id === rowId && row.batch_id === values[19]
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
              acquisition_cost_amount: typeof values[13] === "string" ? values[13] : null,
              seller_sku: typeof values[14] === "string" ? values[14] : null,
              listing_price_amount: typeof values[15] === "string" ? values[15] : null,
              listing_quantity_cap: typeof values[16] === "number" ? values[16] : null,
              row_note: typeof values[17] === "string" ? values[17] : null,
              validation_errors: JSON.parse(String(values[18])) as string[],
              updated_at: now,
            }
          : row,
      );
      return this.result([]);
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
              committed_at: row.committed_at ?? now,
              updated_at: now,
            }
          : row,
      );
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

    if (sql.includes("FROM inventory_import_batch_rows") && sql.includes("WHERE batch_id = $1")) {
      const rows = this.rows
        .filter((row) => row.batch_id === values[0])
        .sort((left, right) => left.row_number - right.row_number);
      return this.result(rows as Row[]);
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
    searchCatalogItems: async () => ({ items: [], total: 0 }),
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
        product_schema: itemId === "cat_form_condition" ? formConditionProductSchema : productSchema,
        updated_at: now,
      };
    },
    projectors: [],
  };
}

function itemServices(
  onCreate: (itemId: InventoryItemId) => void,
  onAdjust: (params: Parameters<InventoryItemServices["adjustItem"]>[0]) => void,
): InventoryItemServices {
  return {
    commandHandler: async () => {
      throw new Error("Not used by import batch tests.");
    },
    createItem: async (params) => {
      const itemId = params.itemIdOverride ?? ("inv_generated" as InventoryItemId);
      onCreate(itemId);
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
) {
  return createInventoryImportBatchRuntime({
    db,
    catalogItems: catalogServices(),
    items: itemServices(
      (itemId) => itemIds.push(itemId),
      (params) => adjustments.push(params),
    ),
    draftListingCreator: vi.fn(async (params) => ({
      listingId: params.listingIdOverride,
      version: 1,
      feeQuoteFingerprint: "fee_1",
    })),
  });
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
  it("keeps import batch schema additive for existing staging databases", () => {
    expect(inventoryImportBatchSchemaSql).toContain("ADD COLUMN IF NOT EXISTS source_filename text NULL");
    expect(inventoryImportBatchSchemaSql).toContain("ADD COLUMN IF NOT EXISTS seller_sku text NULL");
    expect(inventoryImportBatchSchemaSql).toContain(
      "ADD COLUMN IF NOT EXISTS listing_price_amount numeric(12, 2) NULL",
    );
    expect(inventoryImportBatchSchemaSql).toContain("ADD COLUMN IF NOT EXISTS committed_listing_id text NULL");
    expect(inventoryImportBatchSchemaSql).toContain("CREATE TABLE IF NOT EXISTS inventory_import_account_sku_mappings");
    expect(inventoryImportBatchSchemaSql).toContain("inventory_import_account_sku_mappings_lookup_idx");
  });

  it("only defers parent job reconciliation while create work-unit capacity is exhausted", () => {
    expect(shouldDeferImportBatchParentClaimForCreateUnitMiss("workflow_budget_exhausted")).toBe(true);
    expect(shouldDeferImportBatchParentClaimForCreateUnitMiss("job_budget_exhausted")).toBe(true);
    expect(shouldDeferImportBatchParentClaimForCreateUnitMiss("none_available")).toBe(false);
    expect(shouldDeferImportBatchParentClaimForCreateUnitMiss("claimed")).toBe(false);
    expect(shouldDeferImportBatchParentClaimForCreateUnitMiss(undefined)).toBe(false);
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
      "catalogItemId,storageLocationId,totalQuantity,option:form,option:condition,acquisitionCostAmount,sellerSku,listingPriceAmount,listingQuantityCap,rowNote",
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
      updated_at: now,
    });
    const services = runtime(db);

    const csv = await services.getNativeCsvExport({ accountId: "acc_1" as AccountId });

    expect(csv).toBe(
      [
        "catalogItemId,storageLocationId,totalQuantity,option:condition,acquisitionCostAmount,sellerSku,listingPriceAmount,listingQuantityCap,rowNote",
        "cat_active,loc_active,6,near_mint,1.25,,,,",
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
          "catalogItemId,storageLocationId,totalQuantity,option:condition,acquisitionCostAmount,listingPriceAmount,listingQuantityCap",
          "cat_active,loc_active,2,near_mint,1.25,4.50,1",
          "cat_unknown,loc_active,2,near_mint,,,",
          "cat_inactive,loc_active,2,near_mint,,,",
          "cat_active,loc_active,2,bad_option,,,",
          "cat_active,loc_archived,2,near_mint,,,",
          "cat_active,loc_active,0,near_mint,,,",
          "cat_active,loc_active,2,near_mint,bad-money,,",
          "cat_active,loc_active,2,near_mint,,4.50,",
        ].join("\n"),
      },
      context,
    );

    expect(batch.total_count).toBe(8);
    expect(batch.accepted_count).toBe(1);
    expect(batch.rejected_count).toBe(7);
    expect(batch.rows[0]).toMatchObject({
      status: "accepted",
      product_id: "cat_active::condition:near_mint",
      selected_options: [{ dimensionId: "condition", optionId: "near_mint" }],
      listing_price_amount: "4.50",
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
        "listingQuantityCap is required when listingPriceAmount is set.",
      ]),
    );
  });

  it("accepts native option columns that use visible dimension and option labels", async () => {
    const services = runtime(dbWithLocations());
    const batch = await services.createBatch(
      {
        accountId: "acc_1" as AccountId,
        csvText: [
          "catalogItemId,storageLocationId,totalQuantity,option:form,option:condition,listingPriceAmount,listingQuantityCap",
          "cat_form_condition,loc_active,1,Raw,Damaged,5.55,1",
          "cat_form_condition,loc_active,2,Raw,Near Mint,6.66,1",
          "cat_unknown,loc_active,3,Raw,Near Mint,7.77,1",
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
      validation_errors: ["Seller SKU 'missing-sku' is not mapped for this account."],
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
          "catalogItemId,storageLocationId,totalQuantity,option:condition,listingPriceAmount,listingQuantityCap",
          "cat_active,loc_active,3,near_mint,5.00,2",
        ].join("\n"),
      },
      context,
    );

    const firstCommit = await services.commitBatch(
      { accountId: "acc_1" as AccountId, batchId: batch.batch_id },
      context,
    );
    const secondCommit = await services.commitBatch(
      { accountId: "acc_1" as AccountId, batchId: batch.batch_id },
      context,
    );

    expect(itemIds).toHaveLength(1);
    expect(firstCommit.rows[0]?.committed_inventory_item_id).toBe(itemIds[0]);
    expect(firstCommit.rows[0]?.committed_listing_id).toBeDefined();
    expect(secondCommit.rows[0]).toMatchObject(firstCommit.rows[0] ?? {});
    const existingTargetQuery = db.queries.find(
      (query) => query.sql.includes("FROM inventory_items AS item") && query.sql.includes("inventory_holds"),
    );
    expect(existingTargetQuery?.sql).toContain("LEFT JOIN LATERAL");
    expect(existingTargetQuery?.sql).toContain("WHERE inventory_holds.item_id = item.item_id");
    expect(existingTargetQuery?.sql).not.toContain("GROUP BY item_id");
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
          "catalogItemId,storageLocationId,totalQuantity,option:condition",
          "cat_active,loc_active,12,near_mint",
          "cat_active,loc_active,8,near_mint",
          "cat_active,loc_active,10,near_mint",
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
      updated_at: now,
    });

    await services.commitBatch({ accountId: "acc_1" as AccountId, batchId: replaceBatch.batch_id }, context);

    const addBatch = await services.createBatch(
      {
        accountId: "acc_1" as AccountId,
        quantityMode: "add",
        csvText: [
          "catalogItemId,storageLocationId,totalQuantity,option:condition",
          "cat_active,loc_active,3,near_mint",
          "cat_active,loc_active,-2,near_mint",
          "cat_active,loc_active,0,near_mint",
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
  });

  it("marks mixed imports committed after accepted rows commit while preserving rejected rows", async () => {
    const itemIds: InventoryItemId[] = [];
    const db = dbWithLocations();
    const services = runtime(db, itemIds);
    const batch = await services.createBatch(
      {
        accountId: "acc_1" as AccountId,
        csvText: [
          "catalogItemId,storageLocationId,totalQuantity,option:condition,listingPriceAmount,listingQuantityCap",
          "cat_active,loc_active,2,near_mint,4.44,1",
          "cat_unknown,loc_active,2,near_mint,,",
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
          "TCGplayer SKU,Product Name,Set Name,Condition,Quantity,TCG Marketplace Price",
          "tcg_sku_1,Charizard,Base Set,Near Mint,4,12.50",
          "tcg_unknown,Pikachu,Jungle,Lightly Played,2,1.25",
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
          "TCGplayer SKU,Product ID,Product Name,Set Name,Condition,Quantity,TCG Marketplace Price",
          "missing_sku,12345,Pikachu,Jungle,Near Mint,4,12.50",
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
          "Product ID,Product Name,Set Name,Condition,Quantity,TCG Marketplace Price",
          "12345,Pikachu,Jungle,Near Mint,4,12.50",
          "12345,Pikachu,Jungle,Damaged,2,1.25",
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
      resolution_status: "resolved",
      catalog_item_id: "cat_active",
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
        csvText: "Title,Variant ID,Variant SKU,Variant Inventory Qty,Variant Price\nCharizard,987,box-1,2,9.50",
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
