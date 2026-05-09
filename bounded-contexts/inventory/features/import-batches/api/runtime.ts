import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { AccountId, InventoryItemId, ListingId } from "@chase-sets/primitives/typed-ids";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { InventoryCatalogItemServices } from "../../inventory-items/integrations/catalog/runtime";
import {
  createInventoryProductDescriptor,
  parseSelectedOptionsInput,
  type InventorySelectedOptionEntry,
} from "../../inventory-items/integrations/catalog/versioning";
import type { InventoryItemServices } from "../../inventory-items/api/runtime";
import { getStorageLocation } from "../../storage-locations/read-model/queries";
import { InventoryDomainError } from "../../../support/runtime-support/common";
import { parseImportCsv, type ImportCsvRow } from "../domain/csv";
import {
  getImportBatch,
  listImportBatches,
  type InventoryImportBatchDetail,
  type InventoryImportRowStatus,
} from "../read-model/queries";

export type InventoryDraftListingCreator = (
  params: Readonly<{
    accountId: string;
    importBatchId: string;
    importRowId: string;
    inventoryItemId: string;
    listingIdOverride: ListingId;
    catalogItemId: string;
    productId: string;
    selectedOptions: readonly InventorySelectedOptionEntry[];
    storageLocationId: string;
    storageLocationName: string;
    shipFromCode: string;
    totalQuantity: number;
    acquisitionCostAmount: string | null;
    priceAmount: string;
    quantityCap: number;
  }>,
  context: EventStoreContext,
) => Promise<{ listingId: ListingId; version: number; feeQuoteFingerprint: string }>;

export type InventoryImportBatchServices = Readonly<{
  createBatch: (
    params: Readonly<{
      accountId: AccountId;
      csvText?: string;
      parsedRows?: readonly ImportCsvRow[];
      sourceFilename?: string | null;
    }>,
    context: EventStoreContext,
  ) => Promise<InventoryImportBatchDetail>;
  getBatch: (
    batchId: string,
    accountId: string,
  ) => ReturnType<typeof getImportBatch>;
  listBatches: (
    params: Parameters<typeof listImportBatches>[1],
  ) => ReturnType<typeof listImportBatches>;
  commitBatch: (
    params: Readonly<{ batchId: string; accountId: AccountId }>,
    context: EventStoreContext,
  ) => Promise<InventoryImportBatchDetail>;
}>;

type InventoryImportBatchRuntimeDeps = Readonly<{
  db: PgQueryable;
  items: InventoryItemServices;
  catalogItems: InventoryCatalogItemServices;
  draftListingCreator?: InventoryDraftListingCreator;
}>;

type ValidatedImportRow = Readonly<{
  status: InventoryImportRowStatus;
  catalogItemId: string | null;
  productId: string | null;
  selectedOptions: readonly InventorySelectedOptionEntry[];
  storageLocationId: string | null;
  totalQuantity: number | null;
  acquisitionCostAmount: string | null;
  sellerSku: string | null;
  listingPriceAmount: string | null;
  listingQuantityCap: number | null;
  rowNote: string | null;
  validationErrors: readonly string[];
}>;

const MONEY_PATTERN = /^\d+(\.\d{1,2})?$/;

