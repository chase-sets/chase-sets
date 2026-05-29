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
import { createInventoryImportBatchRuntime } from "./runtime";

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

class ImportBatchDb implements PgQueryable {
  public readonly batches = new Map<string, StoredBatch>();
  public rows: StoredRow[] = [];
  public readonly locations = new Map<string, StoredLocation>();

  public async query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    if (sql.includes("FROM inventory_storage_locations")) {
      const location = this.locations.get(String(values[0]));
      const rows = location && (!values[1] || location.account_id === values[1]) ? [location] : [];
      return this.result(rows as Row[]);
    }

    if (sql.includes("FROM inventory_items AS item")) {
      return this.result([]);
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
    this.batches.set(batchId, {
      ...batch,
      total_count: rows.length,
      accepted_count: acceptedCount,
      rejected_count: rows.filter((row) => row.status === "rejected").length,
      committed_count: committedCount,
      status: rows.length > 0 && committedCount === acceptedCount ? "committed" : "uploaded",
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
    getCatalogItem: async (itemId) => {
      if (itemId === "cat_unknown") {
        return null;
      }

      return {
        catalog_item_id: itemId,
        title: itemId,
        subtitle: null,
        blueprint_id: null,
        status: itemId === "cat_inactive" ? "draft" : "active",
        product_schema: productSchema,
        updated_at: now,
      };
    },
    projectors: [],
  };
}

function itemServices(onCreate: (itemId: InventoryItemId) => void): InventoryItemServices {
  return {
    commandHandler: async () => {
      throw new Error("Not used by import batch tests.");
    },
    createItem: async (params) => {
      const itemId = params.itemIdOverride ?? ("inv_generated" as InventoryItemId);
      onCreate(itemId);
      return { itemId, version: 1 };
    },
    adjustItem: async () => {
      throw new Error("Not used by import batch tests.");
    },
    listItems: async () => ({ items: [], total: 0 }),
    getItem: async () => null,
    projectors: [],
  };
}

function runtime(db: ImportBatchDb, itemIds: InventoryItemId[] = []) {
  return createInventoryImportBatchRuntime({
    db,
    catalogItems: catalogServices(),
    items: itemServices((itemId) => itemIds.push(itemId)),
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
  return db;
}

describe("inventory import batch runtime", () => {
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
        query: async (sql, values = []) => {
          calls.push({ sql, values });
          return { rows: [], rowCount: 0 };
        },
      },
      catalogItems: catalogServices(),
      items: itemServices(() => undefined),
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
