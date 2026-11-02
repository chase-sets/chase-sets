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
  type DurableJobWorkUnitSummary,
  type DurableJobWorkUnitTerminalOutcome,
} from "@chase-sets/platform-runtime/durable-job-work-units";
import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { AccountId, InventoryItemId, ListingId } from "@chase-sets/primitives/typed-ids";
import { inventoryDraftListingMessageSchema } from "@chase-sets/inventory-draft-listing";
import { normalizeGtin } from "@chase-sets/primitives/gtin";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { InventoryCatalogItemServices } from "../../inventory-items/integrations/catalog/runtime";
import {
  type InventoryProductDimension,
  type InventoryProductOption,
  type InventoryProductSchema,
  type InventorySelectedOptionEntry,
} from "../../inventory-items/integrations/catalog/versioning";
import type { InventoryItemServices } from "../../inventory-items/api/runtime";
import { listNativeInventoryExportItems } from "../../inventory-items/read-model/queries";
import { getStorageLocation, listStorageLocations } from "../../storage-locations/read-model/queries";
import { InventoryDomainError } from "../../../support/runtime-support/common";
import {
  withInventoryMutationAttempt,
  withInventoryMutationChildAttempt,
  inventoryMutationAttemptFromSource,
  hasInventoryMutationAttempt,
  INVENTORY_ATTEMPT_INTENT_CONFLICT,
} from "../../../support/runtime-support/mutation-attempt";
import { buildNativeInventoryExportCsv, buildNativeInventoryImportCsvTemplate, type ImportCsvRow } from "../domain/csv";
import { ImportRowResolveConflict, isImportRowFingerprint, isImportRowVersion } from "../domain/row-resolve-conflict";
import {
  INVENTORY_IMPORT_COMMIT_JOB_KIND,
  INVENTORY_IMPORT_CREATE_JOB_KINDS,
  INVENTORY_IMPORT_SNAPSHOT_JOB_KIND,
  isInventoryImportCreateJobKind,
} from "../domain/job-kinds";
import {
  getInventoryImportSourceAdapter,
  type InventoryImportExternalReference,
  type InventoryImportQuantityMode,
  type InventoryImportSourceKey,
  type NormalizedInventoryImportRow,
} from "../domain/import-source-adapters";
import {
  censusImportCommitParent,
  type InventoryImportCommitCensusRow,
  getImportBatch,
  listImportBatches,
  type InventoryImportBatchRow,
  type InventoryImportBatchDetail,
  type InventoryImportBatchResolution,
  type InventoryImportResolutionStatus,
  type InventoryImportRowStatus,
} from "../read-model/queries";
import { inventoryMutationFingerprint } from "../../../support/runtime-support/mutation-intent";
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
import { validateImportProduct } from "../domain/product-validation";
import {
  prepareInventoryImportSnapshot,
  stageInventoryImportSnapshot,
  loadInventoryImportSnapshotPage,
  type InventoryImportSnapshotHeader,
} from "./safe-snapshot";
import { isImportMigrationPool, migrateInventoryImportSource } from "./source-migration";
import {
  initializeProductResolutionProgress,
  normalizeProductResolutionPage,
  productResolutionReceipt,
  readProductResolutionProgress,
  readProductResolutionReceipt,
  ProductResolutionMaintenanceError,
  PRODUCT_RESOLUTION_JOB_ID,
  PRODUCT_RESOLUTION_UNIT_ID,
  type ProductResolutionProgress,
  type InventoryImportProductResolutionMaintenanceReceipt,
} from "./product-resolution-maintenance";
import {
  enqueueInventoryDraftListingMessage,
  processNextInventoryDraftListingDelivery,
  type InventoryDraftListingDelivery,
  type InventoryDraftListingDeliveryResult,
} from "./draft-listing-delivery";
export type { InventoryDraftListingDelivery } from "./draft-listing-delivery";
export type { InventoryDraftListingDeliveryResult } from "./draft-listing-delivery";
export type { InventoryImportProductResolutionMaintenanceReceipt } from "./product-resolution-maintenance";

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
    acquisitionCostCurrencyCode?: string | null;
    priceAmount: string;
    priceCurrencyCode: string;
    quantityCap: number;
  }>,
  context: EventStoreContext,
) => Promise<{ listingId: ListingId; version: number; feeQuoteFingerprint: string }>;

export type CreateInventoryImportBatch = Readonly<{
  accountId: AccountId;
  csvText?: string;
  parsedRows?: readonly ImportCsvRow[];
  sourceKey?: InventoryImportSourceKey;
  quantityMode?: InventoryImportQuantityMode;
  defaultStorageLocationId?: string | null;
  sourceFilename?: string | null;
}>;

