import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  createPostgresDurableJobStore,
  type DurableJobEvent,
  type DurableJobPublicSnapshot,
  type DurableJobRecord,
  toDurableJobPublicSnapshot,
} from "@chase-sets/platform-runtime/durable-job-store";
import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { AccountId, InventoryItemId, ListingId } from "@chase-sets/primitives/typed-ids";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { InventoryCatalogItemServices } from "../../inventory-items/integrations/catalog/runtime";
import {
  createInventoryProductDescriptor,
  parseSelectedOptionsInput,
  type InventoryProductDimension,
  type InventoryProductOption,
  type InventoryProductSchema,
  type InventorySelectedOptionEntry,
} from "../../inventory-items/integrations/catalog/versioning";
import type { InventoryItemServices } from "../../inventory-items/api/runtime";
import { getStorageLocation } from "../../storage-locations/read-model/queries";
import { InventoryDomainError } from "../../../support/runtime-support/common";
import type { ImportCsvRow } from "../domain/csv";
import {
  getInventoryImportSourceAdapter,
  type InventoryImportExternalReference,
  type InventoryImportQuantityMode,
  type InventoryImportSourceKey,
  type NormalizedInventoryImportRow,
} from "../domain/import-source-adapters";
import {
  getImportBatch,
  listImportBatches,
  type InventoryImportBatchDetail,
  type InventoryImportResolutionStatus,
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
    shipFromAddress: AddressSnapshot;
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
      sourceKey?: InventoryImportSourceKey;
      quantityMode?: InventoryImportQuantityMode;
      defaultStorageLocationId?: string | null;
      sourceFilename?: string | null;
    }>,
    context: EventStoreContext,
  ) => Promise<InventoryImportBatchDetail>;
  getBatch: (batchId: string, accountId: string) => ReturnType<typeof getImportBatch>;
  listBatches: (params: Parameters<typeof listImportBatches>[1]) => ReturnType<typeof listImportBatches>;
  commitBatch: (
    params: Readonly<{ batchId: string; accountId: AccountId }>,
    context: EventStoreContext,
  ) => Promise<InventoryImportBatchDetail>;
  enqueueCommitBatchJob: (
    params: Readonly<{ batchId: string; accountId: AccountId }>,
    context: EventStoreContext,
  ) => Promise<InventoryImportBatchJob>;
  enqueueCreateBatchJob: (
    params: Parameters<InventoryImportBatchServices["createBatch"]>[0],
    context: EventStoreContext,
  ) => Promise<InventoryImportBatchJob>;
  getImportBatchJob: (jobId: string) => Promise<InventoryImportBatchJob | null>;
  listImportBatchJobEvents: (
    jobId: string,
    afterSequence?: number,
  ) => Promise<
    readonly DurableJobEvent<
      InventoryImportBatchJobPayload,
      InventoryImportBatchJobProgress,
      InventoryImportBatchJobResult
    >[]
  >;
  processNextImportBatchJob: (input: {
    claimOwnerId: string;
    claimTtlMs: number;
    signal?: AbortSignal;
    throwIfLeaseLost?: () => void;
  }) => Promise<number>;
}>;

type InventoryImportBatchRuntimeDeps = Readonly<{
  db: PgQueryable;
  items: InventoryItemServices;
  catalogItems: InventoryCatalogItemServices;
  draftListingCreator?: InventoryDraftListingCreator;
}>;

