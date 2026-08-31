import { getEventCommitMetadata, runWithEventCommitMetadata, type EventCommitMetadata } from "@chase-sets/event-core";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { CommandReceiptMetadata } from "@chase-sets/http/responses";
import {
  createDurableJobExecutionContext,
  createDurableJobProgressCheckpoint,
  createPostgresDurableJobStore,
  type DurableJobEvent,
  type DurableJobPublicSnapshot,
  type DurableJobRecord,
  toDurableJobPublicSnapshot,
} from "@chase-sets/platform-runtime/durable-job-store";
import {
  createPostgresDurableJobWorkUnitStore,
  isDurableJobWorkUnitTerminalAccepted,
  type DurableJobWorkUnitClaimOutcomeReason,
  type DurableJobWorkUnitRecord,
  type DurableJobWorkUnitSummary,
  type DurableJobWorkUnitTerminalOutcome,
} from "@chase-sets/platform-runtime/durable-job-work-units";
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
import { listNativeInventoryExportItems } from "../../inventory-items/read-model/queries";
import { getStorageLocation, listStorageLocations } from "../../storage-locations/read-model/queries";
import { InventoryDomainError } from "../../../support/runtime-support/common";
import { buildNativeInventoryExportCsv, buildNativeInventoryImportCsvTemplate, type ImportCsvRow } from "../domain/csv";
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
import {
  normalizeInventoryImportSellerSku,
  resolveAccountSellerSkusToInventoryItems,
  resolveInventoryImportAccountSkuMapping,
  type InventoryImportAccountSkuMapping,
} from "../read-model/account-sku-mappings";
import {
  prepareInventorySavedListImportBatch,
  type CreateInventorySavedListImportBatch,
  type InventorySavedListImportBatchHandoff,
} from "./saved-list-import";

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
  getNativeCsvTemplate: (params: Readonly<{ accountId: AccountId }>) => Promise<string>;
  getNativeCsvExport: (params: Readonly<{ accountId: AccountId }>) => Promise<string>;
  resolveRow: (
    params: Readonly<{
      batchId: string;
      rowId: string;
      accountId: AccountId;
      catalogItemId: string;
      selectedOptions: readonly InventorySelectedOptionEntry[];
      storageLocationId: string;
    }>,
    context: EventStoreContext,
  ) => Promise<InventoryImportBatchDetail>;
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
  createSavedListImportBatch: (
    params: CreateInventorySavedListImportBatch,
    context: EventStoreContext,
  ) => Promise<InventorySavedListImportBatchHandoff>;
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
  waitForImportBatchJobEvents: (jobId: string, signal?: AbortSignal) => Promise<void>;
  pruneImportBatchJobRetention: (input?: {
    completedBefore?: string | Date;
    stagedInputCreatedBefore?: string | Date;
    limit?: number;
  }) => Promise<{ jobs: number; stagedInputs: number }>;
  processNextImportBatchJob: (input: {
    claimOwnerId: string;
    claimTtlMs: number;
    workflowMaxActiveClaims?: number;
    jobMaxActiveClaims?: number;
    laneName?: string | null;
    signal?: AbortSignal;
    throwIfLeaseLost?: () => void;
  }) => Promise<number>;
  getImportBatchWorkUnitSummary: (input?: { jobId?: string | null }) => Promise<DurableJobWorkUnitSummary>;
  /**
   * Batch seller-SKU -> inventory-item resolution for cross-context callers
   * (m113 bulk reprice ingestion) that need to resolve a seller's own
   * SKUs to inventory items without re-implementing this feature's
   * native-SKU mapping/ambiguity rules. Read-only; reuses the same
   * account_sku_mappings table import batches use.
   */
  resolveAccountSkuMappingsToInventoryItems: (
    params: Readonly<{ accountId: AccountId; sellerSkus: readonly string[] }>,
  ) => ReturnType<typeof resolveAccountSellerSkusToInventoryItems>;
}>;

type InventoryImportBatchRuntimeDeps = Readonly<{
  db: PgQueryable;
  notificationWaiterPool?: PgTransactionalPool;
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
  idempotencyFingerprint?: string;
  create?: Readonly<{
    inputId: string;
    batchId?: string;
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
  commandReceipt?: CommandReceiptMetadata | null;
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

type InventoryImportBatchCreateIdentity = Readonly<{
  batchId: string;
  jobId: string;
  inputId: string;
  inputFingerprint: string;
}>;

type InventoryImportBatchWorkUnitPayload = Readonly<{
  rowNumber: number;
}>;

type InventoryImportBatchWorkUnitResult = Readonly<{
  rowId: string;
  status: InventoryImportRowStatus;
}>;

export function toInventoryImportBatchJobStatus(job: InventoryImportBatchJob): InventoryImportBatchJobStatus {
  return toDurableJobPublicSnapshot(job);
}

function clean(value: string | undefined) {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function serializeCreateBatchInputForIdempotency(
  input: Pick<
    InventoryImportBatchJobInput,
    | "accountId"
    | "csvText"
    | "parsedRows"
    | "sourceKey"
    | "quantityMode"
    | "defaultStorageLocationId"
    | "sourceFilename"
  >,
): string {
  return JSON.stringify(
    canonicalJsonValue({
      accountId: input.accountId,
      csvText: input.csvText ?? null,
      parsedRows: input.parsedRows ?? null,
      sourceKey: input.sourceKey ?? null,
      quantityMode: input.quantityMode ?? null,
      defaultStorageLocationId: input.defaultStorageLocationId ?? null,
      sourceFilename: input.sourceFilename ?? null,
    }),
  );
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJsonValue(entry)]),
    );
  }
  return value;
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

function gtinCandidatePriority(candidate: InventoryImportExternalReference): number {
  return candidate.targetIntent === "gtin-reference" ? 0 : 1;
}