export type InventoryImportBatchServices = Readonly<{
  getBatch: (
    batchId: string,
    accountId: string,
    page?: Readonly<{ limit: number; offset?: number }>,
  ) => ReturnType<typeof getImportBatch>;
  listBatches: (params: Parameters<typeof listImportBatches>[1]) => ReturnType<typeof listImportBatches>;
  getNativeCsvTemplate: (params: Readonly<{ accountId: AccountId }>) => Promise<string>;
  getNativeCsvExport: (params: Readonly<{ accountId: AccountId }>) => Promise<string>;
  resolveRow: (
    params: Readonly<{
      batchId: string;
      rowId: string;
      accountId: AccountId;
      /** The `row_version` the caller last read; never defaulted from the server row. */
      expectedRowVersion: string;
      /** The `row_fingerprint` the caller last read; never defaulted from the server row. */
      expectedRowFingerprint: string;
      catalogItemId: string;
      selectedOptions: readonly InventorySelectedOptionEntry[];
      storageLocationId: string;
    }>,
    context: EventStoreContext,
  ) => Promise<InventoryImportBatchResolution>;
  commitBatch: (
    params: Readonly<{ batchId: string; accountId: AccountId }>,
    context: EventStoreContext,
  ) => Promise<InventoryImportBatchDetail>;
  enqueueCommitBatchJob: (
    params: Readonly<{ batchId: string; accountId: AccountId }>,
    context: EventStoreContext,
  ) => Promise<InventoryImportBatchJob>;
  enqueueCreateBatchJob: (
    params: CreateInventoryImportBatch,
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
  processNextImportDraftListingDelivery: () => Promise<InventoryDraftListingDeliveryResult>;
  enqueueProductResolutionMaintenanceJob: (input?: {
    validatorVersion?: number;
    reactivateFailed?: boolean;
  }) => Promise<InventoryImportBatchJob>;
  processNextImportProductResolutionMaintenanceJob: (input: {
    claimOwnerId: string;
    claimTtlMs: number;
    signal?: AbortSignal;
    throwIfLeaseLost?: () => void;
    normalizationEnabled?: boolean;
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
  rowItems?: InventoryItemServices;
  catalogItems: InventoryCatalogItemServices;
  draftListingCreator?: InventoryDraftListingCreator;
  draftListingDelivery?: InventoryDraftListingDelivery;
  importProductRollout?: Readonly<{ normalizationEnabled: boolean; stockProgressionEnabled: boolean }>;
  executeMutation?: <T>(
    family: "import-commit-row" | "import-resolve-row",
    targetId: string,
    accountId: string,
    params: Readonly<Record<string, unknown> & { accountId: string }>,
    context: EventStoreContext,
    work: () => Promise<T>,
  ) => Promise<T>;
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
  acquisitionOccurredAt: string | null;
  acquisitionCostAmount: string | null;
  acquisitionCostCurrencyCode: string | null;
  sellerSku: string | null;
  listingPriceAmount: string | null;
  listingPriceCurrencyCode: string | null;
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
const IMPORT_BATCH_JOB_KIND_CREATE = INVENTORY_IMPORT_CREATE_JOB_KINDS[0];
const IMPORT_BATCH_JOB_KIND_SNAPSHOT = INVENTORY_IMPORT_SNAPSHOT_JOB_KIND;
const IMPORT_BATCH_JOB_KIND_COMMIT = INVENTORY_IMPORT_COMMIT_JOB_KIND;
export const INVENTORY_IMPORT_PRODUCT_RESOLUTION_MAINTENANCE_JOB_KIND = PRODUCT_RESOLUTION_JOB_ID;
export const INVENTORY_IMPORT_PRODUCT_RESOLUTION_MAINTENANCE_UNIT_KIND = PRODUCT_RESOLUTION_UNIT_ID;
const INVENTORY_IMPORT_PRODUCT_RESOLUTION_VALIDATOR_VERSION = 1;

function isCreateBatchJobKind(jobKind: string): boolean {
  return isInventoryImportCreateJobKind(jobKind);
}

export type InventoryImportBatchJobPayload = Readonly<{
  batchId?: string;
  accountId: string;
  idempotencyFingerprint?: string;
  create?: Readonly<{
    inputId: string;
    batchId?: string;
    snapshotVersion?: 1;
    snapshotHash?: string;
    rowCount?: number;
    normalizedRows?: readonly NormalizedInventoryImportRow[];
  }>;
  commit?: Readonly<{
    inputId: string;
    snapshotVersion: 1;
    snapshotHash: string;
    rowCount: number;
  }>;
  maintenance?: Readonly<{ validatorVersion: number }>;
}>;

export type InventoryImportBatchJobProgress = Readonly<{
  phase: "queued" | "processing" | "completed" | "failed";
  completed: number;
  total: number;
  currentRowId: string | null;
  message: string | null;
  maintenance?: ProductResolutionProgress;
}>;

export type InventoryImportBatchJobResult = Readonly<{
  batch?: InventoryImportBatchDetail;
  commandReceipt?: CommandReceiptMetadata | null;
  maintenanceReceipt?: InventoryImportProductResolutionMaintenanceReceipt;
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
  snapshot?: InventoryImportSnapshotHeader;
  normalizedRows?: readonly NormalizedInventoryImportRow[];
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

type InventoryImportCommitInputRow = Readonly<
  Pick<
    InventoryImportBatchRow,
    | "row_id"
    | "batch_id"
    | "row_number"
    | "status"
    | "raw_row"
    | "external_reference"
    | "row_fingerprint"
    | "quantity_mode"
    | "quantity_delta"
    | "set_quantity"
    | "source_price_amount"
    | "resolution_status"
    | "catalog_item_id"
    | "product_id"
    | "selected_options"
    | "storage_location_id"
    | "total_quantity"
    | "acquisition_occurred_at"
    | "acquisition_cost_amount"
    | "acquisition_cost_currency_code"
    | "seller_sku"
    | "listing_price_amount"
    | "listing_price_currency_code"
    | "listing_quantity_cap"
    | "row_note"
    | "validation_errors"
    | "committed_inventory_item_id"
    | "committed_listing_id"
    | "committed_at"
  >
>;

type InventoryImportCommitInput = Readonly<{
  inputId: string;
  tenantId: string;
  actorUserId: string;
  accountId: AccountId;
  batchId: string;
  snapshotVersion: 1;
  snapshotHash: string;
  rows: readonly InventoryImportCommitInputRow[];
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
  return prepareInventoryImportSnapshot(input).header.hash;
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

function optionalAcquisitionOccurredAt(value: string | null, errors: string[]): string | null {
  if (!value) return null;
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    errors.push("acquisitionOccurredAt must be a valid timezone-bearing RFC3339 instant.");
    return null;
  }
  return value;
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
  return candidate.targetIntent === "gtin-reference" && normalizeGtin(candidate.externalKey) ? 0 : 1;
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

/**
 * Item creation shared by the batch and per-row commit paths. An import has no certification
 * column, so it sends an explicit null and Inventory derives any graded card from the options.
 */
function importRowCreateItemParams(
  accountId: AccountId,
  row: Pick<
    InventoryImportCommitInputRow,
    | "row_id"
    | "selected_options"
    | "acquisition_occurred_at"
    | "acquisition_cost_amount"
    | "acquisition_cost_currency_code"
  >,
  target: Readonly<{ catalogItemId: string; storageLocationId: string; totalQuantity: number }>,
): Parameters<InventoryItemServices["createItem"]>[0] {
  return {
    accountId,
    catalogItemId: target.catalogItemId,
    selectedOptions: row.selected_options,
    certificationNumber: null,
    storageLocationId: target.storageLocationId,
    totalQuantity: target.totalQuantity,
    acquisitionCostAmount: row.acquisition_cost_amount,
    acquisitionCostCurrencyCode: row.acquisition_cost_currency_code,
    acquisitionOccurrence: row.acquisition_occurred_at
      ? { kind: "occurred", occurredAt: row.acquisition_occurred_at, source: "import-supplied" }
      : { kind: "unknown" },
    itemIdOverride: itemIdForRow(row.row_id),
  };
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
       SELECT SUM(quantity)::integer AS held_quantity
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

/** Batch states a row fix may land in; validating, committing, failed-safe, ambiguous and expired fail closed. */
const RESOLVABLE_BATCH_STATUSES: ReadonlySet<InventoryImportBatchDetail["status"]> = new Set([
  "uploaded",
  "ready-to-commit",
  "partial",
  "committed",
]);

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

export function createInventoryImportRowValidator(deps: Pick<InventoryImportBatchRuntimeDeps, "db" | "catalogItems">) {
  return async function validateRow(
    accountId: AccountId,
    row: NormalizedInventoryImportRow,
    quantityMode: InventoryImportQuantityMode,
    manualSelection?: readonly InventorySelectedOptionEntry[],
  ): Promise<ValidatedImportRow> {
    const errors: string[] = [];
    const values = row.values;
    const externalReferences = normalizeExternalReferences(row);
    let externalReference = externalReferences[0] ?? null;
    let catalogItemId = clean(values.catalogItemId ?? row.rawRow.catalogItemId);
    let storageLocationId = clean(values.storageLocationId);
    const imported = importedQuantity(clean(values.totalQuantity), quantityMode, errors);
    let selectedOptions: readonly InventorySelectedOptionEntry[] =
      manualSelection ?? optionEntries({ ...row.rawRow, ...values });
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
          const gtin = normalizeGtin(candidate.externalKey);
          if (!gtin) continue;
          externalReference = candidate;
          const gtinMapping = await deps.catalogItems.getCatalogItemByGtin(gtin);
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
    }

    const catalogItem = catalogItemId ? await deps.catalogItems.getCatalogItem(catalogItemId) : null;
    try {
      if (!manualSelection && catalogItem?.status === "active") {
        selectedOptions = normalizeSelectedOptionsForSchema(catalogItem.product_schema, selectedOptions, row);
      }
    } catch {
      errors.push("Selected options schema is invalid.");
    }
    const product = validateImportProduct({
      catalogItemId,
      catalogItem,
      selectedOptions,
      sourceProductId: manualSelection ? null : clean(values.productId ?? row.rawRow.productId),
      authority: manualSelection || resolutionStatus === "resolved" ? "resolved" : "native",
    });
    productId = product.productId;
    resolutionStatus = product.resolutionStatus;
    selectedOptions = product.selectedOptions;
    errors.push(...product.errors);

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

    const acquisitionCostValue = clean(values.acquisitionCostAmount);
    const acquisitionCostCurrencyValue = clean(values.acquisitionCostCurrencyCode);
    const acquisitionCostAmount = optionalMoneyAmount(acquisitionCostValue, "acquisitionCostAmount", errors);
    const acquisitionCostCurrencyCode =
      acquisitionCostCurrencyValue && /^[A-Z]{3}$/.test(acquisitionCostCurrencyValue)
        ? acquisitionCostCurrencyValue
        : null;
    if (Boolean(acquisitionCostValue) !== Boolean(acquisitionCostCurrencyValue)) {
      errors.push("acquisitionCostAmount and acquisitionCostCurrencyCode must be supplied together.");
    }
    if (acquisitionCostCurrencyValue && !acquisitionCostCurrencyCode) {
      errors.push("acquisitionCostCurrencyCode must be an uppercase three-letter ISO-4217 code.");
    }
    const acquisitionOccurredAt = optionalAcquisitionOccurredAt(clean(values.acquisitionOccurredAt), errors);
    const listingPriceValue = clean(values.listingPriceAmount);
    const listingCurrencyValue = clean(values.listingPriceCurrencyCode) ?? "";
    const listingCapValue = clean(values.listingQuantityCap);
    const hasListingDraftFields = Boolean(listingPriceValue || listingCurrencyValue || listingCapValue);
    const listingPriceAmount = moneyAmount(listingPriceValue, "listingPriceAmount", errors);
    const listingPriceCurrencyCode = /^[A-Za-z]{3}$/.test(listingCurrencyValue)
      ? listingCurrencyValue.toUpperCase()
      : null;
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
      if (!listingCurrencyValue) {
        errors.push("listingPriceCurrencyCode is required when listingPriceAmount is set.");
      } else if (!listingPriceCurrencyCode) {
        errors.push("listingPriceCurrencyCode must be a three-letter ISO-4217 code.");
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
      acquisitionOccurredAt,
      acquisitionCostAmount,
      acquisitionCostCurrencyCode,
      sellerSku: clean(values.sellerSku),
      listingPriceAmount: hasListingDraftFields ? listingPriceAmount : null,
      listingPriceCurrencyCode: hasListingDraftFields ? listingPriceCurrencyCode : null,
      listingQuantityCap: hasListingDraftFields ? listingQuantityCap : null,
      rowNote: clean(values.rowNote),
      validationErrors: errors,
    };
  };
}

export function indexInventoryImportCommitRows(
  rows: readonly InventoryImportCommitInputRow[],
): ReadonlyMap<string, InventoryImportCommitInputRow> {
  return new Map(rows.map((row) => [row.row_id, row]));
}

export function createInventoryImportBatchRuntime(deps: InventoryImportBatchRuntimeDeps): InventoryImportBatchServices {
  const readBatch = (batchId: string, accountId: string, page?: Readonly<{ limit: number; offset?: number }>) =>
    getImportBatch(deps.db, batchId, accountId, page, {
      stockProgressionEnabled: deps.importProductRollout?.stockProgressionEnabled,
    });
  const validateRow = createInventoryImportRowValidator(deps);
  const jobStore = createPostgresDurableJobStore<
    InventoryImportBatchJobPayload,
    InventoryImportBatchJobProgress,
    InventoryImportBatchJobResult
  >(
    deps.db,
    {
      jobsTable: "inventory_import_batch_jobs",
      eventsTable: "inventory_import_batch_job_events",
      retentionExemptJobKinds: [
        INVENTORY_IMPORT_PRODUCT_RESOLUTION_MAINTENANCE_JOB_KIND,
        IMPORT_BATCH_JOB_KIND_CREATE,
        IMPORT_BATCH_JOB_KIND_SNAPSHOT,
      ],
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

  async function loadCreateBatchJobInput(
    inputId: string,
    accountId: AccountId,
    rowNumber?: number,
    fallback?: InventoryImportBatchJobPayload["create"],
  ): Promise<InventoryImportBatchJobInput> {
    const result = await deps.db.query<{
      snapshot_version: number | null;
    }>(
      `SELECT snapshot_version
       FROM inventory_import_batch_job_inputs AS input
       WHERE input_id = $1
         AND account_id = $2`,
      [inputId, accountId],
    );
    const row = result.rows[0];
    if (!row || row.snapshot_version == null) {
      if (!isImportMigrationPool(deps.db))
        throw new InventoryDomainError("Import source migration requires a transaction.");
      await migrateInventoryImportSource(deps.db, inputId, accountId, fallback);
    }
    const page = await loadInventoryImportSnapshotPage(deps.db, inputId, accountId, 0, rowNumber);
    return {
      inputId,
      accountId,
      sourceKey: page.header.sourceKey,
      quantityMode: page.header.quantityMode,
      defaultStorageLocationId: page.header.defaultStorageLocationId,
      snapshot: page.header,
      normalizedRows: page.rows,
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

  /**
   * The single resolve authority. Every caller supplies the row facts it last read; the decision and the
   * one fenced UPDATE run inside the caller's mutation attempt when one is present, so a same-attempt
   * retry replays its receipt before any current-state check.
   */
  async function resolveBatchRow(
    params: Parameters<InventoryImportBatchServices["resolveRow"]>[0],
    context: EventStoreContext,
  ): Promise<InventoryImportBatchResolution> {
    if (params.expectedRowVersion === "" || params.expectedRowFingerprint === "") {
      throw new ImportRowResolveConflict("missing_row_facts");
    }
    if (!isImportRowVersion(params.expectedRowVersion) || !isImportRowFingerprint(params.expectedRowFingerprint)) {
      throw new ImportRowResolveConflict("invalid_row_facts");
    }
    const expectedRowVersion = params.expectedRowVersion;
    const expectedRowFingerprint = params.expectedRowFingerprint;

    const decide = async () => {
      const detail = await readBatch(params.batchId, params.accountId);
      const row = detail?.rows.find((candidate) => candidate.row_id === params.rowId);
      if (!detail || !row) {
        throw new ImportRowResolveConflict("row_not_found");
      }
      if (row.status === "committed") {
        throw new ImportRowResolveConflict("terminal_row");
      }
      if (!RESOLVABLE_BATCH_STATUSES.has(detail.status)) {
        throw new ImportRowResolveConflict("batch_not_resolvable");
      }
      if (row.row_fingerprint === "") {
        // Legacy rows kept the migration default; they fail closed rather than accept any fingerprint.
        throw new ImportRowResolveConflict("missing_row_facts");
      }

      const validated = await validateRow(
        params.accountId,
        rowForManualResolution(detail, row, params),
        row.quantity_mode,
        params.selectedOptions,
      );
      if (validated.validationErrors.length > 0 || !validated.catalogItemId || !validated.productId) {
        throw new InventoryDomainError(`Import row fix is incomplete: ${validated.validationErrors.join(" ")}`);
      }
      if (!validated.storageLocationId) {
        throw new InventoryDomainError("Import row fix is incomplete: Storage location was not found.");
      }
      const catalogItemId = validated.catalogItemId;

      const updated = await deps.db.query<{ row_id: string }>(
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
             acquisition_occurred_at = $14,
             acquisition_cost_amount = $15,
             seller_sku = $16,
             listing_price_amount = $17,
             listing_quantity_cap = $18,
             row_note = $19,
             validation_errors = $20::jsonb,
             updated_at = clock_timestamp()
         WHERE row_id = $1
           AND batch_id = $21
           AND status <> 'committed'
           AND updated_at = $22::timestamptz
           AND row_fingerprint = $23
           AND EXISTS (
             SELECT 1 FROM inventory_import_batches AS batch
             WHERE batch.batch_id = $21 AND batch.account_id = $24
           )
         RETURNING row_id`,
        [
          row.row_id,
          validated.status,
          validated.externalReference ? JSON.stringify(validated.externalReference) : null,
          validated.rowFingerprint,
          validated.quantityMode,
          validated.quantityDelta,
          validated.setQuantity,
          validated.sourcePriceAmount,
          catalogItemId,
          validated.productId,
          JSON.stringify(validated.selectedOptions),
          validated.storageLocationId,
          validated.totalQuantity,
          validated.acquisitionOccurredAt,
          validated.acquisitionCostAmount,
          validated.sellerSku,
          validated.listingPriceAmount,
          validated.listingQuantityCap,
          validated.rowNote,
          JSON.stringify(validated.validationErrors),
          params.batchId,
          expectedRowVersion,
          expectedRowFingerprint,
          params.accountId,
        ],
      );
      if (updated.rows.length !== 1 || updated.rows[0]?.row_id !== row.row_id) {
        throw new ImportRowResolveConflict("stale_row_facts");
      }

      if (detail.source_key === "native-csv") {
        await persistAccountSkuMapping(params.accountId, validated.sellerSku, catalogItemId, validated.selectedOptions);
      }
      await refreshBatchCounts(deps.db, params.batchId);
      return { batchId: params.batchId, rowId: row.row_id } as const;
    };

    if (deps.executeMutation && hasInventoryMutationAttempt(context)) {
      const intent = {
        accountId: params.accountId,
        batchId: params.batchId,
        rowId: params.rowId,
        expectedRowVersion,
        expectedRowFingerprint,
        catalogItemId: params.catalogItemId,
        selectedOptions: params.selectedOptions,
        storageLocationId: params.storageLocationId,
      };
      try {
        await deps.executeMutation("import-resolve-row", params.rowId, params.accountId, intent, context, decide);
      } catch (error) {
        if (error instanceof InventoryDomainError && error.message === INVENTORY_ATTEMPT_INTENT_CONFLICT) {
          throw new ImportRowResolveConflict("attempt_conflict");
        }
        throw error;
      }
    } else {
      await decide();
    }

    const nextDetail = await readBatch(params.batchId, params.accountId);
    if (!nextDetail) {
      throw new ImportRowResolveConflict("row_not_found");
    }
    return {
      ...nextDetail,
      next_needs_seller_row_id: nextDetail.rows.find((candidate) => candidate.needs_seller)?.row_id ?? null,
    };
  }

  async function commitSingleRow(
    params: Readonly<{ batchId: string; accountId: AccountId }>,
    row: InventoryImportCommitInputRow,
    context: EventStoreContext,
    claim?: Readonly<{ unitId: string; claimToken: string; claimTtlMs: number }>,
  ): Promise<Readonly<{ status: InventoryImportRowStatus; inventoryItemId: string | null; listingId: string | null }>> {
    let activeContext = context;
    const work = async () => {
      if (claim) {
        const claimed = await deps.db.query<{
          status: InventoryImportRowStatus;
          committed_inventory_item_id: string | null;
          committed_listing_id: string | null;
          commit_generation: number;
        }>(
          `UPDATE inventory_import_batch_rows
           SET commit_generation = commit_generation + 1,
               commit_claim_token = $3,
               commit_claimed_until = clock_timestamp() + ($4::text || ' milliseconds')::interval,
               updated_at = clock_timestamp()
           WHERE row_id = $1 AND batch_id = $2
             AND (status = 'accepted' OR status = 'committed')
             AND (status = 'committed' OR commit_claim_token IS NULL OR commit_claimed_until <= clock_timestamp()
                  OR commit_claim_token = $3)
           RETURNING status, committed_inventory_item_id, committed_listing_id, commit_generation`,
          [row.row_id, params.batchId, claim.claimToken, claim.claimTtlMs],
        );
        const claimedRow = claimed.rows[0];
        if (!claimedRow) throw new InventoryDomainError("Import row claim was lost or replaced.");
        if (claimedRow.status === "committed") {
          return {
            status: "committed" as const,
            inventoryItemId: claimedRow.committed_inventory_item_id,
            listingId: claimedRow.committed_listing_id,
          };
        }
      }

      if (!row.catalog_item_id || !row.storage_location_id || !row.product_id) {
        throw new InventoryDomainError("Import row is incomplete and cannot be committed.");
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

      const itemServices = deps.rowItems ?? deps.items;
      const recoveredRowPath = Boolean(deps.rowItems && deps.executeMutation);
      const itemContext = deps.executeMutation
        ? withInventoryMutationChildAttempt(activeContext, "item")
        : activeContext;
      let inventoryItemId: string | null = existingItem?.item_id ?? null;
      if (!existingItem && quantityDelta > 0) {
        const itemResult = await itemServices.createItem(
          importRowCreateItemParams(params.accountId, row, {
            catalogItemId: row.catalog_item_id,
            storageLocationId: row.storage_location_id,
            totalQuantity: quantityDelta,
          }),
          itemContext,
        );
        inventoryItemId = itemResult.itemId;
      } else if (existingItem && quantityDelta !== 0) {
        await itemServices.adjustItem(
          {
            accountId: params.accountId,
            itemId: existingItem.item_id,
            quantityDelta,
            reason: row.quantity_mode === "replace" ? "Import exact quantity" : "Import quantity adjustment",
            reasonCode: row.quantity_mode === "replace" || quantityDelta < 0 ? "correction" : "intake",
            ...(recoveredRowPath ? {} : { idempotencyKey: importRowInventoryAdjustmentKey(row.row_id) }),
            ...(quantityDelta > 0
              ? {
                  acquisitionOccurrence: row.acquisition_occurred_at
                    ? {
                        kind: "occurred" as const,
                        occurredAt: row.acquisition_occurred_at,
                        source: "import-supplied" as const,
                      }
                    : { kind: "unknown" as const },
                }
              : {}),
          },
          itemContext,
        );
        inventoryItemId = existingItem.item_id;
      } else if (!existingItem && quantityDelta < 0) {
        throw new InventoryDomainError("Import cannot reduce stock that does not exist in inventory.");
      }

      const listingQuantity =
        row.quantity_mode === "replace" ? (row.set_quantity ?? row.total_quantity ?? 0) : Math.max(quantityDelta, 0);
      const committedAt = row.committed_at ?? new Date().toISOString();
      let listingId: string | null = row.committed_listing_id;
      if (
        inventoryItemId &&
        row.listing_price_amount &&
        row.listing_price_currency_code &&
        row.listing_quantity_cap &&
        listingQuantity > 0
      ) {
        listingId = listingIdForRow(row.row_id);
        const location = await getStorageLocation(deps.db, row.storage_location_id, params.accountId);
        if (!location) throw new InventoryDomainError("Storage location not found.");
        await enqueueInventoryDraftListingMessage(
          deps.db,
          inventoryDraftListingMessageSchema.parse({
            schemaVersion: "inventory-draft-listing/v1",
            messageId: row.row_id,
            authority: {
              tenantId: activeContext.tenantId,
              accountId: params.accountId,
              performedByUserId: activeContext.audit.performedByUserId,
            },
            snapshot: {
              importBatchId: params.batchId,
              importRowId: row.row_id,
              committedAt,
              inventoryItemId,
              catalogItemId: row.catalog_item_id,
              productId: row.product_id,
              selectedOptions: [...row.selected_options],
              storageLocationId: row.storage_location_id,
              storageLocationName: location.name,
              shipFromCode: location.ship_from_code,
              shipFromAddress: JSON.parse(JSON.stringify(location.ship_from_address)),
              totalQuantity: listingQuantity,
              acquisitionCostAmount: row.acquisition_cost_amount,
              priceAmount: row.listing_price_amount,
              priceCurrencyCode: row.listing_price_currency_code,
              quantityCap: row.listing_quantity_cap,
            },
          }),
        );
      }

      const updated = await deps.db.query(
        `UPDATE inventory_import_batch_rows
         SET status = 'committed', committed_inventory_item_id = $2, committed_listing_id = $3,
             committed_at = COALESCE(committed_at, $4::timestamptz),
             commit_claim_token = NULL, commit_claimed_until = NULL, updated_at = clock_timestamp()
         WHERE row_id = $1 AND batch_id = $5
           AND ($6::text IS NULL OR (commit_claim_token = $6 AND commit_claimed_until > clock_timestamp()))`,
        [row.row_id, inventoryItemId, listingId, committedAt, params.batchId, claim?.claimToken ?? null],
      );
      if (Number(updated.rowCount ?? 0) !== 1)
        throw new InventoryDomainError("Import row claim was lost before commit.");
      const batch = await deps.db.query<{ committed_count: number; accepted_count: number; status: string }>(
        `UPDATE inventory_import_batches
         SET committed_count = committed_count + 1,
             status = CASE
               WHEN accepted_count > 0 AND committed_count + 1 = accepted_count THEN 'committed'
               ELSE 'uploaded'
             END,
             updated_at = clock_timestamp()
         WHERE batch_id = $1 AND account_id = $2
         RETURNING committed_count, accepted_count, status`,
        [params.batchId, params.accountId],
      );
      if (batch.rows.length !== 1) throw new InventoryDomainError("Import batch not found.");
      return { status: "committed" as const, inventoryItemId, listingId };
    };

    if (!claim || !deps.executeMutation) return work();
    activeContext = withInventoryMutationAttempt(
      context,
      inventoryMutationAttemptFromSource(`${params.batchId}:${row.row_id}:${claim.claimToken}`, "import-commit-row"),
    );
    return deps.executeMutation(
      "import-commit-row",
      row.row_id,
      params.accountId,
      { accountId: params.accountId, batchId: params.batchId, rowId: row.row_id, claimToken: claim.claimToken },
      activeContext,
      work,
    );
  }

  async function commitBatchRows(
    params: Readonly<{ batchId: string; accountId: AccountId }>,
    context: EventStoreContext,
    onProgress?: (progress: InventoryImportBatchJobProgress) => Promise<void>,
    options: Readonly<{ throwIfCancelled?: () => void }> = {},
    commitInputRows?: readonly InventoryImportCommitInputRow[],
  ): Promise<InventoryImportBatchDetail> {
    if (deps.importProductRollout?.stockProgressionEnabled === false) {
      throw new InventoryDomainError("Import stock progression is disabled; Product review remains available.");
    }
    const detail = await getImportBatch(deps.db, params.batchId, params.accountId);
    if (!detail) {
      throw new InventoryDomainError("Import batch not found.");
    }
    if (detail.status === "expired")
      throw new InventoryDomainError("Import batch expired; create a new import from the source.");
    if (["validating", "failed-safe", "ambiguous"].includes(detail.status)) {
      throw new InventoryDomainError("Import validation must finish before committing rows.");
    }

    const rowsToCommit = commitInputRows
      ? commitInputRows.map((row) => {
          const current = detail.rows.find((candidate) => candidate.row_id === row.row_id);
          return current?.status === "committed"
            ? {
                ...row,
                status: "committed" as const,
                committed_inventory_item_id: current.committed_inventory_item_id,
                committed_listing_id: current.committed_listing_id,
                committed_at: current.committed_at,
              }
            : row;
        })
      : detail.rows.filter((row) => row.status === "accepted" || row.status === "committed");
    let completed = rowsToCommit.filter((row) => row.status === "committed").length;
    await onProgress?.(importBatchJobProgress("processing", completed, rowsToCommit.length, null, "Committing rows."));
    if (detail.status === "committed" && rowsToCommit.every((row) => row.status === "committed")) {
      options.throwIfCancelled?.();
      return detail;
    }

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
          importRowCreateItemParams(params.accountId, row, {
            catalogItemId: row.catalog_item_id,
            storageLocationId: row.storage_location_id,
            totalQuantity: quantityDelta,
          }),
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
            ...(quantityDelta > 0
              ? {
                  acquisitionOccurrence: row.acquisition_occurred_at
                    ? {
                        kind: "occurred" as const,
                        occurredAt: row.acquisition_occurred_at,
                        source: "import-supplied" as const,
                      }
                    : { kind: "unknown" as const },
                }
              : {}),
          },
          context,
        );
        inventoryItemId = existingItem.item_id;
      } else if (!existingItem && quantityDelta < 0) {
        throw new InventoryDomainError("Import cannot reduce stock that does not exist in inventory.");
      }

      const listingQuantity =
        row.quantity_mode === "replace" ? (row.set_quantity ?? row.total_quantity ?? 0) : Math.max(quantityDelta, 0);
      const committedAt = row.committed_at ?? new Date().toISOString();

      let listingId: string | null = row.committed_listing_id;
      if (
        inventoryItemId &&
        row.listing_price_amount &&
        row.listing_price_currency_code &&
        row.listing_quantity_cap &&
        listingQuantity > 0
      ) {
        listingId = listingIdForRow(row.row_id);
        const location = await getStorageLocation(deps.db, row.storage_location_id, params.accountId);
        if (!location) {
          throw new InventoryDomainError("Storage location not found.");
        }

        const draftListingMessage = inventoryDraftListingMessageSchema.parse({
          schemaVersion: "inventory-draft-listing/v1",
          messageId: row.row_id,
          authority: {
            tenantId: context.tenantId,
            accountId: params.accountId,
            performedByUserId: context.audit.performedByUserId,
          },
          snapshot: {
            importBatchId: params.batchId,
            importRowId: row.row_id,
            committedAt,
            inventoryItemId,
            catalogItemId: row.catalog_item_id,
            productId: row.product_id,
            selectedOptions: [...row.selected_options],
            storageLocationId: row.storage_location_id,
            storageLocationName: location.name,
            shipFromCode: location.ship_from_code,
            shipFromAddress: JSON.parse(JSON.stringify(location.ship_from_address)),
            totalQuantity: listingQuantity,
            acquisitionCostAmount: row.acquisition_cost_amount,
            priceAmount: row.listing_price_amount,
            priceCurrencyCode: row.listing_price_currency_code,
            quantityCap: row.listing_quantity_cap,
          },
        });
        await enqueueInventoryDraftListingMessage(deps.db, draftListingMessage);
      }

      await deps.db.query(
        `UPDATE inventory_import_batch_rows
         SET status = 'committed',
             committed_inventory_item_id = $2,
             committed_listing_id = $3,
             committed_at = COALESCE(committed_at, $4::timestamptz),
             updated_at = now()
         WHERE row_id = $1`,
        [row.row_id, inventoryItemId, listingId, committedAt],
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

  function commitInputRow(row: InventoryImportBatchRow): InventoryImportCommitInputRow {
    return {
      row_id: row.row_id,
      batch_id: row.batch_id,
      row_number: row.row_number,
      status: row.status,
      raw_row: row.raw_row,
      external_reference: row.external_reference,
      row_fingerprint: row.row_fingerprint,
      quantity_mode: row.quantity_mode,
      quantity_delta: row.quantity_delta,
      set_quantity: row.set_quantity,
      source_price_amount: row.source_price_amount,
      resolution_status: row.resolution_status,
      catalog_item_id: row.catalog_item_id,
      product_id: row.product_id,
      selected_options: row.selected_options,
      storage_location_id: row.storage_location_id,
      total_quantity: row.total_quantity,
      acquisition_occurred_at: row.acquisition_occurred_at,
      acquisition_cost_amount: row.acquisition_cost_amount,
      acquisition_cost_currency_code: row.acquisition_cost_currency_code,
      seller_sku: row.seller_sku,
      listing_price_amount: row.listing_price_amount,
      listing_price_currency_code: row.listing_price_currency_code,
      listing_quantity_cap: row.listing_quantity_cap,
      row_note: row.row_note,
      validation_errors: row.validation_errors,
      committed_inventory_item_id: row.committed_inventory_item_id,
      committed_listing_id: row.committed_listing_id,
      committed_at: row.committed_at,
    };
  }

  function commitInputHash(
    accountId: AccountId,
    batchId: string,
    rows: readonly InventoryImportCommitInputRow[],
  ): string {
    return inventoryMutationFingerprint({ version: 1, accountId, batchId, rows });
  }

  async function persistCommitInput(
    params: Readonly<{ batchId: string; accountId: AccountId }>,
    context: EventStoreContext,
    rows: readonly InventoryImportCommitInputRow[],
  ): Promise<InventoryImportCommitInput> {
    const snapshotHash = commitInputHash(params.accountId, params.batchId, rows);
    const inputId = createId("commit_input");
    await deps.db.query(
      `INSERT INTO inventory_import_commit_inputs
       (input_id, tenant_id, actor_user_id, account_id, batch_id, snapshot_version, snapshot_hash, row_count, accepted_rows, created_at)
       VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8::jsonb, now())`,
      [
        inputId,
        context.tenantId,
        context.audit.performedByUserId,
        params.accountId,
        params.batchId,
        snapshotHash,
        rows.length,
        JSON.stringify(rows),
      ],
    );
    return {
      inputId,
      tenantId: context.tenantId,
      actorUserId: context.audit.performedByUserId,
      accountId: params.accountId,
      batchId: params.batchId,
      snapshotVersion: 1,
      snapshotHash,
      rows,
    };
  }

  async function loadCommitInput(
    inputId: string,
    params: Readonly<{ batchId: string; accountId: AccountId }>,
    context: EventStoreContext,
  ): Promise<InventoryImportCommitInput> {
    const result = await deps.db.query<{
      tenant_id: string;
      actor_user_id: string;
      account_id: AccountId;
      batch_id: string;
      snapshot_version: number;
      snapshot_hash: string;
      row_count: number;
      accepted_rows: unknown;
    }>(
      `SELECT tenant_id, actor_user_id, account_id, batch_id, snapshot_version, snapshot_hash, row_count, accepted_rows
       FROM inventory_import_commit_inputs
       WHERE input_id = $1 AND account_id = $2 AND batch_id = $3`,
      [inputId, params.accountId, params.batchId],
    );
    const row = result.rows[0];
    if (
      !row ||
      row.tenant_id !== context.tenantId ||
      row.actor_user_id !== context.audit.performedByUserId ||
      row.account_id !== params.accountId ||
      row.batch_id !== params.batchId ||
      row.snapshot_version !== 1 ||
      !/^[a-f0-9]{64}$/.test(row.snapshot_hash) ||
      !Number.isSafeInteger(row.row_count) ||
      !Array.isArray(row.accepted_rows)
    ) {
      throw new InventoryDomainError("Import commit input is unavailable; reconciliation is required.");
    }
    const rows = row.accepted_rows as readonly InventoryImportCommitInputRow[];
    if (
      rows.length !== row.row_count ||
      commitInputHash(params.accountId, params.batchId, rows) !== row.snapshot_hash
    ) {
      throw new InventoryDomainError("Import commit input is invalid; reconciliation is required.");
    }
    return {
      inputId,
      tenantId: row.tenant_id,
      actorUserId: row.actor_user_id,
      accountId: row.account_id,
      batchId: row.batch_id,
      snapshotVersion: 1,
      snapshotHash: row.snapshot_hash,
      rows,
    };
  }

  function normalizedCreateBatchRows(
    input: Pick<
      InventoryImportBatchJobInput,
      "csvText" | "parsedRows" | "sourceKey" | "quantityMode" | "defaultStorageLocationId" | "normalizedRows"
    >,
  ): readonly NormalizedInventoryImportRow[] {
    return input.normalizedRows ?? prepareInventoryImportSnapshot({ ...input, accountId: "normalization" }).rows;
  }

  async function ensureCreateBatchHeader(input: InventoryImportBatchJobInput, batchId: string, queryable = deps.db) {
    const quantityMode = input.quantityMode ?? "add";
    const adapter = getInventoryImportSourceAdapter(input.sourceKey);
    await queryable.query(
      `INSERT INTO inventory_import_batches (
        batch_id,
        account_id,
        status,
        source_key,
        adapter_version,
        quantity_mode,
        default_storage_location_id,
        created_at,
        updated_at
      ) VALUES ($1, $2, 'uploaded', $3, $4, $5, $6, now(), now())
      ON CONFLICT (batch_id) DO NOTHING`,
      [
        batchId,
        input.accountId,
        adapter.sourceKey,
        adapter.adapterVersion,
        quantityMode,
        input.defaultStorageLocationId ?? null,
      ],
    );
  }

  async function validateAndStoreCreateBatchRow(
    queryable: PgQueryable,
    batchId: string,
    row: NormalizedInventoryImportRow,
    validated: ValidatedImportRow,
  ): Promise<InventoryImportBatchWorkUnitResult> {
    const rowId = rowIdForBatchRow(batchId, row.rowNumber);
    await queryable.query(
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
        acquisition_occurred_at,
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
        $19, $20, $21, $22, $23, $24, now(), now()
      )
      ON CONFLICT (batch_id, row_number) DO NOTHING`,
      [
        rowId,
        batchId,
        row.rowNumber,
        validated.status,
        JSON.stringify({
          ...row.rawRow,
          ...(validated.acquisitionCostCurrencyCode
            ? { acquisitionCostCurrencyCode: validated.acquisitionCostCurrencyCode }
            : {}),
          ...(validated.listingPriceCurrencyCode
            ? { listingPriceCurrencyCode: validated.listingPriceCurrencyCode }
            : {}),
        }),
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
        validated.acquisitionOccurredAt,
        validated.acquisitionCostAmount,
        validated.sellerSku,
        validated.listingPriceAmount,
        validated.listingQuantityCap,
        validated.rowNote,
        JSON.stringify(validated.validationErrors),
      ],
    );
    await refreshBatchCounts(queryable, batchId);
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
    const counts = await queryable.query<{ total: number; terminal: number; failed: number; outcomes: number }>(
      `SELECT COUNT(*)::integer AS total,
        COUNT(*) FILTER (WHERE unit.state IN ('completed', 'failed', 'skipped'))::integer AS terminal,
        COUNT(*) FILTER (WHERE unit.state = 'failed')::integer AS failed,
        COUNT(row.row_id)::integer AS outcomes
       FROM inventory_import_batch_work_units AS unit
       LEFT JOIN inventory_import_batch_rows AS row ON row.batch_id = $2
         AND row.row_number = (unit.payload->>'rowNumber')::integer
         AND unit.result->>'rowId' = row.row_id AND unit.result->>'status' = row.status
       WHERE unit.job_id = $1 AND unit.unit_kind = ANY($3::text[])`,
      [job.jobId, batchId, INVENTORY_IMPORT_CREATE_JOB_KINDS],
    );
    const count = counts.rows[0];
    const total = job.progress.total;
    if (
      count &&
      count.terminal === count.total &&
      count.failed === 0 &&
      (count.total !== total || count.outcomes !== total)
    ) {
      throw new InventoryDomainError("Import validation outcomes require reconciliation.");
    }
    const completeJob = Boolean(
      count &&
      total > 0 &&
      count.total === total &&
      count.terminal === total &&
      count.outcomes === total &&
      count.failed === 0,
    );
    const batch = await getImportBatch(queryable, batchId, job.payload.accountId, { limit: 0 });
    return {
      parentProgress: importBatchJobProgress(
        completeJob ? "completed" : "processing",
        count?.terminal ?? 0,
        total,
        null,
        completeJob ? "Import validation completed." : "Validated row.",
      ),
      parentResult: batch ? { batch: completeJob ? { ...batch, status: "ready-to-commit" } : batch } : null,
      completeJob,
    };
  }

  function assertMatchingCreateJob(
    job: InventoryImportBatchJob,
    identity: InventoryImportBatchCreateIdentity,
    accountId: AccountId,
  ): void {
    if (
      !isCreateBatchJobKind(job.jobKind) ||
      job.payload.accountId !== accountId ||
      job.payload.batchId !== identity.batchId ||
      job.payload.create?.batchId !== identity.batchId ||
      job.payload.idempotencyFingerprint !== identity.inputFingerprint
    ) {
      throw new InventoryDomainError("Inventory import request ID was already used for different source content.");
    }
  }

  function enqueueCreateWorkUnits(
    jobId: string,
    rows: readonly NormalizedInventoryImportRow[],
    unitKind = IMPORT_BATCH_JOB_KIND_SNAPSHOT,
  ) {
    return workUnitStore.enqueue({
      jobId,
      units: rows.map((row) => ({
        unitId: String(row.rowNumber),
        unitKind,
        payload: { rowNumber: row.rowNumber },
      })),
    });
  }

  async function enqueueCreateBatchJob(
    params: CreateInventoryImportBatch,
    context: EventStoreContext,
    identity?: InventoryImportBatchCreateIdentity,
  ): Promise<InventoryImportBatchJob> {
    const snapshot = prepareInventoryImportSnapshot(params);
    const rows = snapshot.rows;
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

    const inputId = identity?.inputId ?? createId("job_input");
    await stageInventoryImportSnapshot(deps.db, inputId, snapshot);
    const batchId = identity?.batchId ?? createId("imb");
    const jobId = identity?.jobId ?? createId("job");
    await ensureCreateBatchHeader(
      {
        inputId,
        accountId: params.accountId,
        sourceKey: snapshot.header.sourceKey,
        quantityMode: snapshot.header.quantityMode,
        defaultStorageLocationId: snapshot.header.defaultStorageLocationId,
      },
      batchId,
    );
    let job: InventoryImportBatchJob;
    try {
      job = await jobStore.enqueue({
        jobId,
        jobKind: IMPORT_BATCH_JOB_KIND_SNAPSHOT,
        payload: {
          batchId,
          accountId: params.accountId,
          ...(identity ? { idempotencyFingerprint: identity.inputFingerprint } : {}),
          create: {
            inputId,
            batchId,
            snapshotVersion: 1,
            snapshotHash: snapshot.header.hash,
            rowCount: snapshot.header.rowCount,
          },
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

  async function enqueueProductResolutionMaintenanceJob(
    input: {
      validatorVersion?: number;
      reactivateFailed?: boolean;
    } = {},
  ): Promise<InventoryImportBatchJob> {
    const validatorVersion = input.validatorVersion ?? INVENTORY_IMPORT_PRODUCT_RESOLUTION_VALIDATOR_VERSION;
    if (!Number.isSafeInteger(validatorVersion) || validatorVersion < 1 || validatorVersion > 2_147_483_647) {
      throw new InventoryDomainError("Product resolution validator version must be a positive PostgreSQL integer.");
    }
    const jobId = PRODUCT_RESOLUTION_JOB_ID;
    const existing = await jobStore.get(jobId);
    if (existing) {
      if (existing.jobKind !== INVENTORY_IMPORT_PRODUCT_RESOLUTION_MAINTENANCE_JOB_KIND) {
        throw new InventoryDomainError("Product maintenance job identity is occupied by another workflow.");
      }
      const existingVersion = existing.payload.maintenance?.validatorVersion;
      if (
        !Number.isSafeInteger(existingVersion) ||
        !existingVersion ||
        existingVersion < 1 ||
        existingVersion > 2_147_483_647
      ) {
        throw new InventoryDomainError("Product maintenance has invalid retained validator identity.");
      }
      if (existing.result?.maintenanceReceipt) {
        if (existing.status !== "completed")
          throw new InventoryDomainError("Product maintenance receipt is not bound to a completed job.");
        if (readProductResolutionReceipt(existing.result.maintenanceReceipt).validatorVersion !== existingVersion) {
          throw new InventoryDomainError("Product maintenance receipt validator identity does not match its job.");
        }
        return existing;
      }
      if (existing.status === "completed")
        throw new InventoryDomainError("Completed Product maintenance is missing its receipt.");
      if (existing.status === "failed") {
        const state = readProductResolutionProgress(existing.progress.maintenance);
        if (state.validatorVersion !== existingVersion)
          throw new InventoryDomainError("Product maintenance retained progress does not match its validator.");
        if (!input.reactivateFailed || validatorVersion <= state.validatorVersion) {
          throw new InventoryDomainError(
            "Failed Product maintenance requires fenced higher-validatorVersion reactivation of the same job and unit.",
          );
        }
        const reactivated = await workUnitStore.requeueFailed({
          jobId,
          unitId: PRODUCT_RESOLUTION_UNIT_ID,
          expectedPayload: existing.payload,
          expectedProgress: existing.progress,
          payload: { ...existing.payload, maintenance: { validatorVersion } },
          progress: {
            ...existing.progress,
            phase: "queued",
            message: "Product maintenance reactivated.",
            maintenance: readProductResolutionProgress({ ...state, validatorVersion, poison: null }),
          },
        });
        if (!reactivated) throw new InventoryDomainError("Product maintenance reactivation fence changed.");
        return (await jobStore.get(jobId))!;
      }
      if (
        (input.validatorVersion !== undefined && validatorVersion !== existing.payload.maintenance?.validatorVersion) ||
        input.reactivateFailed
      ) {
        throw new InventoryDomainError("Active Product maintenance cannot be replaced by another validator version.");
      }
      await enqueueProductMaintenanceUnit(jobId);
      return existing;
    }
    const job = await jobStore.enqueue({
      jobId,
      jobKind: INVENTORY_IMPORT_PRODUCT_RESOLUTION_MAINTENANCE_JOB_KIND,
      payload: { accountId: "system", maintenance: { validatorVersion } },
      progress: importBatchJobProgress("queued", 0, 0, null, "Product resolution maintenance queued."),
      eventContext: null,
    });
    await enqueueProductMaintenanceUnit(jobId);
    return job;
  }

  async function enqueueProductMaintenanceUnit(jobId: string) {
    await workUnitStore.enqueue({
      jobId,
      units: [
        {
          unitId: INVENTORY_IMPORT_PRODUCT_RESOLUTION_MAINTENANCE_UNIT_KIND,
          unitKind: INVENTORY_IMPORT_PRODUCT_RESOLUTION_MAINTENANCE_UNIT_KIND,
          payload: { rowNumber: 0 },
        },
      ],
    });
  }

  async function processNextImportProductResolutionMaintenanceJob(input: {
    claimOwnerId: string;
    claimTtlMs: number;
    signal?: AbortSignal;
    throwIfLeaseLost?: () => void;
    normalizationEnabled?: boolean;
  }): Promise<number> {
    if (input.normalizationEnabled === false || deps.importProductRollout?.normalizationEnabled === false) return 0;
    const claimResult = await workUnitStore.claimNext({
      claimOwnerId: input.claimOwnerId,
      claimTtlMs: input.claimTtlMs,
      workflowMaxActiveClaims: 1,
      jobMaxActiveClaims: 1,
      jobKinds: [INVENTORY_IMPORT_PRODUCT_RESOLUTION_MAINTENANCE_JOB_KIND],
      jobId: PRODUCT_RESOLUTION_JOB_ID,
      unitId: PRODUCT_RESOLUTION_UNIT_ID,
      laneName: "maintenance",
    });
    const claim = claimResult.claim;
    if (!claim) return 0;
    const fence = {
      jobId: claim.job.jobId,
      unitId: claim.unit.unitId,
      claimOwnerId: claim.claimOwnerId,
      claimToken: claim.claimToken,
      claimTtlMs: input.claimTtlMs,
    };
    let progress = claim.job.progress;
    const checkLease = () => {
      input.throwIfLeaseLost?.();
      if (input.signal?.aborted) throw new InventoryDomainError("Product resolution maintenance was cancelled.");
    };
    try {
      checkLease();
      const validatorVersion =
        claim.job.payload.maintenance?.validatorVersion ?? INVENTORY_IMPORT_PRODUCT_RESOLUTION_VALIDATOR_VERSION;
      if (!progress.maintenance) {
        const initialized = await workUnitStore.checkpoint({
          ...fence,
          resolveProgress: async (db, current) => ({
            ...current,
            phase: "processing",
            maintenance: await initializeProductResolutionProgress(db, validatorVersion),
          }),
        });
        if (!initialized) throw new InventoryDomainError("Product maintenance claim was lost during initialization.");
        progress = initialized;
      }
      for (;;) {
        checkLease();
        let exhausted = false;
        const checkpoint = await workUnitStore.checkpoint({
          ...fence,
          resolveProgress: async (db, current) => {
            const state = readProductResolutionProgress(current.maintenance);
            if (state.validatorVersion !== validatorVersion)
              throw new InventoryDomainError("Product maintenance checkpoint validator does not match its job.");
            const transactionStore = createPostgresDurableJobWorkUnitStore<
              InventoryImportBatchJobPayload,
              InventoryImportBatchJobProgress,
              InventoryImportBatchJobResult,
              InventoryImportBatchWorkUnitPayload,
              InventoryImportBatchWorkUnitResult
            >(
              db,
              {
                jobsTable: "inventory_import_batch_jobs",
                eventsTable: "inventory_import_batch_job_events",
                workUnitsTable: "inventory_import_batch_work_units",
              },
              { workflowName: "inventory.import-batch" },
            );
            const result = await normalizeProductResolutionPage(db, state, async () => {
              checkLease();
              if (!(await transactionStore.renewClaim(fence)))
                throw new InventoryDomainError("Product maintenance claim expired.");
            });
            exhausted = result.exhausted;
            return {
              ...current,
              phase: "processing",
              completed: result.state.scannedCount,
              total: result.state.scannedCount,
              currentRowId: result.state.finalCursor?.rowId ?? null,
              maintenance: result.state,
            };
          },
        });
        if (!checkpoint) throw new InventoryDomainError("Product maintenance claim was lost during checkpoint.");
        progress = checkpoint;
        if (exhausted) break;
      }
      const outcome = await workUnitStore.recordTerminal({
        jobId: claim.job.jobId,
        unitId: claim.unit.unitId,
        claimOwnerId: claim.claimOwnerId,
        claimToken: claim.claimToken,
        state: "completed",
        unitResult: { rowId: PRODUCT_RESOLUTION_UNIT_ID, status: "rejected" },
        parentProgress: progress,
        completeJob: true,
        resolveParentUpdate: async (db) => {
          checkLease();
          const receipt = await productResolutionReceipt(db, readProductResolutionProgress(progress.maintenance));
          return {
            parentProgress: {
              ...progress,
              phase: "completed",
              currentRowId: null,
              message: "Product resolution maintenance completed.",
            },
            parentResult: { maintenanceReceipt: receipt },
            completeJob: true,
          };
        },
      });
      if (outcome !== "recorded") {
        throw new InventoryDomainError("Product resolution maintenance claim was lost before completion.");
      }
      return 1;
    } catch (error) {
      if (isImportBatchJobHandoff(error, input)) {
        await workUnitStore.releaseClaim(fence);
        return 0;
      }
      if (!progress.maintenance) {
        await workUnitStore.releaseClaim(fence);
        throw error;
      }
      const previous = readProductResolutionProgress(progress.maintenance);
      const rowId =
        error instanceof ProductResolutionMaintenanceError ? error.rowId : (previous.finalCursor?.rowId ?? "");
      const errorClass = error instanceof ProductResolutionMaintenanceError ? error.errorClass : "checkpoint";
      const attempts = Math.min(3, previous.poison?.rowId === rowId ? previous.poison.attempts + 1 : 1);
      const failed = await workUnitStore.checkpoint({
        ...fence,
        resolveProgress: async (_db, current) => ({
          ...current,
          message: `Product maintenance ${errorClass}; row=${rowId.slice(0, 200)}; attempt=${attempts}/3.`,
          maintenance: readProductResolutionProgress({
            ...previous,
            recoveryRowId: errorClass === "convergence" ? rowId : previous.recoveryRowId,
            poison: { rowId: rowId.slice(0, 200), cursor: previous.finalCursor, errorClass, attempts },
          }),
        }),
      });
      if (!failed) return 0;
      progress = failed;
      if (attempts < 3) {
        await workUnitStore.releaseClaim(fence);
        return 1;
      }
      await workUnitStore.recordTerminal({
        jobId: claim.job.jobId,
        unitId: claim.unit.unitId,
        claimOwnerId: claim.claimOwnerId,
        claimToken: claim.claimToken,
        state: "failed",
        unitResult: { rowId: claim.unit.unitId, status: "rejected" },
        errorMessage: progress.message,
        parentProgress: { ...progress, phase: "failed" },
        parentResult: claim.job.result,
        failJob: true,
      });
      return 1;
    }
  }

  return {
    getBatch: (batchId, accountId, page) => readBatch(batchId, accountId, page ?? { limit: 100 }),
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
    resolveRow: (params, context) => resolveBatchRow(params, context),
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
      const detail = await readBatch(params.batchId, params.accountId);
      if (!detail) {
        throw new InventoryDomainError("Import batch not found.");
      }

      if (detail.status === "expired") {
        throw new InventoryDomainError("Import batch expired; create a new import from the source.");
      }
      if (["validating", "failed-safe", "ambiguous"].includes(detail.status)) {
        throw new InventoryDomainError("Import validation must finish before committing rows.");
      }

      if (deps.importProductRollout?.stockProgressionEnabled === false) {
        throw new InventoryDomainError("Import stock progression is disabled; Product review remains available.");
      }
      if (detail.status === "committing") {
        throw new InventoryDomainError("Import commit is already running.");
      }
      if (!detail.can_commit) {
        throw new InventoryDomainError("Import batch has no accepted rows waiting to commit.");
      }

      const acceptedRows = detail.rows
        .filter((row) => row.status === "accepted" || row.status === "committed")
        .map(commitInputRow);
      const commitInput = await persistCommitInput(params, context, acceptedRows);

      const remaining = detail.commit_ready_count;
      const job = await jobStore.enqueue({
        jobId: createId("job"),
        jobKind: IMPORT_BATCH_JOB_KIND_COMMIT,
        payload: {
          batchId: params.batchId,
          accountId: params.accountId,
          commit: {
            inputId: commitInput.inputId,
            snapshotVersion: commitInput.snapshotVersion,
            snapshotHash: commitInput.snapshotHash,
            rowCount: commitInput.rows.length,
          },
        },
        progress: importBatchJobProgress("queued", 0, remaining, null, "Commit queued."),
        eventContext: context,
      });
      if (job.status === "queued" || job.status === "running") {
        await workUnitStore.enqueue({
          jobId: job.jobId,
          units: acceptedRows.map((row) => ({
            unitId: row.row_id,
            unitKind: "commit-row-v1",
            payload: { rowNumber: row.row_number },
          })),
        });
      }
      return job;
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
        `WITH expired AS MATERIALIZED (
           SELECT input.input_id, input.snapshot_version, input.snapshot_hash
           FROM inventory_import_batch_job_inputs AS input
           WHERE input.created_at < $1::timestamptz
             AND input.snapshot_version = 1
             AND NOT EXISTS (
               SELECT 1
               FROM inventory_import_batch_jobs AS job
               WHERE job.status IN ('queued', 'running')
                 AND (job.payload #>> '{create,inputId}' = input.input_id OR EXISTS (
                   SELECT 1 FROM inventory_import_batch_jobs AS creator
                   WHERE creator.payload #>> '{create,inputId}' = input.input_id
                     AND creator.payload->>'accountId' = job.payload->>'accountId'
                     AND creator.payload->>'batchId' = job.payload->>'batchId'
                 ))
             )
           ORDER BY input.created_at ASC, input.input_id ASC
           LIMIT $2
           FOR UPDATE OF input SKIP LOCKED
         ), expired_batches AS (
           UPDATE inventory_import_batches AS batch SET status = 'expired', updated_at = now()
           FROM inventory_import_batch_jobs AS job, expired
           WHERE job.payload #>> '{create,inputId}' = expired.input_id
             AND batch.batch_id = job.payload->>'batchId' AND batch.account_id = job.payload->>'accountId'
             AND batch.committed_count = 0 AND batch.status <> 'committed'
           RETURNING batch.batch_id
         ), audit AS (
           INSERT INTO inventory_import_source_cleanup (input_id, snapshot_version, snapshot_hash, reason, deleted_at)
           SELECT input_id, snapshot_version, snapshot_hash, 'precommit-resume-window-expired', now() FROM expired
           ON CONFLICT (input_id) DO NOTHING RETURNING input_id
         )
         DELETE FROM inventory_import_batch_job_inputs AS input
         USING expired, audit
         WHERE input.input_id = expired.input_id AND audit.input_id = input.input_id
           AND input.snapshot_version = expired.snapshot_version AND input.snapshot_hash = expired.snapshot_hash`,
        [formatRetentionDate(stagedInputCreatedBefore), Math.max(1, Math.min(input.limit ?? 500, 5_000))],
      );

      return { jobs, stagedInputs: Number(result.rowCount ?? 0) };
    },
    processNextImportBatchJob: async (input) => {
      if (input.signal?.aborted) return 0;
      const commitUnitResult = await processNextCommitBatchWorkUnit(input);
      if (commitUnitResult > 0) return commitUnitResult;
      const createUnitResult = await processNextCreateBatchWorkUnit(input);
      if (createUnitResult.processed > 0 || createUnitResult.handedOff) {
        return createUnitResult.processed;
      }

      if (shouldDeferImportBatchParentClaimForCreateUnitMiss(createUnitResult.missReason)) {
        return 0;
      }

      const claimed = await jobStore.claimNext({
        claimOwnerId: input.claimOwnerId,
        claimTtlMs: input.claimTtlMs,
        jobKinds: [IMPORT_BATCH_JOB_KIND_SNAPSHOT, IMPORT_BATCH_JOB_KIND_CREATE, IMPORT_BATCH_JOB_KIND_COMMIT],
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

        stagedInput = isCreateBatchJobKind(claimed.jobKind)
          ? await loadCreateBatchJobInput(
              requireCreateInputId(claimed.payload),
              claimed.payload.accountId as AccountId,
              undefined,
              claimed.payload.create,
            )
          : null;
        if (stagedInput) {
          let rows = stagedInput.normalizedRows ?? [];
          while (rows.length > 0) {
            await enqueueCreateWorkUnits(claimed.jobId, rows);
            if (!stagedInput.snapshot || rows.length < 100) break;
            const page = await loadInventoryImportSnapshotPage(
              deps.db,
              stagedInput.inputId,
              stagedInput.accountId,
              rows[rows.length - 1].rowNumber,
            );
            rows = page.rows;
          }
          await workUnitStore.reconcileTerminalParent({
            jobId: claimed.jobId,
            parentProgress: claimed.progress,
            resolveParentUpdate: (db) =>
              importBatchCreateParentUpdateFromWorkUnits(db, claimed, requireCreateBatchId(claimed.payload)),
          });
          await jobStore.releaseClaim({
            jobId: claimed.jobId,
            claimOwnerId: input.claimOwnerId,
            progress: claimed.progress,
          });
          return 1;
        }
        if (claimed.jobKind === IMPORT_BATCH_JOB_KIND_COMMIT) {
          const batchId = requireBatchId(claimed.payload);
          const accountId = claimed.payload.accountId as AccountId;
          const commitInput = await loadCommitInput(
            claimed.payload.commit?.inputId ?? "",
            { batchId, accountId },
            context,
          );
          await workUnitStore.enqueue({
            jobId: claimed.jobId,
            units: commitInput.rows.map((row) => ({
              unitId: row.row_id,
              unitKind: "commit-row-v1",
              payload: { rowNumber: row.row_number },
            })),
          });
          await jobStore.releaseClaim({
            jobId: claimed.jobId,
            claimOwnerId: input.claimOwnerId,
            progress: claimed.progress,
          });
          return processNextCommitBatchWorkUnit({
            ...input,
            jobId: claimed.jobId,
            commitInput,
          });
        }
        let commandReceipt: CommandReceiptMetadata | null = null;
        const batch = await runWithEventCommitMetadata(async () => {
          const result = await commitBatchRows(
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
            undefined,
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
              isCreateBatchJobKind(claimed.jobKind) ? batch.total_count : batch.committed_count,
              isCreateBatchJobKind(claimed.jobKind) ? batch.total_count : batch.accepted_count,
              null,
              isCreateBatchJobKind(claimed.jobKind) ? "Import validation completed." : "Commit completed.",
            ),
            result: {
              batch,
              ...(commandReceipt ? { commandReceipt } : {}),
            },
          }),
        );
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
              message: "import_job_failed_reconciliation_required",
            },
            errorMessage: "import_job_failed_reconciliation_required",
          }),
        );
        return 1;
      }
    },
    processNextImportDraftListingDelivery: () =>
      processNextInventoryDraftListingDelivery(deps.db, deps.draftListingDelivery),
    enqueueProductResolutionMaintenanceJob,
    processNextImportProductResolutionMaintenanceJob,
    getImportBatchWorkUnitSummary: (input = {}) => workUnitStore.summarize(input),
  };

  async function processNextCommitBatchWorkUnit(input: {
    claimOwnerId: string;
    claimTtlMs: number;
    signal?: AbortSignal;
    throwIfLeaseLost?: () => void;
    jobId?: string;
    commitInput?: InventoryImportCommitInput;
    commitRowsById?: ReadonlyMap<string, InventoryImportCommitInputRow>;
    censusAcceptedRows?: readonly InventoryImportCommitCensusRow[];
  }): Promise<number> {
    const claimResult = await workUnitStore.claimNext({
      claimOwnerId: input.claimOwnerId,
      claimTtlMs: input.claimTtlMs,
      workflowMaxActiveClaims: 1,
      jobMaxActiveClaims: 1,
      jobKinds: [IMPORT_BATCH_JOB_KIND_COMMIT],
      jobId: input.jobId,
      laneName: "commit-row",
    });
    const claim = claimResult.claim;
    if (!claim) return 0;
    const fence = {
      jobId: claim.job.jobId,
      unitId: claim.unit.unitId,
      claimOwnerId: claim.claimOwnerId,
      claimToken: claim.claimToken,
      claimTtlMs: input.claimTtlMs,
    };
    const context = claim.job.eventContext;
    if (!context) {
      await workUnitStore.recordTerminal({
        ...fence,
        state: "failed",
        errorMessage: "import_commit_missing_event_context",
        parentProgress: { ...claim.job.progress, phase: "failed", message: "Import commit context is unavailable." },
        failJob: true,
      });
      return 1;
    }
    try {
      if (input.signal?.aborted) throw new InventoryDomainError("Import commit was cancelled.");
      input.throwIfLeaseLost?.();
      const batchId = requireBatchId(claim.job.payload);
      const accountId = claim.job.payload.accountId as AccountId;
      const commitInput =
        input.commitInput ??
        (await loadCommitInput(claim.job.payload.commit?.inputId ?? "", { batchId, accountId }, context));
      const commitRowsById = input.commitRowsById ?? indexInventoryImportCommitRows(commitInput.rows);
      const censusAcceptedRows =
        input.censusAcceptedRows ??
        commitInput.rows.map(({ row_id, batch_id, row_number, status }) => ({ row_id, batch_id, row_number, status }));
      const row = commitRowsById.get(claim.unit.unitId);
      if (!row) throw new InventoryDomainError("Import commit row is unavailable; reconciliation is required.");
      await commitSingleRow({ batchId, accountId }, row, context, {
        unitId: claim.unit.unitId,
        claimToken: claim.claimToken,
        claimTtlMs: input.claimTtlMs,
      });
      const outcome = await workUnitStore.recordTerminal({
        ...fence,
        state: "completed",
        unitResult: { rowId: row.row_id, status: "committed" },
        parentProgress: {
          ...claim.job.progress,
          phase: "processing",
          currentRowId: row.row_id,
          message: "Committed import row.",
        },
        resolveParentUpdate: async (db) => {
          const pendingResult = await db.query<{ pending: number | string }>(
            `SELECT count(*)::integer AS pending
             FROM inventory_import_batch_work_units
             WHERE job_id = $1
               AND state NOT IN ('completed', 'failed', 'skipped')`,
            [claim.job.jobId],
          );
          const pending = Number(pendingResult.rows[0]?.pending ?? 0);
          if (pending > 0) {
            const completed = Math.max(0, censusAcceptedRows.length - pending);
            return {
              parentProgress: importBatchJobProgress(
                "processing",
                completed,
                censusAcceptedRows.length,
                row.row_id,
                "Committing rows.",
              ),
              parentResult: claim.job.result,
              completeJob: false,
            };
          }
          const census = await censusImportCommitParent(db, {
            jobId: claim.job.jobId,
            inputId: claim.job.payload.commit?.inputId ?? "",
            batchId,
            accountId,
            acceptedRows: censusAcceptedRows,
          });
          let parentResult = claim.job.result;
          if (census.complete) {
            const completedBatch = await getImportBatch(db, batchId, accountId, { limit: 10_000 });
            if (!completedBatch) throw new InventoryDomainError("Import batch not found.");
            parentResult = { batch: completedBatch };
          }
          return {
            parentProgress: importBatchJobProgress(
              census.complete ? "completed" : "processing",
              census.completed,
              census.total,
              census.complete ? null : row.row_id,
              census.complete ? "Commit completed." : "Committing rows.",
            ),
            parentResult,
            completeJob: census.complete,
          };
        },
      });
      if (!isDurableJobWorkUnitTerminalAccepted(outcome))
        throw new InventoryDomainError("Import row terminal fence was lost.");
      return (
        1 +
        (await processNextCommitBatchWorkUnit({
          ...input,
          jobId: claim.job.jobId,
          commitInput,
          commitRowsById,
          censusAcceptedRows,
        }))
      );
    } catch (error) {
      if (input.signal?.aborted) {
        await workUnitStore.releaseClaim(fence);
        return 0;
      }
      await workUnitStore.recordTerminal({
        ...fence,
        state: "failed",
        unitResult: { rowId: claim.unit.unitId, status: "rejected" },
        errorMessage: "import_job_failed_reconciliation_required",
        parentProgress: {
          ...claim.job.progress,
          phase: "failed",
          message: "Import row commit failed; reconciliation is required.",
        },
        failJob: true,
      });
      return 1;
    }
  }

  async function processNextCreateBatchWorkUnit(input: {
    claimOwnerId: string;
    claimTtlMs: number;
    workflowMaxActiveClaims?: number;
    jobMaxActiveClaims?: number;
    laneName?: string | null;
    signal?: AbortSignal;
    throwIfLeaseLost?: () => void;
  }): Promise<Readonly<{ processed: number; missReason?: DurableJobWorkUnitClaimOutcomeReason; handedOff?: boolean }>> {
    const claimResult = await workUnitStore.claimNext({
      claimOwnerId: input.claimOwnerId,
      claimTtlMs: input.claimTtlMs,
      workflowMaxActiveClaims: input.workflowMaxActiveClaims ?? 1,
      jobMaxActiveClaims: input.jobMaxActiveClaims ?? 1,
      jobKinds: [IMPORT_BATCH_JOB_KIND_SNAPSHOT, IMPORT_BATCH_JOB_KIND_CREATE],
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
        claim.unit.payload.rowNumber,
        claim.job.payload.create,
      );
      const batchId = requireCreateBatchId(claim.job.payload);
      const expected = claim.job.payload.create;
      if (
        expected?.snapshotVersion !== undefined &&
        (expected.snapshotVersion !== stagedInput.snapshot?.version ||
          expected.snapshotHash !== stagedInput.snapshot.hash ||
          expected.rowCount !== stagedInput.snapshot.rowCount ||
          expected.rowCount !== claim.job.progress.total)
      ) {
        throw new InventoryDomainError("Import source binding is invalid; reconciliation is required.");
      }
      const rows = normalizedCreateBatchRows(stagedInput);
      const row = rows.find((candidate) => candidate.rowNumber === claim.unit.payload.rowNumber);
      if (!row) {
        throw new InventoryDomainError("Import batch work unit row was not found.");
      }
      const retained = await deps.db.query<{ row_id: string; status: InventoryImportRowStatus }>(
        `SELECT row.row_id, row.status FROM inventory_import_batch_rows AS row
         JOIN inventory_import_batches AS batch ON batch.batch_id = row.batch_id
         WHERE row.batch_id = $1 AND batch.account_id = $2 AND row.row_number = $3`,
        [batchId, stagedInput.accountId, row.rowNumber],
      );
      const previous = retained.rows[0];
      const validated = previous
        ? null
        : await validateRow(stagedInput.accountId, row, stagedInput.quantityMode ?? "add");
      throwIfImportBatchJobCancelled(input);
      const batch = await finishCreateBatchWorkUnit({
        jobId: claim.job.jobId,
        batchId,
        accountId: stagedInput.accountId,
        inputId: stagedInput.inputId,
        rowResult: {
          rowId: previous?.row_id ?? rowIdForBatchRow(batchId, row.rowNumber),
          status: previous?.status ?? validated!.status,
        },
        claimOwnerId: claim.claimOwnerId,
        claimToken: claim.claimToken,
        unitId: claim.unit.unitId,
        parentProgress: claim.job.progress,
        parentResult: claim.job.result,
        persist: async (queryable) => {
          await ensureCreateBatchHeader(stagedInput, batchId, queryable);
          if (validated) await validateAndStoreCreateBatchRow(queryable, batchId, row, validated);
        },
      });
      void batch;
      return { processed: 1 };
    } catch (error) {
      if (error instanceof InventoryImportBatchClaimLostError) throw error;
      if (isImportBatchJobHandoff(error, input)) {
        await workUnitStore.releaseClaim({
          jobId: claim.job.jobId,
          unitId: claim.unit.unitId,
          claimOwnerId: claim.claimOwnerId,
          claimToken: claim.claimToken,
        });
        return { processed: 0, handedOff: true };
      }
      await requireImportBatchJobClaim(
        workUnitStore.recordTerminal({
          jobId: claim.job.jobId,
          unitId: claim.unit.unitId,
          claimOwnerId: claim.claimOwnerId,
          claimToken: claim.claimToken,
          state: "failed",
          unitResult: { rowId: String(claim.unit.payload.rowNumber), status: "rejected" },
          errorMessage: "import_validation_failed_reconciliation_required",
          failJob: true,
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
    persist: (queryable: PgQueryable) => Promise<void>;
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
      resolveParentUpdate: async (queryable) => {
        await input.persist(queryable);
        return importBatchCreateParentUpdateFromWorkUnits(
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
        );
      },
    });
    if (completed !== "recorded") {
      throw new InventoryImportBatchClaimLostError("Import create claim no longer owns the validation outcome.");
    }
    const summary = await workUnitStore.summarize({ jobId: input.jobId });
    return { complete: summary.total > 0 && summary.total === summary.completed + summary.failed + summary.skipped };
  }
}

class InventoryImportBatchClaimLostError extends InventoryDomainError {}

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

function retentionCutoff(daysAgo: number): Date {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
}

function formatRetentionDate(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
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