type ValidatedImportRow = Readonly<{
  status: InventoryImportRowStatus;
  externalReference: InventoryImportExternalReference | null;
  rowFingerprint: string;
  quantityMode: InventoryImportQuantityMode;
  quantityDelta: number | null;
  setQuantity: number | null;
  sourcePriceAmount: string | null;
  resolutionStatus: InventoryImportResolutionStatus;
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

type ExistingImportTargetItem = Readonly<{
  item_id: string;
  total_quantity: number;
  held_quantity: number;
}>;

const MONEY_PATTERN = /^\d+(\.\d{1,2})?$/;
const IMPORT_BATCH_JOB_KIND_CREATE = "create";
const IMPORT_BATCH_JOB_KIND_COMMIT = "commit";

export type InventoryImportBatchJobPayload = Readonly<{
  batchId?: string;
  accountId: string;
  create?: Readonly<{
    inputId: string;
  }>;
}>;

export type InventoryImportBatchJobProgress = Readonly<{
  phase: "queued" | "processing" | "completed" | "failed";
  completed: number;
  total: number;
  currentRowId: string | null;
  message: string | null;
}>;

export type InventoryImportBatchJobResult = Readonly<{
  batch: InventoryImportBatchDetail;
}>;

export type InventoryImportBatchJob = DurableJobRecord<
  InventoryImportBatchJobPayload,
  InventoryImportBatchJobProgress,
  InventoryImportBatchJobResult
>;

export type InventoryImportBatchJobStatus = DurableJobPublicSnapshot<
  InventoryImportBatchJobProgress,
  InventoryImportBatchJobResult
>;

type InventoryImportBatchJobInput = Readonly<{
  inputId: string;
  accountId: AccountId;
  csvText?: string;
  parsedRows?: readonly ImportCsvRow[];
  sourceKey?: InventoryImportSourceKey;
  quantityMode?: InventoryImportQuantityMode;
  defaultStorageLocationId?: string | null;
  sourceFilename?: string | null;
}>;

export function toInventoryImportBatchJobStatus(job: InventoryImportBatchJob): InventoryImportBatchJobStatus {
  return toDurableJobPublicSnapshot(job);
}

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

function wholeNumber(value: string | null, fieldName: string, errors: string[]) {
  if (!value) {
    errors.push(`${fieldName} is required.`);
    return null;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    errors.push(`${fieldName} must be a whole number.`);
    return null;
  }

  return parsed;
}

function importedQuantity(value: string | null, quantityMode: InventoryImportQuantityMode, errors: string[]) {
  const parsed = wholeNumber(value, "totalQuantity", errors);
  if (parsed === null) {
    return { quantityDelta: null, setQuantity: null, displayQuantity: null };
  }

  if (quantityMode === "replace") {
    if (parsed < 0) {
      errors.push("replace imports require totalQuantity to be zero or greater.");
      return { quantityDelta: null, setQuantity: null, displayQuantity: null };
    }

    return { quantityDelta: null, setQuantity: parsed, displayQuantity: parsed };
  }

  if (parsed === 0) {
    errors.push("add imports require totalQuantity to be a non-zero whole number.");
    return { quantityDelta: null, setQuantity: null, displayQuantity: null };
  }

  return { quantityDelta: parsed, setQuantity: null, displayQuantity: parsed };
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

function normalizeExternalReference(
  reference: InventoryImportExternalReference | null,
): InventoryImportExternalReference | null {
  if (!reference) {
    return null;
  }

  return {
    providerKey: reference.providerKey.trim().toLowerCase(),
    externalKey: reference.externalKey.trim().toLowerCase(),
    displayName: clean(reference.displayName ?? undefined),
    targetIntent: reference.targetIntent,
  };
}

function normalizeExternalReferences(row: NormalizedInventoryImportRow): readonly InventoryImportExternalReference[] {
  const rowReferences = row.externalReferences ?? [];
  const references = rowReferences.length > 0 ? rowReferences : row.externalReference ? [row.externalReference] : [];
  const normalized = references
    .map(normalizeExternalReference)
    .filter((reference): reference is InventoryImportExternalReference => Boolean(reference));
  const seen = new Set<string>();

  return normalized.filter((reference) => {
    const key = `${reference.providerKey}:${reference.externalKey}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function normalizeChoiceText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function optionMatchKeys(option: InventoryProductOption): Set<string> {
  return new Set(
    [option.optionId, option.code, option.label]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map(normalizeChoiceText),
  );
}

function resolveOptionId(options: readonly InventoryProductOption[], value: string | null | undefined): string | null {
  const normalized = value ? normalizeChoiceText(value) : "";
  if (!normalized) {
    return null;
  }

  const option = options.find((candidate) => optionMatchKeys(candidate).has(normalized));
  return option?.optionId ?? null;
}

function rowValueForKey(record: Readonly<Record<string, string>>, keys: readonly string[]): string | null {
  const normalizedKeys = new Set(keys.map(normalizeChoiceText));
  for (const [key, value] of Object.entries(record)) {
    if (normalizedKeys.has(normalizeChoiceText(key)) && value.trim().length > 0) {
      return value;
    }
  }

  return null;
}

function optionCandidateValue(dimension: InventoryProductDimension, row: NormalizedInventoryImportRow): string | null {
  const profileCandidate = row.selectedOptionCandidates.find(
    (candidate) => normalizeChoiceText(candidate.dimensionKey) === normalizeChoiceText(dimension.dimensionId),
  );
  if (profileCandidate?.value.trim()) {
    return profileCandidate.value;
  }

  const keys = [`option:${dimension.dimensionId}`, dimension.dimensionId, dimension.dimensionName];

  return rowValueForKey(row.values, keys) ?? rowValueForKey(row.rawRow, keys);
}

function normalizeSelectedOptionsForSchema(
  schema: InventoryProductSchema | null,
  selection: readonly InventorySelectedOptionEntry[],
  row: NormalizedInventoryImportRow,
): InventorySelectedOptionEntry[] {
  if (!schema) {
    return [...selection];
  }

  const byDimension = new Map(selection.map((entry) => [entry.dimensionId, entry.optionId]));

  for (const dimension of schema.dimensions) {
    const currentOptionId = byDimension.get(dimension.dimensionId);
    const resolvedCurrent = resolveOptionId(dimension.allowedOptions, currentOptionId);
    if (resolvedCurrent) {
      byDimension.set(dimension.dimensionId, resolvedCurrent);
      continue;
    }

    const candidateValue = optionCandidateValue(dimension, row);
    const inferredOptionId = resolveOptionId(dimension.allowedOptions, candidateValue);
    if (inferredOptionId) {
      byDimension.set(dimension.dimensionId, inferredOptionId);
    }
  }

  return [...byDimension.entries()].map(([dimensionId, optionId]) => ({ dimensionId, optionId }));
}

function itemIdForRow(rowId: string): InventoryItemId {
  return rowId.replace(/^imr_/, "inv_") as InventoryItemId;
}

async function findExistingImportTargetItem(
  db: PgQueryable,
  params: Readonly<{
    accountId: string;
    catalogItemId: string;
    productId: string;
    selectedOptions: readonly InventorySelectedOptionEntry[];
    storageLocationId: string;
  }>,
): Promise<ExistingImportTargetItem | null> {
  const result = await db.query<ExistingImportTargetItem>(
    `SELECT
       item.item_id,
       item.total_quantity,
       COALESCE(active_holds.held_quantity, 0)::integer AS held_quantity
     FROM inventory_items AS item
     LEFT JOIN (
       SELECT item_id, SUM(quantity)::integer AS held_quantity
       FROM inventory_holds
       WHERE status = 'active'
       GROUP BY item_id
     ) AS active_holds
       ON active_holds.item_id = item.item_id
     WHERE item.account_id = $1
       AND item.catalog_catalog_item_id = $2
       AND item.product_id = $3
       AND item.selected_options = $4::jsonb
       AND item.storage_location_id = $5
     ORDER BY item.created_at ASC, item.item_id ASC
     LIMIT 1`,
    [
      params.accountId,
      params.catalogItemId,
      params.productId,
      JSON.stringify(params.selectedOptions),
      params.storageLocationId,
    ],
  );

  return result.rows[0] ?? null;
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

export function createInventoryImportBatchRuntime(deps: InventoryImportBatchRuntimeDeps): InventoryImportBatchServices {
  const jobStore = createPostgresDurableJobStore<
    InventoryImportBatchJobPayload,
    InventoryImportBatchJobProgress,
    InventoryImportBatchJobResult
  >(deps.db, {
    jobsTable: "inventory_import_batch_jobs",
    eventsTable: "inventory_import_batch_job_events",
  });

  async function stageCreateBatchJobInput(params: Parameters<InventoryImportBatchServices["createBatch"]>[0]) {
    const inputId = createId("job_input");
    await deps.db.query(
      `INSERT INTO inventory_import_batch_job_inputs (
         input_id,
         account_id,
         csv_text,
         parsed_rows,
         source_key,
         quantity_mode,
         default_storage_location_id,
         source_filename,
         created_at
       ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, now())`,
      [
        inputId,
        params.accountId,
        params.csvText ?? null,
        params.parsedRows ? JSON.stringify(params.parsedRows) : null,
        params.sourceKey ?? null,
        params.quantityMode ?? null,
        params.defaultStorageLocationId ?? null,
        params.sourceFilename ?? null,
      ],
    );
    return inputId;
  }

  async function loadCreateBatchJobInput(inputId: string, accountId: AccountId): Promise<InventoryImportBatchJobInput> {
    const result = await deps.db.query<{
      input_id: string;
      account_id: string;
      csv_text: string | null;
      parsed_rows: unknown;
      source_key: InventoryImportSourceKey | null;
      quantity_mode: InventoryImportQuantityMode | null;
      default_storage_location_id: string | null;
      source_filename: string | null;
    }>(
      `SELECT input_id,
              account_id,
              csv_text,
              parsed_rows,
              source_key,
              quantity_mode,
              default_storage_location_id,
              source_filename
       FROM inventory_import_batch_job_inputs
       WHERE input_id = $1
         AND account_id = $2`,
      [inputId, accountId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new InventoryDomainError("Import batch job input not found.");
    }

    return {
      inputId: row.input_id,
      accountId: row.account_id as AccountId,
      csvText: row.csv_text ?? undefined,
      parsedRows: row.parsed_rows == null ? undefined : readJsonValue<readonly ImportCsvRow[]>(row.parsed_rows),
      sourceKey: row.source_key ?? undefined,
      quantityMode: row.quantity_mode ?? undefined,
      defaultStorageLocationId: row.default_storage_location_id,
      sourceFilename: row.source_filename,
    };
  }

  async function deleteCreateBatchJobInput(inputId: string) {
    await deps.db.query(`DELETE FROM inventory_import_batch_job_inputs WHERE input_id = $1`, [inputId]);
  }

  async function validateRow(
    accountId: AccountId,
    row: NormalizedInventoryImportRow,
    quantityMode: InventoryImportQuantityMode,
  ): Promise<ValidatedImportRow> {
    const errors: string[] = [];
    const values = row.values;
    const externalReferences = normalizeExternalReferences(row);
    let externalReference = externalReferences[0] ?? null;
    let catalogItemId = clean(values.catalogItemId);
    const storageLocationId = clean(values.storageLocationId);
    const imported = importedQuantity(clean(values.totalQuantity), quantityMode, errors);
    let selectedOptions: readonly InventorySelectedOptionEntry[] = optionEntries(values);
    let productId: string | null = null;
    let resolutionStatus: InventoryImportResolutionStatus = catalogItemId ? "native" : "unresolved";

    if (!catalogItemId && externalReferences.length > 0) {
      for (const candidate of externalReferences) {
        if (candidate.targetIntent !== "catalog-item-reference" && candidate.targetIntent !== "account-sku") {
          const mapping = await deps.catalogItems.getExternalProductReference(
            candidate.providerKey,
            candidate.externalKey,
          );
          if (mapping) {
            externalReference = candidate;
            catalogItemId = mapping.catalog_item_id;
            selectedOptions = mapping.selected_options;
            resolutionStatus = "resolved";
            break;
          }
        }

        if (candidate.targetIntent !== "product-reference" && candidate.targetIntent !== "account-sku") {
          const catalogItemMapping = await deps.catalogItems.getExternalCatalogItemReference(
            candidate.providerKey,
            candidate.externalKey,
          );
          if (catalogItemMapping) {
            externalReference = candidate;
            catalogItemId = catalogItemMapping.catalog_item_id;
            resolutionStatus = "resolved";
            break;
          }
        }
      }

      if (!catalogItemId) {
        const candidateList = externalReferences
          .map((candidate) => `${candidate.providerKey}:${candidate.externalKey}`)
          .join(", ");
        errors.push(
          externalReferences.length === 1
            ? "External product reference is not mapped to a Chase Sets catalog item."
            : `External product references are not mapped to Chase Sets catalog items: ${candidateList}.`,
        );
      }
    } else if (!catalogItemId && externalReferences.length === 0) {
      errors.push("catalogItemId is required.");
    }

    if (!catalogItemId) {
      resolutionStatus = externalReference ? "unresolved" : "native";
    } else {
      const catalogItem = await deps.catalogItems.getCatalogItem(catalogItemId);
      if (!catalogItem) {
        errors.push("Catalog item was not found.");
      } else if (catalogItem.status !== "active") {
        errors.push("Catalog item must be active.");
      } else {
        try {
          selectedOptions = normalizeSelectedOptionsForSchema(catalogItem.product_schema, selectedOptions, row);
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
      errors.push("storageLocationId or defaultStorageLocationId is required.");
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
    const listingPriceAmount = moneyAmount(listingPriceValue, "listingPriceAmount", errors);
    const listingQuantityCap = listingCapValue
      ? positiveWholeNumber(listingCapValue, "listingQuantityCap", errors)
      : null;
    const sourcePriceAmount = optionalMoneyAmount(clean(values.sourcePriceAmount), "sourcePriceAmount", errors);

    if (hasListingDraftFields) {
      if (!listingPriceValue) {
        errors.push("listingPriceAmount is required when listingQuantityCap is set.");
      }
      if (!listingCapValue) {
        errors.push("listingQuantityCap is required when listingPriceAmount is set.");
      }
      if (
        listingQuantityCap !== null &&
        imported.displayQuantity !== null &&
        listingQuantityCap > imported.displayQuantity
      ) {
        errors.push("listingQuantityCap cannot exceed totalQuantity.");
      }
    }

    return {
      status: errors.length > 0 ? "rejected" : "accepted",
      externalReference,
      rowFingerprint: row.rowFingerprint,
      quantityMode,
      quantityDelta: imported.quantityDelta,
      setQuantity: imported.setQuantity,
      sourcePriceAmount,
      resolutionStatus,
      catalogItemId,
      productId,
      selectedOptions,
      storageLocationId,
      totalQuantity: imported.displayQuantity,
      acquisitionCostAmount,
      sellerSku: clean(values.sellerSku),
      listingPriceAmount: hasListingDraftFields ? listingPriceAmount : null,
      listingQuantityCap: hasListingDraftFields ? listingQuantityCap : null,
      rowNote: clean(values.rowNote),
      validationErrors: errors,
    };
  }

  async function commitBatchRows(
    params: Readonly<{ batchId: string; accountId: AccountId }>,
    context: EventStoreContext,
    onProgress?: (progress: InventoryImportBatchJobProgress) => Promise<void>,
  ): Promise<InventoryImportBatchDetail> {
    const detail = await getImportBatch(deps.db, params.batchId, params.accountId);
    if (!detail) {
      throw new InventoryDomainError("Import batch not found.");
    }

    const rowsToCommit = detail.rows.filter((row) => row.status === "accepted" || row.status === "committed");
    let completed = rowsToCommit.filter((row) => row.status === "committed").length;
    await onProgress?.(importBatchJobProgress("processing", completed, rowsToCommit.length, null, "Committing rows."));

    for (const row of rowsToCommit) {
      throwIfImportBatchJobCancelled();

      if (row.status === "committed") {
        continue;
      }

      if (!row.catalog_item_id || !row.storage_location_id || !row.product_id) {
        completed += 1;
        await onProgress?.(
          importBatchJobProgress("processing", completed, rowsToCommit.length, row.row_id, "Skipped incomplete row."),
        );
        continue;
      }

      const existingItem = await findExistingImportTargetItem(deps.db, {
        accountId: params.accountId,
        catalogItemId: row.catalog_item_id,
        productId: row.product_id,
        selectedOptions: row.selected_options,
        storageLocationId: row.storage_location_id,
      });
      const quantityDelta =
        row.quantity_mode === "replace"
          ? (row.set_quantity ?? 0) - (existingItem?.total_quantity ?? 0)
          : (row.quantity_delta ?? 0);

      if (existingItem && existingItem.total_quantity + quantityDelta < existingItem.held_quantity) {
        throw new InventoryDomainError("Import cannot reduce total quantity below active held quantity.");
      }

      let inventoryItemId: string | null = existingItem?.item_id ?? null;
      if (!existingItem && quantityDelta > 0) {
        const itemResult = await deps.items.createItem(
          {
            accountId: params.accountId,
            catalogItemId: row.catalog_item_id,
            selectedOptions: row.selected_options,
            storageLocationId: row.storage_location_id,
            totalQuantity: quantityDelta,
            acquisitionCostAmount: row.acquisition_cost_amount,
            itemIdOverride: itemIdForRow(row.row_id),
          },
          context,
        );
        inventoryItemId = itemResult.itemId;
      } else if (existingItem && quantityDelta !== 0) {
        await deps.items.adjustItem(
          {
            accountId: params.accountId,
            itemId: existingItem.item_id,
            quantityDelta,
            reason: row.quantity_mode === "replace" ? "Import exact quantity" : "Import quantity adjustment",
          },
          context,
        );
        inventoryItemId = existingItem.item_id;
      } else if (!existingItem && quantityDelta < 0) {
        throw new InventoryDomainError("Import cannot reduce stock that does not exist in inventory.");
      }

      const listingQuantity =
        row.quantity_mode === "replace" ? (row.set_quantity ?? row.total_quantity ?? 0) : Math.max(quantityDelta, 0);

      let listingId: string | null = row.committed_listing_id;
      if (
        inventoryItemId &&
        row.listing_price_amount &&
        row.listing_quantity_cap &&
        listingQuantity > 0 &&
        deps.draftListingCreator
      ) {
        const location = await getStorageLocation(deps.db, row.storage_location_id, params.accountId);
        if (!location) {
          throw new InventoryDomainError("Storage location not found.");
        }

        const listing = await deps.draftListingCreator(
          {
            accountId: params.accountId,
            importBatchId: params.batchId,
            importRowId: row.row_id,
            inventoryItemId,
            listingIdOverride: listingIdForRow(row.row_id),
            catalogItemId: row.catalog_item_id,
            productId: row.product_id,
            selectedOptions: row.selected_options,
            storageLocationId: row.storage_location_id,
            storageLocationName: location.name,
            shipFromCode: location.ship_from_code,
            shipFromAddress: location.ship_from_address,
            totalQuantity: listingQuantity,
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
        [row.row_id, inventoryItemId, listingId],
      );

      completed += 1;
      await onProgress?.(
        importBatchJobProgress("processing", completed, rowsToCommit.length, row.row_id, "Committed row."),
      );
    }

    await refreshBatchCounts(deps.db, params.batchId);
    const committed = await getImportBatch(deps.db, params.batchId, params.accountId);
    if (!committed) {
      throw new InventoryDomainError("Import batch not found.");
    }
    return committed;
  }

  async function createBatchRows(
    params: Parameters<InventoryImportBatchServices["createBatch"]>[0],
    onProgress?: (progress: InventoryImportBatchJobProgress) => Promise<void>,
  ) {
    const quantityMode = params.quantityMode ?? "add";
    const adapter = getInventoryImportSourceAdapter(params.sourceKey);
    const rows = adapter.normalize({
      csvText: params.csvText,
      parsedRows: params.parsedRows,
      quantityMode,
      defaultStorageLocationId: params.defaultStorageLocationId,
    });
    if (rows.length === 0) {
      throw new InventoryDomainError("Import CSV must include at least one data row.");
    }

    const batchId = createId("imb");
    await deps.db.query(
      `INSERT INTO inventory_import_batches (
        batch_id,
        account_id,
        status,
        source_key,
        adapter_version,
        quantity_mode,
        default_storage_location_id,
        source_filename,
        created_at,
        updated_at
      ) VALUES ($1, $2, 'uploaded', $3, $4, $5, $6, $7, now(), now())`,
      [
        batchId,
        params.accountId,
        adapter.sourceKey,
        adapter.adapterVersion,
        quantityMode,
        params.defaultStorageLocationId ?? null,
        params.sourceFilename ?? null,
      ],
    );

    let completed = 0;
    for (const row of rows) {
      const rowId = createId("imr");
      const validated = await validateRow(params.accountId, row, quantityMode);
      await deps.db.query(
        `INSERT INTO inventory_import_batch_rows (
          row_id,
          batch_id,
          row_number,
          status,
          raw_row,
          external_reference,
          row_fingerprint,
          quantity_mode,
          quantity_delta,
          set_quantity,
          source_price_amount,
          resolution_status,
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
          $11, $12, $13, $14, $15, $16, $17, $18,
          $19, $20, $21, $22, $23, now(), now()
        )`,
        [
          rowId,
          batchId,
          row.rowNumber,
          validated.status,
          JSON.stringify(row.rawRow),
          validated.externalReference ? JSON.stringify(validated.externalReference) : null,
          validated.rowFingerprint,
          validated.quantityMode,
          validated.quantityDelta,
          validated.setQuantity,
          validated.sourcePriceAmount,
          validated.resolutionStatus,
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
      completed += 1;
      await onProgress?.(importBatchJobProgress("processing", completed, rows.length, rowId, "Validated row."));
    }

    await refreshBatchCounts(deps.db, batchId);
    const detail = await getImportBatch(deps.db, batchId, params.accountId);
    if (!detail) {
      throw new InventoryDomainError("Import batch could not be loaded.");
    }
    return detail;
  }

  return {
    createBatch: (params) => createBatchRows(params),
    getBatch: (batchId, accountId) => getImportBatch(deps.db, batchId, accountId),
    listBatches: (params) => listImportBatches(deps.db, params),
    commitBatch: (params, context) => commitBatchRows(params, context),
    enqueueCreateBatchJob: async (params, context) => {
      const inputId = await stageCreateBatchJobInput(params);
      return jobStore.enqueue({
        jobId: createId("job"),
        jobKind: IMPORT_BATCH_JOB_KIND_CREATE,
        payload: {
          accountId: params.accountId,
          create: {
            inputId,
          },
        },
        progress: importBatchJobProgress("queued", 0, 1, null, "Import validation queued."),
        eventContext: context,
      });
    },
    enqueueCommitBatchJob: async (params, context) => {
      const detail = await getImportBatch(deps.db, params.batchId, params.accountId);
      if (!detail) {
        throw new InventoryDomainError("Import batch not found.");
      }

      const remaining = Math.max(0, detail.accepted_count - detail.committed_count);
      return jobStore.enqueue({
        jobId: createId("job"),
        jobKind: IMPORT_BATCH_JOB_KIND_COMMIT,
        payload: {
          batchId: params.batchId,
          accountId: params.accountId,
        },
        progress: importBatchJobProgress("queued", 0, remaining, null, "Commit queued."),
        eventContext: context,
      });
    },
    getImportBatchJob: (jobId) => jobStore.get(jobId),
    listImportBatchJobEvents: (jobId, afterSequence = 0) => jobStore.listEvents(jobId, afterSequence),
    processNextImportBatchJob: async (input) => {
      const claimed = await jobStore.claimNext({
        claimOwnerId: input.claimOwnerId,
        claimTtlMs: input.claimTtlMs,
        jobKinds: [IMPORT_BATCH_JOB_KIND_CREATE, IMPORT_BATCH_JOB_KIND_COMMIT],
      });
      if (!claimed) {
        return 0;
      }

      let stagedInput: InventoryImportBatchJobInput | null = null;
      try {
        throwIfImportBatchJobCancelled(input);
        const context = claimed.eventContext;
        if (!context) {
          throw new InventoryDomainError("Import batch job is missing event context.");
        }

        stagedInput =
          claimed.jobKind === IMPORT_BATCH_JOB_KIND_CREATE
            ? await loadCreateBatchJobInput(
                requireCreateInputId(claimed.payload),
                claimed.payload.accountId as AccountId,
              )
            : null;
        const batch = stagedInput
          ? await createBatchRows(
              {
                accountId: stagedInput.accountId,
                csvText: stagedInput.csvText,
                parsedRows: stagedInput.parsedRows,
                sourceKey: stagedInput.sourceKey,
                quantityMode: stagedInput.quantityMode,
                defaultStorageLocationId: stagedInput.defaultStorageLocationId,
                sourceFilename: stagedInput.sourceFilename,
              },
              async (progress) => {
                input.throwIfLeaseLost?.();
                throwIfImportBatchJobCancelled(input);
                await requireImportBatchJobClaim(
                  jobStore.updateProgress({
                    jobId: claimed.jobId,
                    claimOwnerId: input.claimOwnerId,
                    claimTtlMs: input.claimTtlMs,
                    progress,
                  }),
                );
              },
            )
          : await commitBatchRows(
              {
                batchId: requireBatchId(claimed.payload),
                accountId: claimed.payload.accountId as AccountId,
              },
              context,
              async (progress) => {
                input.throwIfLeaseLost?.();
                throwIfImportBatchJobCancelled(input);
                await requireImportBatchJobClaim(
                  jobStore.updateProgress({
                    jobId: claimed.jobId,
                    claimOwnerId: input.claimOwnerId,
                    claimTtlMs: input.claimTtlMs,
                    progress,
                  }),
                );
              },
            );
        await requireImportBatchJobClaim(
          jobStore.complete({
            jobId: claimed.jobId,
            claimOwnerId: input.claimOwnerId,
            progress: importBatchJobProgress(
              "completed",
              claimed.jobKind === IMPORT_BATCH_JOB_KIND_CREATE ? batch.total_count : batch.committed_count,
              claimed.jobKind === IMPORT_BATCH_JOB_KIND_CREATE ? batch.total_count : batch.accepted_count,
              null,
              claimed.jobKind === IMPORT_BATCH_JOB_KIND_CREATE ? "Import validation completed." : "Commit completed.",
            ),
            result: { batch },
          }),
        );
        if (stagedInput) {
          await deleteCreateBatchJobInput(stagedInput.inputId).catch(() => undefined);
        }
        return 1;
      } catch (error) {
        if (isImportBatchJobHandoff(error, input)) {
          return 0;
        }
        await requireImportBatchJobClaim(
          jobStore.fail({
            jobId: claimed.jobId,
            claimOwnerId: input.claimOwnerId,
            progress: {
              ...claimed.progress,
              phase: "failed",
              message: error instanceof Error ? error.message : "Import batch job failed.",
            },
            errorMessage: error instanceof Error ? error.message : "Import batch job failed.",
          }),
        );
        if (stagedInput) {
          await deleteCreateBatchJobInput(stagedInput.inputId).catch(() => undefined);
        }
        return 1;
      }
    },
  };
}

function importBatchJobProgress(
  phase: InventoryImportBatchJobProgress["phase"],
  completed: number,
  total: number,
  currentRowId: string | null,
  message: string | null,
): InventoryImportBatchJobProgress {
  return {
    phase,
    completed,
    total,
    currentRowId,
    message,
  };
}

function requireBatchId(payload: InventoryImportBatchJobPayload) {
  if (!payload.batchId) {
    throw new InventoryDomainError("Import batch job is missing a batch ID.");
  }

  return payload.batchId;
}

function requireCreateInputId(payload: InventoryImportBatchJobPayload) {
  if (!payload.create?.inputId) {
    throw new InventoryDomainError("Import batch job is missing staged input.");
  }

  return payload.create.inputId;
}

async function requireImportBatchJobClaim(succeeded: Promise<boolean> | boolean) {
  if (!(await succeeded)) {
    throw new InventoryDomainError("Import batch job claim was lost before the status update completed.");
  }
}

function readJsonValue<T>(value: unknown): T {
  return typeof value === "string" ? (JSON.parse(value) as T) : (value as T);
}

function throwIfImportBatchJobCancelled(input?: { signal?: AbortSignal; throwIfLeaseLost?: () => void }) {
  input?.throwIfLeaseLost?.();
  if (input?.signal?.aborted) {
    throw new InventoryDomainError("Import batch job was cancelled.");
  }
}

function isImportBatchJobHandoff(error: unknown, input?: { signal?: AbortSignal }) {
  return (
    input?.signal?.aborted ||
    (error instanceof Error && (error.message.startsWith("Lost lease ") || error.message.includes("claim was lost")))
  );
}