function clean(value: string | undefined) {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

function positiveWholeNumber(value: string | null, fieldName: string, errors: string[]) {
  if (!value) {
    errors.push(`${fieldName} is required.`);
    return null;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    errors.push(`${fieldName} must be a positive whole number.`);
    return null;
  }

  return parsed;
}

function moneyAmount(value: string | null, fieldName: string, errors: string[]) {
  if (!value) {
    return null;
  }

  if (!MONEY_PATTERN.test(value) || Number(value) <= 0) {
    errors.push(`${fieldName} must be a positive decimal amount.`);
    return null;
  }

  return Number(value).toFixed(2);
}

function optionalMoneyAmount(value: string | null, fieldName: string, errors: string[]) {
  if (!value) {
    return null;
  }

  if (!MONEY_PATTERN.test(value) || Number(value) < 0) {
    errors.push(`${fieldName} must be a zero-or-greater decimal amount.`);
    return null;
  }

  return Number(value).toFixed(2);
}

function optionEntries(values: Readonly<Record<string, string>>) {
  return Object.entries(values)
    .filter(([key, value]) => key.startsWith("option:") && value.trim().length > 0)
    .map(([key, value]) => ({
      dimensionId: key.slice("option:".length).trim(),
      optionId: value.trim(),
    }))
    .filter((entry) => entry.dimensionId.length > 0);
}

function itemIdForRow(rowId: string): InventoryItemId {
  return rowId.replace(/^imr_/, "inv_") as InventoryItemId;
}

function listingIdForRow(rowId: string): ListingId {
  return rowId.replace(/^imr_/, "lst_") as ListingId;
}

async function refreshBatchCounts(db: PgQueryable, batchId: string) {
  await db.query(
    `UPDATE inventory_import_batches AS batch
     SET total_count = counts.total_count,
         accepted_count = counts.accepted_count,
         rejected_count = counts.rejected_count,
         committed_count = counts.committed_count,
         status = CASE
           WHEN counts.total_count > 0 AND counts.committed_count = counts.accepted_count THEN 'committed'
           ELSE 'uploaded'
         END,
         updated_at = now()
     FROM (
       SELECT
         COUNT(*)::integer AS total_count,
         COUNT(*) FILTER (WHERE status IN ('accepted', 'committed'))::integer AS accepted_count,
         COUNT(*) FILTER (WHERE status = 'rejected')::integer AS rejected_count,
         COUNT(*) FILTER (WHERE status = 'committed')::integer AS committed_count
       FROM inventory_import_batch_rows
       WHERE batch_id = $1
     ) AS counts
     WHERE batch.batch_id = $1`,
    [batchId],
  );
}

export function createInventoryImportBatchRuntime(
  deps: InventoryImportBatchRuntimeDeps,
): InventoryImportBatchServices {
  async function validateRow(
    accountId: AccountId,
    values: Readonly<Record<string, string>>,
  ): Promise<ValidatedImportRow> {
    const errors: string[] = [];
    const catalogItemId = clean(values.catalogItemId);
    const storageLocationId = clean(values.storageLocationId);
    const totalQuantity = positiveWholeNumber(
      clean(values.totalQuantity),
      "totalQuantity",
      errors,
    );
    const selectedOptions = optionEntries(values);
    let productId: string | null = null;

    if (!catalogItemId) {
      errors.push("catalogItemId is required.");
    } else {
      const catalogItem = await deps.catalogItems.getCatalogItem(catalogItemId);
      if (!catalogItem) {
        errors.push("Catalog item was not found.");
      } else if (catalogItem.status !== "active") {
        errors.push("Catalog item must be active.");
      } else {
        try {
          const descriptor = createInventoryProductDescriptor({
            catalogItemId,
            productSchema: catalogItem.product_schema,
            selection: parseSelectedOptionsInput(selectedOptions),
          });
          productId = descriptor.productId;
        } catch (error) {
          errors.push(error instanceof Error ? error.message : "Selected options are invalid.");
        }
      }
    }

    if (!storageLocationId) {
      errors.push("storageLocationId is required.");
    } else {
      const location = await getStorageLocation(deps.db, storageLocationId, accountId);
      if (!location) {
        errors.push("Storage location was not found.");
      } else if (location.is_archived) {
        errors.push("Storage location is archived.");
      }
    }

    const acquisitionCostAmount = optionalMoneyAmount(
      clean(values.acquisitionCostAmount),
      "acquisitionCostAmount",
      errors,
    );
    const listingPriceValue = clean(values.listingPriceAmount);
    const listingCapValue = clean(values.listingQuantityCap);
    const hasListingDraftFields = Boolean(listingPriceValue || listingCapValue);
    const listingPriceAmount = moneyAmount(
      listingPriceValue,
      "listingPriceAmount",
      errors,
    );
    const listingQuantityCap = listingCapValue
      ? positiveWholeNumber(listingCapValue, "listingQuantityCap", errors)
      : null;

    if (hasListingDraftFields) {
      if (!listingPriceValue) {
        errors.push("listingPriceAmount is required when listingQuantityCap is set.");
      }
      if (!listingCapValue) {
        errors.push("listingQuantityCap is required when listingPriceAmount is set.");
      }
      if (listingQuantityCap !== null && totalQuantity !== null && listingQuantityCap > totalQuantity) {
        errors.push("listingQuantityCap cannot exceed totalQuantity.");
      }
    }

    return {
      status: errors.length > 0 ? "rejected" : "accepted",
      catalogItemId,
      productId,
      selectedOptions,
      storageLocationId,
      totalQuantity,
      acquisitionCostAmount,
      sellerSku: clean(values.sellerSku),
      listingPriceAmount: hasListingDraftFields ? listingPriceAmount : null,
      listingQuantityCap: hasListingDraftFields ? listingQuantityCap : null,
      rowNote: clean(values.rowNote),
      validationErrors: errors,
    };
  }

  return {
    createBatch: async (params) => {
      const rows = params.parsedRows ?? parseImportCsv(params.csvText ?? "");
      if (rows.length === 0) {
        throw new InventoryDomainError("Import CSV must include at least one data row.");
      }

      const batchId = createId("imb");
      await deps.db.query(
        `INSERT INTO inventory_import_batches (
          batch_id,
          account_id,
          status,
          source_filename,
          created_at,
          updated_at
        ) VALUES ($1, $2, 'uploaded', $3, now(), now())`,
        [batchId, params.accountId, params.sourceFilename ?? null],
      );

      for (const row of rows) {
        const rowId = createId("imr");
        const validated = await validateRow(params.accountId, row.values);
        await deps.db.query(
          `INSERT INTO inventory_import_batch_rows (
            row_id,
            batch_id,
            row_number,
            status,
            raw_row,
            catalog_item_id,
            product_id,
            selected_options,
            storage_location_id,
            total_quantity,
            acquisition_cost_amount,
            seller_sku,
            listing_price_amount,
            listing_quantity_cap,
            row_note,
            validation_errors,
            created_at,
            updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15, $16, now(), now()
          )`,
          [
            rowId,
            batchId,
            row.rowNumber,
            validated.status,
            JSON.stringify(row.values),
            validated.catalogItemId,
            validated.productId,
            JSON.stringify(validated.selectedOptions),
            validated.storageLocationId,
            validated.totalQuantity,
            validated.acquisitionCostAmount,
            validated.sellerSku,
            validated.listingPriceAmount,
            validated.listingQuantityCap,
            validated.rowNote,
            JSON.stringify(validated.validationErrors),
          ],
        );
      }

      await refreshBatchCounts(deps.db, batchId);
      const detail = await getImportBatch(deps.db, batchId, params.accountId);
      if (!detail) {
        throw new InventoryDomainError("Import batch could not be loaded.");
      }
      return detail;
    },
    getBatch: (batchId, accountId) => getImportBatch(deps.db, batchId, accountId),
    listBatches: (params) => listImportBatches(deps.db, params),
    commitBatch: async (params, context) => {
      const detail = await getImportBatch(deps.db, params.batchId, params.accountId);
      if (!detail) {
        throw new InventoryDomainError("Import batch not found.");
      }

      const rowsToCommit = detail.rows.filter((row) =>
        row.status === "accepted" || row.status === "committed",
      );

      for (const row of rowsToCommit) {
        if (row.status === "committed") {
          continue;
        }

        if (
          !row.catalog_item_id ||
          !row.storage_location_id ||
          !row.total_quantity ||
          !row.product_id
        ) {
          continue;
        }

        const inventoryItemId = itemIdForRow(row.row_id);
        const itemResult = await deps.items.createItem(
          {
            accountId: params.accountId,
            catalogItemId: row.catalog_item_id,
            selectedOptions: row.selected_options,
            storageLocationId: row.storage_location_id,
            totalQuantity: row.total_quantity,
            acquisitionCostAmount: row.acquisition_cost_amount,
            itemIdOverride: inventoryItemId,
          },
          context,
        );

        let listingId: string | null = row.committed_listing_id;
        if (
          row.listing_price_amount &&
          row.listing_quantity_cap &&
          deps.draftListingCreator
        ) {
          const location = await getStorageLocation(
            deps.db,
            row.storage_location_id,
            params.accountId,
          );
          if (!location) {
            throw new InventoryDomainError("Storage location not found.");
          }

          const listing = await deps.draftListingCreator(
            {
              accountId: params.accountId,
              importBatchId: params.batchId,
              importRowId: row.row_id,
              inventoryItemId: itemResult.itemId,
              listingIdOverride: listingIdForRow(row.row_id),
              catalogItemId: row.catalog_item_id,
              productId: row.product_id,
              selectedOptions: row.selected_options,
              storageLocationId: row.storage_location_id,
              storageLocationName: location.name,
              shipFromCode: location.ship_from_code,
              totalQuantity: row.total_quantity,
              acquisitionCostAmount: row.acquisition_cost_amount,
              priceAmount: row.listing_price_amount,
              quantityCap: row.listing_quantity_cap,
            },
            context,
          );
          listingId = listing.listingId;
        }

        await deps.db.query(
          `UPDATE inventory_import_batch_rows
           SET status = 'committed',
               committed_inventory_item_id = $2,
               committed_listing_id = $3,
               committed_at = COALESCE(committed_at, now()),
               updated_at = now()
           WHERE row_id = $1`,
          [row.row_id, itemResult.itemId, listingId],
        );
      }

      await refreshBatchCounts(deps.db, params.batchId);
      const committed = await getImportBatch(deps.db, params.batchId, params.accountId);
      if (!committed) {
        throw new InventoryDomainError("Import batch not found.");
      }
      return committed;
    },
  };
}