function sellerSkuFromAccountSkuReference(
  reference: InventoryImportExternalReference,
  row: NormalizedInventoryImportRow,
): string | null {
  if (!reference.externalKey.startsWith("sku:")) {
    return null;
  }

  const normalizedReferenceSku = reference.externalKey.slice("sku:".length).trim();
  const rowSellerSku = clean(row.values.sellerSku);
  if (rowSellerSku && normalizeInventoryImportSellerSku(rowSellerSku) === normalizedReferenceSku) {
    return rowSellerSku;
  }

  return normalizedReferenceSku || null;
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

function dimensionMatchKeys(dimension: InventoryProductDimension): Set<string> {
  return new Set(
    [dimension.dimensionId, dimension.dimensionName]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map(normalizeChoiceText),
  );
}

function findSchemaDimension(schema: InventoryProductSchema, dimensionKey: string): InventoryProductDimension | null {
  const normalized = normalizeChoiceText(dimensionKey);
  if (!normalized) {
    return null;
  }

  return schema.dimensions.find((dimension) => dimensionMatchKeys(dimension).has(normalized)) ?? null;
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
  const dimensionKeys = dimensionMatchKeys(dimension);
  const profileCandidate = row.selectedOptionCandidates.find((candidate) =>
    dimensionKeys.has(normalizeChoiceText(candidate.dimensionKey)),
  );
  if (profileCandidate?.value.trim()) {
    return profileCandidate.value;
  }

  const keys = [
    `option:${dimension.dimensionId}`,
    `option:${dimension.dimensionName}`,
    dimension.dimensionId,
    dimension.dimensionName,
  ];

  return rowValueForKey(row.values, keys) ?? rowValueForKey(row.rawRow, keys);
}

function storageLocationLabelForRow(row: NormalizedInventoryImportRow): string | null {
  const keys = ["storageLocation", "Storage Location", "Storage Location Name", "Location", "Location Name"];

  return rowValueForKey(row.values, keys) ?? rowValueForKey(row.rawRow, keys);
}

async function resolveStorageLocationIdByLabel(
  db: PgQueryable,
  accountId: AccountId,
  label: string,
  errors: string[],
): Promise<string | null> {
  const locations = await listStorageLocations(db, { accountId, includeArchived: false });
  const normalizedLabel = normalizeChoiceText(label);
  const matches = locations.filter((location) => normalizeChoiceText(location.name) === normalizedLabel);
  const validLocationNames = locations.map((location) => location.name).join(", ");

  if (matches.length === 1) {
    return matches[0].storage_location_id;
  }

  if (matches.length > 1) {
    errors.push(`Storage location '${label}' is ambiguous. Use storageLocationId instead.`);
    return null;
  }

  errors.push(
    validLocationNames
      ? `Storage location '${label}' was not found. Valid active storage locations: ${validLocationNames}.`
      : `Storage location '${label}' was not found. There are no active storage locations.`,
  );
  return null;
}

function canonicalizeSelectedOptionEntry(
  schema: InventoryProductSchema,
  entry: InventorySelectedOptionEntry,
): InventorySelectedOptionEntry {
  const dimension = findSchemaDimension(schema, entry.dimensionId);
  if (!dimension) {
    return entry;
  }

  return {
    dimensionId: dimension.dimensionId,
    optionId: resolveOptionId(dimension.allowedOptions, entry.optionId) ?? entry.optionId,
  };
}

function normalizeSelectedOptionsForSchema(
  schema: InventoryProductSchema | null,
  selection: readonly InventorySelectedOptionEntry[],
  row: NormalizedInventoryImportRow,
): InventorySelectedOptionEntry[] {
  if (!schema) {
    return [...selection];
  }

  const selectedOptions = selection.map((entry) => canonicalizeSelectedOptionEntry(schema, entry));
  const selectedDimensionIds = new Set(selectedOptions.map((entry) => entry.dimensionId));
  const inferredOptions: InventorySelectedOptionEntry[] = [];

  for (const dimension of schema.dimensions) {
    if (selectedDimensionIds.has(dimension.dimensionId)) {
      continue;
    }

    const candidateValue = optionCandidateValue(dimension, row);
    const inferredOptionId = resolveOptionId(dimension.allowedOptions, candidateValue);
    if (inferredOptionId) {
      inferredOptions.push({ dimensionId: dimension.dimensionId, optionId: inferredOptionId });
    }
  }

  return [...selectedOptions, ...inferredOptions];
}

function itemIdForRow(rowId: string): InventoryItemId {
  return rowId.replace(/^imr_/, "inv_") as InventoryItemId;
}

function importRowInventoryAdjustmentKey(rowId: string): string {
  return `inventory-import-row:${rowId}:adjustment`;
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
     LEFT JOIN LATERAL (
       SELECT item_id, SUM(quantity)::integer AS held_quantity
       FROM inventory_holds
       WHERE inventory_holds.item_id = item.item_id
         AND status = 'active'
     ) AS active_holds
       ON true
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

function rowIdForBatchRow(batchId: string, rowNumber: number): string {
  return `imr_${batchId.replace(/^imb_/, "")}_${rowNumber}`;
}

function accountSkuMappingChoice(mapping: InventoryImportAccountSkuMapping): string {
  const selectedOptions =
    mapping.selected_options.length > 0
      ? mapping.selected_options.map((option) => `${option.dimensionId}:${option.optionId}`).join("|")
      : "no options";
  return `${mapping.catalog_item_id} (${selectedOptions})`;
}

function accountSkuMappingConflictMessage(
  sellerSku: string,
  mappings: readonly InventoryImportAccountSkuMapping[],
): string {
  const choices = mappings.map(accountSkuMappingChoice).join(", ");
  return `Seller SKU '${sellerSku}' has multiple mappings for this account: ${choices}.`;
}

async function refreshBatchCounts(db: PgQueryable, batchId: string) {
  await db.query(
    `UPDATE inventory_import_batches AS batch
     SET total_count = counts.total_count,
         accepted_count = counts.accepted_count,
         rejected_count = counts.rejected_count,
         committed_count = counts.committed_count,
         status = CASE
           WHEN counts.total_count > 0
            AND counts.accepted_count > 0
            AND counts.committed_count = counts.accepted_count THEN 'committed'
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
  >(
    deps.db,
    {
      jobsTable: "inventory_import_batch_jobs",
      eventsTable: "inventory_import_batch_job_events",
    },
    { notificationWaiterPool: deps.notificationWaiterPool },
  );
  const workUnitStore = createPostgresDurableJobWorkUnitStore<
    InventoryImportBatchJobPayload,
    InventoryImportBatchJobProgress,
    InventoryImportBatchJobResult,
    InventoryImportBatchWorkUnitPayload,
    InventoryImportBatchWorkUnitResult
  >(
    deps.db,
    {
      jobsTable: "inventory_import_batch_jobs",
      eventsTable: "inventory_import_batch_job_events",
      workUnitsTable: "inventory_import_batch_work_units",
    },
    {
      workflowName: "inventory.import-batch",
    },
  );

  async function stageCreateBatchJobInput(
    params: Parameters<InventoryImportBatchServices["createBatch"]>[0],
    requestedInputId?: string,
  ) {
    const inputId = requestedInputId ?? createId("job_input");
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
       ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, now())
       ON CONFLICT (input_id) DO NOTHING`,
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

    if (requestedInputId) {
      const staged = await loadCreateBatchJobInput(inputId, params.accountId);
      if (serializeCreateBatchInputForIdempotency(staged) !== serializeCreateBatchInputForIdempotency(params)) {
        throw new InventoryDomainError("Inventory import request ID was already used for different source content.");
      }
    }
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
    let storageLocationId = clean(values.storageLocationId);
    const imported = importedQuantity(clean(values.totalQuantity), quantityMode, errors);
    let selectedOptions: readonly InventorySelectedOptionEntry[] = optionEntries(values);
    let productId: string | null = null;
    let resolutionStatus: InventoryImportResolutionStatus = catalogItemId ? "native" : "unresolved";
    let resolutionError: string | null = null;

    if (!catalogItemId && externalReferences.length > 0) {
      // GTIN candidates resolve first: a scanned/imported barcode is a global,
      // check-digit-validated identifier, so it should win over an account's own
      // SKU mapping (and provider SKU/product-id mappings) before falling back to
      // those looser, account- or provider-scoped candidates.
      const orderedCandidates = [...externalReferences].sort(
        (left, right) => gtinCandidatePriority(left) - gtinCandidatePriority(right),
      );

      for (const candidate of orderedCandidates) {
        if (candidate.targetIntent === "gtin-reference") {
          externalReference = candidate;
          const gtinMapping = await deps.catalogItems.getCatalogItemByGtin(candidate.externalKey);
          if (gtinMapping) {
            catalogItemId = gtinMapping.catalog_item_id;
            resolutionStatus = "resolved";
            break;
          }
          continue;
        }

        if (candidate.targetIntent === "account-sku") {
          externalReference = candidate;
          const sellerSku = sellerSkuFromAccountSkuReference(candidate, row);
          if (!sellerSku) {
            continue;
          }

          const accountSkuResolution = await resolveInventoryImportAccountSkuMapping(deps.db, {
            accountId,
            sellerSku,
          });
          if (accountSkuResolution.status === "mapped") {
            catalogItemId = accountSkuResolution.mapping.catalog_item_id;
            selectedOptions = accountSkuResolution.mapping.selected_options;
            resolutionStatus = "resolved";
            break;
          }

          resolutionError =
            accountSkuResolution.status === "ambiguous"
              ? accountSkuMappingConflictMessage(sellerSku, accountSkuResolution.mappings)
              : `Seller SKU '${sellerSku}' is not mapped for this account.`;
          if (accountSkuResolution.status === "ambiguous") {
            break;
          }
          continue;
        }

        if (candidate.targetIntent !== "catalog-item-reference") {
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

        if (candidate.targetIntent !== "product-reference") {
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
          resolutionError ??
            (externalReferences.length === 1
              ? "External product reference is not mapped to a Chase Sets catalog item."
              : `External product references are not mapped to Chase Sets catalog items: ${candidateList}.`),
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
          const sourceProductId = clean(values.productId);
          if (sourceProductId && sourceProductId !== productId) {
            errors.push("The source Product no longer matches the current Catalog selection.");
          }
        } catch (error) {
          errors.push(error instanceof Error ? error.message : "Selected options are invalid.");
        }
      }
    }

    const storageLocationLabel = storageLocationLabelForRow(row);
    if (!storageLocationId && storageLocationLabel) {
      storageLocationId = await resolveStorageLocationIdByLabel(deps.db, accountId, storageLocationLabel, errors);
    }

    if (!storageLocationId && !storageLocationLabel) {
      errors.push("storageLocationId or defaultStorageLocationId is required.");
    } else if (storageLocationId) {
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

  async function persistAccountSkuMapping(
    accountId: AccountId,
    sellerSku: string | null,
    catalogItemId: string,
    selectedOptions: readonly InventorySelectedOptionEntry[],
  ) {
    if (!sellerSku) {
      return;
    }

    const normalizedSellerSku = normalizeInventoryImportSellerSku(sellerSku);
    if (!normalizedSellerSku) {
      return;
    }

    const existing = await resolveInventoryImportAccountSkuMapping(deps.db, { accountId, sellerSku });
    if (existing.status === "ambiguous") {
      throw new InventoryDomainError(accountSkuMappingConflictMessage(sellerSku, existing.mappings));
    }

    if (existing.status === "mapped") {
      await deps.db.query(
        `UPDATE inventory_import_account_sku_mappings
         SET seller_sku = $2,
             normalized_seller_sku = $3,
             catalog_item_id = $4,
             selected_options = $5::jsonb,
             updated_at = now()
         WHERE mapping_id = $1
           AND account_id = $6`,
        [
          existing.mapping.mapping_id,
          sellerSku,
          normalizedSellerSku,
          catalogItemId,
          JSON.stringify(selectedOptions),
          accountId,
        ],
      );
      return;
    }

    await deps.db.query(
      `INSERT INTO inventory_import_account_sku_mappings (
         mapping_id,
         account_id,
         seller_sku,
         normalized_seller_sku,
         catalog_item_id,
         selected_options,
         created_at,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, now(), now())`,
      [createId("sku_map"), accountId, sellerSku, normalizedSellerSku, catalogItemId, JSON.stringify(selectedOptions)],
    );
  }

  function rowForManualResolution(
    batch: InventoryImportBatchDetail,
    row: InventoryImportBatchDetail["rows"][number],
    params: Readonly<{
      catalogItemId: string;
      selectedOptions: readonly InventorySelectedOptionEntry[];
      storageLocationId: string;
    }>,
  ): NormalizedInventoryImportRow {
    const [normalizedRow] = getInventoryImportSourceAdapter(batch.source_key).normalize({
      parsedRows: [{ rowNumber: row.row_number, values: row.raw_row }],
      quantityMode: row.quantity_mode,
      defaultStorageLocationId: batch.default_storage_location_id,
    });
    if (!normalizedRow) {
      throw new InventoryDomainError("Import row could not be normalized for review.");
    }

    return {
      ...normalizedRow,
      values: {
        ...normalizedRow.values,
        catalogItemId: params.catalogItemId,
        storageLocationId: params.storageLocationId,
        ...Object.fromEntries(
          params.selectedOptions.map((option) => [`option:${option.dimensionId}`, option.optionId]),
        ),
      },
      rowFingerprint: `${normalizedRow.rowFingerprint}|review:${params.catalogItemId}:${params.storageLocationId}`,
    };
  }

  async function resolveBatchRow(
    params: Parameters<InventoryImportBatchServices["resolveRow"]>[0],
  ): Promise<InventoryImportBatchDetail> {
    const detail = await getImportBatch(deps.db, params.batchId, params.accountId);
    if (!detail) {
      throw new InventoryDomainError("Import batch not found.");
    }

    const row = detail.rows.find((candidate) => candidate.row_id === params.rowId);
    if (!row) {
      throw new InventoryDomainError("Import row not found.");
    }
    if (row.status === "committed") {
      throw new InventoryDomainError("Committed import rows cannot be changed.");
    }

    const validated = await validateRow(
      params.accountId,
      rowForManualResolution(detail, row, params),
      row.quantity_mode,
    );
    if (validated.validationErrors.length > 0 || !validated.catalogItemId || !validated.productId) {
      throw new InventoryDomainError(`Import row fix is incomplete: ${validated.validationErrors.join(" ")}`);
    }
    if (!validated.storageLocationId) {
      throw new InventoryDomainError("Import row fix is incomplete: Storage location was not found.");
    }

    if (detail.source_key === "native-csv") {
      await persistAccountSkuMapping(
        params.accountId,
        validated.sellerSku,
        validated.catalogItemId,
        validated.selectedOptions,
      );
    }

    await deps.db.query(
      `UPDATE inventory_import_batch_rows
       SET status = $2,
           external_reference = $3::jsonb,
           row_fingerprint = $4,
           quantity_mode = $5,
           quantity_delta = $6,
           set_quantity = $7,
           source_price_amount = $8,
           resolution_status = 'resolved',
           catalog_item_id = $9,
           product_id = $10,
           selected_options = $11::jsonb,
           storage_location_id = $12,
           total_quantity = $13,
           acquisition_cost_amount = $14,
           seller_sku = $15,
           listing_price_amount = $16,
           listing_quantity_cap = $17,
           row_note = $18,
           validation_errors = $19::jsonb,
           updated_at = now()
       WHERE row_id = $1
         AND batch_id = $20
         AND status <> 'committed'`,
      [
        row.row_id,
        validated.status,
        validated.externalReference ? JSON.stringify(validated.externalReference) : null,
        validated.rowFingerprint,
        validated.quantityMode,
        validated.quantityDelta,
        validated.setQuantity,
        validated.sourcePriceAmount,
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
        params.batchId,
      ],
    );
    await refreshBatchCounts(deps.db, params.batchId);

    const nextDetail = await getImportBatch(deps.db, params.batchId, params.accountId);
    if (!nextDetail) {
      throw new InventoryDomainError("Import batch not found.");
    }
    return nextDetail;
  }

  async function commitBatchRows(
    params: Readonly<{ batchId: string; accountId: AccountId }>,
    context: EventStoreContext,
    onProgress?: (progress: InventoryImportBatchJobProgress) => Promise<void>,
    options: Readonly<{ throwIfCancelled?: () => void }> = {},
  ): Promise<InventoryImportBatchDetail> {
    const detail = await getImportBatch(deps.db, params.batchId, params.accountId);
    if (!detail) {
      throw new InventoryDomainError("Import batch not found.");
    }

    const rowsToCommit = detail.rows.filter((row) => row.status === "accepted" || row.status === "committed");
    let completed = rowsToCommit.filter((row) => row.status === "committed").length;
    await onProgress?.(importBatchJobProgress("processing", completed, rowsToCommit.length, null, "Committing rows."));

    for (const row of rowsToCommit) {
      options.throwIfCancelled?.();

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
            reasonCode: row.quantity_mode === "replace" || quantityDelta < 0 ? "correction" : "intake",
            idempotencyKey: importRowInventoryAdjustmentKey(row.row_id),
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
    options: Readonly<{ batchId?: string; throwIfCancelled?: () => void }> = {},
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

    const batchId = options.batchId ?? createId("imb");
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
      ) VALUES ($1, $2, 'uploaded', $3, $4, $5, $6, $7, now(), now())
      ON CONFLICT (batch_id) DO UPDATE
      SET account_id = EXCLUDED.account_id,
          status = CASE
            WHEN inventory_import_batches.status = 'committed' THEN inventory_import_batches.status
            ELSE EXCLUDED.status
          END,
          source_key = EXCLUDED.source_key,
          adapter_version = EXCLUDED.adapter_version,
          quantity_mode = EXCLUDED.quantity_mode,
          default_storage_location_id = EXCLUDED.default_storage_location_id,
          source_filename = EXCLUDED.source_filename,
          updated_at = now()`,
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
      options.throwIfCancelled?.();
      const rowId = rowIdForBatchRow(batchId, row.rowNumber);
      const validated = await validateRow(params.accountId, row, quantityMode);
      options.throwIfCancelled?.();
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
        )
        ON CONFLICT (batch_id, row_number) DO UPDATE
        SET row_id = EXCLUDED.row_id,
            status = EXCLUDED.status,
            raw_row = EXCLUDED.raw_row,
            external_reference = EXCLUDED.external_reference,
            row_fingerprint = EXCLUDED.row_fingerprint,
            quantity_mode = EXCLUDED.quantity_mode,
            quantity_delta = EXCLUDED.quantity_delta,
            set_quantity = EXCLUDED.set_quantity,
            source_price_amount = EXCLUDED.source_price_amount,
            resolution_status = EXCLUDED.resolution_status,
            catalog_item_id = EXCLUDED.catalog_item_id,
            product_id = EXCLUDED.product_id,
            selected_options = EXCLUDED.selected_options,
            storage_location_id = EXCLUDED.storage_location_id,
            total_quantity = EXCLUDED.total_quantity,
            acquisition_cost_amount = EXCLUDED.acquisition_cost_amount,
            seller_sku = EXCLUDED.seller_sku,
            listing_price_amount = EXCLUDED.listing_price_amount,
            listing_quantity_cap = EXCLUDED.listing_quantity_cap,
            row_note = EXCLUDED.row_note,
            validation_errors = EXCLUDED.validation_errors,
            updated_at = now()
        WHERE inventory_import_batch_rows.status <> 'committed'`,
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

  function normalizedCreateBatchRows(
    input: Pick<
      InventoryImportBatchJobInput,
      "csvText" | "parsedRows" | "sourceKey" | "quantityMode" | "defaultStorageLocationId"
    >,
  ): readonly NormalizedInventoryImportRow[] {
    const quantityMode = input.quantityMode ?? "add";
    return getInventoryImportSourceAdapter(input.sourceKey).normalize({
      csvText: input.csvText,
      parsedRows: input.parsedRows,
      quantityMode,
      defaultStorageLocationId: input.defaultStorageLocationId,
    });
  }

  async function ensureCreateBatchHeader(input: InventoryImportBatchJobInput, batchId: string) {
    const quantityMode = input.quantityMode ?? "add";
    const adapter = getInventoryImportSourceAdapter(input.sourceKey);
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
      ) VALUES ($1, $2, 'uploaded', $3, $4, $5, $6, $7, now(), now())
      ON CONFLICT (batch_id) DO UPDATE
      SET account_id = EXCLUDED.account_id,
          status = CASE
            WHEN inventory_import_batches.status = 'committed' THEN inventory_import_batches.status
            ELSE EXCLUDED.status
          END,
          source_key = EXCLUDED.source_key,
          adapter_version = EXCLUDED.adapter_version,
          quantity_mode = EXCLUDED.quantity_mode,
          default_storage_location_id = EXCLUDED.default_storage_location_id,
          source_filename = EXCLUDED.source_filename,
          updated_at = now()`,
      [
        batchId,
        input.accountId,
        adapter.sourceKey,
        adapter.adapterVersion,
        quantityMode,
        input.defaultStorageLocationId ?? null,
        input.sourceFilename ?? null,
      ],
    );
  }

  async function validateAndStoreCreateBatchRow(
    accountId: AccountId,
    batchId: string,
    row: NormalizedInventoryImportRow,
    quantityMode: InventoryImportQuantityMode,
  ): Promise<InventoryImportBatchWorkUnitResult> {
    const rowId = rowIdForBatchRow(batchId, row.rowNumber);
    const validated = await validateRow(accountId, row, quantityMode);
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
      )
      ON CONFLICT (batch_id, row_number) DO UPDATE
      SET row_id = EXCLUDED.row_id,
          status = EXCLUDED.status,
          raw_row = EXCLUDED.raw_row,
          external_reference = EXCLUDED.external_reference,
          row_fingerprint = EXCLUDED.row_fingerprint,
          quantity_mode = EXCLUDED.quantity_mode,
          quantity_delta = EXCLUDED.quantity_delta,
          set_quantity = EXCLUDED.set_quantity,
          source_price_amount = EXCLUDED.source_price_amount,
          resolution_status = EXCLUDED.resolution_status,
          catalog_item_id = EXCLUDED.catalog_item_id,
          product_id = EXCLUDED.product_id,
          selected_options = EXCLUDED.selected_options,
          storage_location_id = EXCLUDED.storage_location_id,
          total_quantity = EXCLUDED.total_quantity,
          acquisition_cost_amount = EXCLUDED.acquisition_cost_amount,
          seller_sku = EXCLUDED.seller_sku,
          listing_price_amount = EXCLUDED.listing_price_amount,
          listing_quantity_cap = EXCLUDED.listing_quantity_cap,
          row_note = EXCLUDED.row_note,
          validation_errors = EXCLUDED.validation_errors,
          updated_at = now()
      WHERE inventory_import_batch_rows.status <> 'committed'`,
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
    await refreshBatchCounts(deps.db, batchId);
    return { rowId, status: validated.status };
  }

  async function importBatchCreateParentUpdateFromWorkUnits(
    queryable: PgQueryable,
    job: Readonly<{
      jobId: string;
      payload: InventoryImportBatchJobPayload;
      progress: InventoryImportBatchJobProgress;
    }>,
    batchId: string,
  ): Promise<
    Readonly<{
      parentProgress: InventoryImportBatchJobProgress;
      parentResult: InventoryImportBatchJobResult | null;
      completeJob: boolean;
    }>
  > {
    const units = await listImportBatchWorkUnitsForJob(queryable, job.jobId);
    const terminalUnits = units.filter(
      (unit) => unit.state === "completed" || unit.state === "failed" || unit.state === "skipped",
    );
    const total = Math.max(job.progress.total, units.length);
    const completeJob = total > 0 && terminalUnits.length >= total;
    const batch = await getImportBatch(queryable, batchId, job.payload.accountId);
    return {
      parentProgress: importBatchJobProgress(
        completeJob ? "completed" : "processing",
        terminalUnits.length,
        total,
        null,
        completeJob ? "Import validation completed." : "Validated row.",
      ),
      parentResult: batch ? { batch } : null,
      completeJob,
    };
  }

  async function listImportBatchWorkUnitsForJob(
    queryable: PgQueryable,
    jobId: string,
  ): Promise<
    readonly DurableJobWorkUnitRecord<InventoryImportBatchWorkUnitPayload, InventoryImportBatchWorkUnitResult>[]
  > {
    const result = await queryable.query<{
      unit_id: string;
      unit_kind: string;
      state: "queued" | "running" | "completed" | "failed" | "skipped";
      payload: unknown;
      result: unknown;
      error_message: string | null;
      claim_owner_id: string | null;
      claim_token: string | null;
      claimed_until: Date | string | null;
      attempt_count: number | string;
      created_at: Date | string;
      updated_at: Date | string;
      completed_at: Date | string | null;
    }>(
      `SELECT unit_id,
              unit_kind,
              state,
              payload,
              result,
              error_message,
              claim_owner_id,
              claim_token,
              claimed_until,
              attempt_count,
              created_at,
              updated_at,
              completed_at
       FROM inventory_import_batch_work_units
       WHERE job_id = $1
       ORDER BY created_at ASC, unit_id ASC`,
      [jobId],
    );
    return result.rows.map((row) => ({
      jobId,
      unitId: row.unit_id,
      unitKind: row.unit_kind,
      state: row.state,
      payload: readJsonValue(row.payload),
      result: row.result == null ? null : readJsonValue(row.result),
      errorMessage: row.error_message,
      claimOwnerId: row.claim_owner_id,
      claimToken: row.claim_token,
      claimedUntil: row.claimed_until == null ? null : formatTimestamp(row.claimed_until),
      attemptCount: Number(row.attempt_count),
      createdAt: formatTimestamp(row.created_at),
      updatedAt: formatTimestamp(row.updated_at),
      completedAt: row.completed_at == null ? null : formatTimestamp(row.completed_at),
    }));
  }

  function assertMatchingCreateJob(
    job: InventoryImportBatchJob,
    identity: InventoryImportBatchCreateIdentity,
    accountId: AccountId,
  ): void {
    if (
      job.jobKind !== IMPORT_BATCH_JOB_KIND_CREATE ||
      job.payload.accountId !== accountId ||
      job.payload.batchId !== identity.batchId ||
      job.payload.create?.batchId !== identity.batchId ||
      job.payload.idempotencyFingerprint !== identity.inputFingerprint
    ) {
      throw new InventoryDomainError("Inventory import request ID was already used for different source content.");
    }
  }

  function enqueueCreateWorkUnits(jobId: string, rows: readonly NormalizedInventoryImportRow[]) {
    return workUnitStore.enqueue({
      jobId,
      units: rows.map((row) => ({
        unitId: String(row.rowNumber),
        unitKind: IMPORT_BATCH_JOB_KIND_CREATE,
        payload: { rowNumber: row.rowNumber },
      })),
    });
  }

  async function enqueueCreateBatchJob(
    params: Parameters<InventoryImportBatchServices["createBatch"]>[0],
    context: EventStoreContext,
    identity?: InventoryImportBatchCreateIdentity,
  ): Promise<InventoryImportBatchJob> {
    const quantityMode = params.quantityMode ?? "add";
    const rows = normalizedCreateBatchRows({
      csvText: params.csvText,
      parsedRows: params.parsedRows,
      sourceKey: params.sourceKey,
      quantityMode,
      defaultStorageLocationId: params.defaultStorageLocationId,
    });
    if (rows.length === 0) {
      throw new InventoryDomainError("Import CSV must include at least one row.");
    }

    if (identity) {
      const existing = await jobStore.get(identity.jobId);
      if (existing) {
        assertMatchingCreateJob(existing, identity, params.accountId);
        if (existing.status === "queued" || existing.status === "running") {
          await enqueueCreateWorkUnits(existing.jobId, rows);
        }
        return existing;
      }
    }

    const inputId = await stageCreateBatchJobInput(params, identity?.inputId);
    const batchId = identity?.batchId ?? createId("imb");
    const jobId = identity?.jobId ?? createId("job");
    let job: InventoryImportBatchJob;
    try {
      job = await jobStore.enqueue({
        jobId,
        jobKind: IMPORT_BATCH_JOB_KIND_CREATE,
        payload: {
          batchId,
          accountId: params.accountId,
          ...(identity ? { idempotencyFingerprint: identity.inputFingerprint } : {}),
          create: { inputId, batchId },
        },
        progress: importBatchJobProgress("queued", 0, rows.length, null, "Import validation queued."),
        eventContext: context,
      });
    } catch (error) {
      if (!identity) {
        throw error;
      }
      const raced = await jobStore.get(identity.jobId);
      if (!raced) {
        throw error;
      }
      assertMatchingCreateJob(raced, identity, params.accountId);
      job = raced;
    }

    if (job.status === "queued" || job.status === "running") {
      await enqueueCreateWorkUnits(job.jobId, rows);
    }
    return job;
  }

  return {
    createBatch: (params) => createBatchRows(params),
    getBatch: (batchId, accountId) => getImportBatch(deps.db, batchId, accountId),
    listBatches: (params) => listImportBatches(deps.db, params),
    getNativeCsvTemplate: async (params) => {
      const locations = await listStorageLocations(deps.db, {
        accountId: params.accountId,
      });
      return buildNativeInventoryImportCsvTemplate(locations);
    },
    getNativeCsvExport: async (params) => {
      const rows = await listNativeInventoryExportItems(deps.db, {
        accountId: params.accountId,
      });
      return buildNativeInventoryExportCsv(rows);
    },
    resolveAccountSkuMappingsToInventoryItems: (params) => resolveAccountSellerSkusToInventoryItems(deps.db, params),
    resolveRow: (params) => resolveBatchRow(params),
    commitBatch: (params, context) => commitBatchRows(params, context),
    enqueueCreateBatchJob,
    createSavedListImportBatch: async (params, context) => {
      if (context.audit.forAccountId !== params.accountId) {
        throw new InventoryDomainError("Inventory Saved List import account does not match the authorized account.");
      }
      const prepared = prepareInventorySavedListImportBatch(params);
      const job = await enqueueCreateBatchJob(
        {
          accountId: params.accountId,
          parsedRows: prepared.parsedRows,
          sourceKey: "saved-list",
          quantityMode: "add",
          defaultStorageLocationId: null,
          sourceFilename: null,
        },
        context,
        prepared,
      );
      return {
        batchId: prepared.batchId,
        jobId: job.jobId,
        reviewHref: prepared.reviewHref,
      };
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
    waitForImportBatchJobEvents: (jobId, signal) => jobStore.waitForEvents({ jobId, signal }),
    pruneImportBatchJobRetention: async (input = {}) => {
      const completedBefore = input.completedBefore ?? retentionCutoff(7);
      const stagedInputCreatedBefore = input.stagedInputCreatedBefore ?? retentionCutoff(1);
      const jobs = await jobStore.pruneTerminalJobs({
        completedBefore,
        limit: input.limit,
      });
      const result = await deps.db.query(
        `WITH expired AS (
           SELECT input.input_id
           FROM inventory_import_batch_job_inputs AS input
           WHERE input.created_at < $1::timestamptz
             AND NOT EXISTS (
               SELECT 1
               FROM inventory_import_batch_jobs AS job
               WHERE job.status IN ('queued', 'running')
                 AND job.payload #>> '{create,inputId}' = input.input_id
             )
           ORDER BY input.created_at ASC, input.input_id ASC
           LIMIT $2
         )
         DELETE FROM inventory_import_batch_job_inputs AS input
         USING expired
         WHERE input.input_id = expired.input_id`,
        [formatRetentionDate(stagedInputCreatedBefore), Math.max(1, Math.min(input.limit ?? 500, 5_000))],
      );

      return { jobs, stagedInputs: Number(result.rowCount ?? 0) };
    },
    processNextImportBatchJob: async (input) => {
      const createUnitResult = await processNextCreateBatchWorkUnit(input);
      if (createUnitResult.processed > 0) {
        return createUnitResult.processed;
      }

      if (shouldDeferImportBatchParentClaimForCreateUnitMiss(createUnitResult.missReason)) {
        return 0;
      }

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

        const jobContext = createDurableJobExecutionContext(jobStore, {
          jobId: claimed.jobId,
          claimOwnerId: input.claimOwnerId,
          claimTtlMs: input.claimTtlMs,
          signal: input.signal,
          throwIfLeaseLost: input.throwIfLeaseLost,
          cancelledMessage: "Import batch job was cancelled.",
          claimLostMessage: "Import batch job claim was lost before the status update completed.",
        });
        const progressCheckpoint = createDurableJobProgressCheckpoint(jobContext, {
          completed: (progress) => progress.completed,
          isTerminal: (progress) => progress.phase === "completed" || progress.phase === "failed",
        });

        stagedInput =
          claimed.jobKind === IMPORT_BATCH_JOB_KIND_CREATE
            ? await loadCreateBatchJobInput(
                requireCreateInputId(claimed.payload),
                claimed.payload.accountId as AccountId,
              )
            : null;
        let commandReceipt: CommandReceiptMetadata | null = null;
        const batch = await runWithEventCommitMetadata(async () => {
          const result = stagedInput
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
                  await progressCheckpoint.checkpoint(progress);
                },
                {
                  batchId: requireCreateBatchId(claimed.payload),
                  throwIfCancelled: () => throwIfImportBatchJobCancelled(input),
                },
              )
            : await commitBatchRows(
                {
                  batchId: requireBatchId(claimed.payload),
                  accountId: claimed.payload.accountId as AccountId,
                },
                context,
                async (progress) => {
                  await progressCheckpoint.checkpoint(progress);
                },
                {
                  throwIfCancelled: () => throwIfImportBatchJobCancelled(input),
                },
              );
          commandReceipt = commandReceiptFromEventMetadata(getEventCommitMetadata());
          return result;
        });
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
            result: {
              batch,
              ...(commandReceipt ? { commandReceipt } : {}),
            },
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
    getImportBatchWorkUnitSummary: (input = {}) => workUnitStore.summarize(input),
  };

  async function processNextCreateBatchWorkUnit(input: {
    claimOwnerId: string;
    claimTtlMs: number;
    workflowMaxActiveClaims?: number;
    jobMaxActiveClaims?: number;
    laneName?: string | null;
    signal?: AbortSignal;
    throwIfLeaseLost?: () => void;
  }): Promise<Readonly<{ processed: number; missReason?: DurableJobWorkUnitClaimOutcomeReason }>> {
    const claimResult = await workUnitStore.claimNext({
      claimOwnerId: input.claimOwnerId,
      claimTtlMs: input.claimTtlMs,
      workflowMaxActiveClaims: input.workflowMaxActiveClaims ?? 1,
      jobMaxActiveClaims: input.jobMaxActiveClaims ?? 1,
      jobKinds: [IMPORT_BATCH_JOB_KIND_CREATE],
      laneName: input.laneName ?? null,
    });
    const claim = claimResult.claim;
    if (!claim) {
      return { processed: 0, missReason: claimResult.outcome.reason };
    }

    try {
      throwIfImportBatchJobCancelled(input);
      const stagedInput = await loadCreateBatchJobInput(
        requireCreateInputId(claim.job.payload),
        claim.job.payload.accountId as AccountId,
      );
      const batchId = requireCreateBatchId(claim.job.payload);
      const rows = normalizedCreateBatchRows(stagedInput);
      const row = rows.find((candidate) => candidate.rowNumber === claim.unit.payload.rowNumber);
      if (!row) {
        throw new InventoryDomainError("Import batch work unit row was not found.");
      }
      await ensureCreateBatchHeader(stagedInput, batchId);
      const storedRow = await validateAndStoreCreateBatchRow(
        stagedInput.accountId,
        batchId,
        row,
        stagedInput.quantityMode ?? "add",
      );
      const batch = await finishCreateBatchWorkUnit({
        jobId: claim.job.jobId,
        batchId,
        accountId: stagedInput.accountId,
        inputId: stagedInput.inputId,
        rowResult: {
          rowId: storedRow.rowId,
          status: storedRow.status,
        },
        claimOwnerId: claim.claimOwnerId,
        claimToken: claim.claimToken,
        unitId: claim.unit.unitId,
        parentProgress: claim.job.progress,
        parentResult: claim.job.result,
      });
      if (batch.complete) {
        await deleteCreateBatchJobInput(stagedInput.inputId).catch(() => undefined);
      }
      return { processed: 1 };
    } catch (error) {
      if (isImportBatchJobHandoff(error, input)) {
        await workUnitStore.releaseClaim({
          jobId: claim.job.jobId,
          unitId: claim.unit.unitId,
          claimOwnerId: claim.claimOwnerId,
          claimToken: claim.claimToken,
        });
        return { processed: 0 };
      }
      await requireImportBatchJobClaim(
        workUnitStore.recordTerminal({
          jobId: claim.job.jobId,
          unitId: claim.unit.unitId,
          claimOwnerId: claim.claimOwnerId,
          claimToken: claim.claimToken,
          state: "failed",
          unitResult: { rowId: String(claim.unit.payload.rowNumber), status: "rejected" },
          errorMessage: error instanceof Error ? error.message : "Import batch row validation failed.",
          parentProgress: claim.job.progress,
          parentResult: claim.job.result,
          resolveParentUpdate: (queryable) =>
            importBatchCreateParentUpdateFromWorkUnits(queryable, claim.job, requireCreateBatchId(claim.job.payload)),
        }),
      );
      return { processed: 1 };
    }
  }

  async function finishCreateBatchWorkUnit(input: {
    jobId: string;
    batchId: string;
    accountId: AccountId;
    inputId: string;
    rowResult: InventoryImportBatchWorkUnitResult;
    claimOwnerId: string;
    claimToken: string;
    unitId: string;
    parentProgress: InventoryImportBatchJobProgress;
    parentResult: InventoryImportBatchJobResult | null;
  }): Promise<{ complete: boolean }> {
    const completed = await workUnitStore.recordTerminal({
      jobId: input.jobId,
      unitId: input.unitId,
      claimOwnerId: input.claimOwnerId,
      claimToken: input.claimToken,
      state: input.rowResult.status === "rejected" ? "skipped" : "completed",
      unitResult: input.rowResult,
      parentProgress: input.parentProgress,
      parentResult: input.parentResult,
      resolveParentUpdate: (queryable) =>
        importBatchCreateParentUpdateFromWorkUnits(
          queryable,
          {
            jobId: input.jobId,
            progress: input.parentProgress,
            payload: {
              accountId: input.accountId,
              batchId: input.batchId,
              create: { inputId: input.inputId, batchId: input.batchId },
            },
          },
          input.batchId,
        ),
    });
    await requireImportBatchJobClaim(completed);
    const summary = await workUnitStore.summarize({ jobId: input.jobId });
    return { complete: summary.total > 0 && summary.total === summary.completed + summary.failed + summary.skipped };
  }
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

function commandReceiptFromEventMetadata(metadata: EventCommitMetadata): CommandReceiptMetadata | null {
  if (metadata.eventIds.length === 0) {
    return null;
  }

  return {
    mode: "eventual",
    ...(metadata.maxGlobalPosition ? { commitPosition: metadata.maxGlobalPosition } : {}),
    commitEventIds: metadata.eventIds,
    commitPositions: metadata.sources,
  };
}

export function shouldDeferImportBatchParentClaimForCreateUnitMiss(
  reason: DurableJobWorkUnitClaimOutcomeReason | undefined,
): boolean {
  return reason === "workflow_budget_exhausted" || reason === "job_budget_exhausted";
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

function requireCreateBatchId(payload: InventoryImportBatchJobPayload) {
  const batchId = payload.create?.batchId ?? payload.batchId;
  if (!batchId) {
    throw new InventoryDomainError("Import batch job is missing a create batch ID.");
  }

  return batchId;
}

async function requireImportBatchJobClaim(
  succeeded: Promise<boolean | DurableJobWorkUnitTerminalOutcome> | boolean | DurableJobWorkUnitTerminalOutcome,
) {
  const outcome = await succeeded;
  if (!isDurableJobWorkUnitTerminalAccepted(outcome)) {
    throw new InventoryDomainError("Import batch job claim was lost before the status update completed.");
  }
}

function readJsonValue<T>(value: unknown): T {
  return typeof value === "string" ? (JSON.parse(value) as T) : (value as T);
}

function retentionCutoff(daysAgo: number): Date {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
}

function formatRetentionDate(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function formatTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
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
