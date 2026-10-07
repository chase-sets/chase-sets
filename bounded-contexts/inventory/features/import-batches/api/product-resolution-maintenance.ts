import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { InventoryImportResolutionStatus } from "../read-model/queries";
import type { InventorySelectedOptionEntry } from "../../inventory-items/integrations/catalog/versioning";
import { getInventoryCatalogItem } from "../../inventory-items/integrations/catalog/queries";
import { isImportProductError, replaceImportProductErrors, validateImportProduct } from "../domain/product-validation";

export const PRODUCT_RESOLUTION_JOB_ID = "inventory-import-product-resolution-maintenance";
export const PRODUCT_RESOLUTION_UNIT_ID = "normalize-legacy-rejected-products-v1";
export const PRODUCT_RESOLUTION_RECEIPT_ID = "inventory-import-product-resolution-maintenance/v1";
export const PRODUCT_RESOLUTION_PAGE_SIZE = 250;
type Cursor = Readonly<{ createdAt: string; rowId: string }>;
export type ProductResolutionProgress = Readonly<{
  validatorVersion: number;
  highWatermark: Cursor | null;
  finalCursor: Cursor | null;
  scannedCount: number;
  normalizedCount: number;
  normalizedProviderCount: number;
  alreadyConvergedCount: number;
  skippedConcurrentCount: number;
  startedAt: string;
  recoveryRowId: string | null;
  poison: Readonly<{ rowId: string; cursor: Cursor | null; errorClass: string; attempts: number }> | null;
}>;
export type InventoryImportProductResolutionMaintenanceReceipt = Omit<
  ProductResolutionProgress,
  "poison" | "recoveryRowId"
> &
  Readonly<{
    receiptId: typeof PRODUCT_RESOLUTION_RECEIPT_ID;
    jobId: typeof PRODUCT_RESOLUTION_JOB_ID;
    unitId: typeof PRODUCT_RESOLUTION_UNIT_ID;
    completedAt: string;
    complete: true;
  }>;

function closedObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function instant(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 19) === value.slice(0, 19);
}
function cursor(value: unknown): value is Cursor | null {
  return (
    value === null ||
    (closedObject(value, ["createdAt", "rowId"]) &&
      instant(value.createdAt) &&
      typeof value.rowId === "string" &&
      value.rowId.length > 0 &&
      value.rowId.length <= 200)
  );
}
function orderedInstant(value: string): string {
  return `${value.slice(0, 19)}.${(value.split(".")[1]?.slice(0, -1) ?? "").padEnd(9, "0")}`;
}
const countKeys = [
  "scannedCount",
  "normalizedCount",
  "normalizedProviderCount",
  "alreadyConvergedCount",
  "skippedConcurrentCount",
] as const;
const progressKeys = [
  "validatorVersion",
  "highWatermark",
  "finalCursor",
  ...countKeys,
  "startedAt",
  "poison",
  "recoveryRowId",
];
function validState(value: Record<string, unknown>): boolean {
  if (
    !Number.isSafeInteger(value.validatorVersion) ||
    Number(value.validatorVersion) < 1 ||
    Number(value.validatorVersion) > 2_147_483_647 ||
    !instant(value.startedAt) ||
    !cursor(value.highWatermark) ||
    !cursor(value.finalCursor) ||
    countKeys.some((key) => !Number.isSafeInteger(value[key]) || Number(value[key]) < 0)
  )
    return false;
  if (
    Number(value.normalizedProviderCount) > Number(value.normalizedCount) ||
    Number(value.normalizedCount) + Number(value.alreadyConvergedCount) > Number(value.scannedCount)
  )
    return false;
  if (value.finalCursor && !value.highWatermark) return false;
  if (!value.highWatermark && countKeys.some((key) => Number(value[key]) !== 0)) return false;
  if (Number(value.scannedCount) > 0 && !value.finalCursor) return false;
  if (value.finalCursor && value.highWatermark) {
    const left = value.finalCursor;
    const right = value.highWatermark;
    if (
      orderedInstant(left.createdAt) > orderedInstant(right.createdAt) ||
      (orderedInstant(left.createdAt) === orderedInstant(right.createdAt) && left.rowId > right.rowId)
    )
      return false;
  }
  return true;
}
export function readProductResolutionProgress(value: unknown): ProductResolutionProgress {
  if (
    !closedObject(value, progressKeys) ||
    !validState(value) ||
    !(
      value.recoveryRowId === null ||
      (typeof value.recoveryRowId === "string" && value.recoveryRowId.length > 0 && value.recoveryRowId.length <= 200)
    ) ||
    !(
      value.poison === null ||
      (closedObject(value.poison, ["rowId", "cursor", "errorClass", "attempts"]) &&
        typeof value.poison.rowId === "string" &&
        value.poison.rowId.length <= 200 &&
        cursor(value.poison.cursor) &&
        typeof value.poison.errorClass === "string" &&
        ["catalog-read", "row-state", "checkpoint", "convergence"].includes(value.poison.errorClass) &&
        Number.isInteger(value.poison.attempts) &&
        Number(value.poison.attempts) >= 1 &&
        Number(value.poison.attempts) <= 3)
    )
  ) {
    throw new Error("Invalid Product resolution maintenance progress.");
  }
  return value as ProductResolutionProgress;
}
export function readProductResolutionReceipt(value: unknown): InventoryImportProductResolutionMaintenanceReceipt {
  const keys = [
    ...progressKeys.filter((key) => key !== "poison" && key !== "recoveryRowId"),
    "receiptId",
    "jobId",
    "unitId",
    "completedAt",
    "complete",
  ];
  if (
    !closedObject(value, keys) ||
    !validState(value) ||
    value.receiptId !== PRODUCT_RESOLUTION_RECEIPT_ID ||
    value.jobId !== PRODUCT_RESOLUTION_JOB_ID ||
    value.unitId !== PRODUCT_RESOLUTION_UNIT_ID ||
    value.complete !== true ||
    !instant(value.completedAt) ||
    Date.parse(value.completedAt) < Date.parse(String(value.startedAt))
  ) {
    throw new Error("Invalid Product resolution maintenance receipt.");
  }
  return value as InventoryImportProductResolutionMaintenanceReceipt;
}

export class ProductResolutionMaintenanceError extends Error {
  constructor(
    readonly rowId: string,
    readonly errorClass: "catalog-read" | "row-state" | "convergence",
  ) {
    super(`Product resolution maintenance ${errorClass}; row=${rowId.slice(0, 200)}.`);
  }
}

type LegacyRow = Readonly<{
  row_id: string;
  catalog_item_id: string | null;
  product_id: string | null;
  selected_options: readonly InventorySelectedOptionEntry[];
  resolution_status: InventoryImportResolutionStatus;
  validation_errors: readonly string[];
  created_at: string;
  updated_at: string;
  source_key: string;
}>;
const timestampSql = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const rowColumns = `row.row_id, row.catalog_item_id, row.product_id, row.selected_options,
  row.resolution_status, row.validation_errors, ${timestampSql("row.created_at")} AS created_at,
  ${timestampSql("row.updated_at")} AS updated_at, batch.source_key`;

export async function initializeProductResolutionProgress(
  db: PgQueryable,
  validatorVersion: number,
): Promise<ProductResolutionProgress> {
  const result = await db.query<{ created_at: string; row_id: string }>(
    `SELECT ${timestampSql("created_at")} AS created_at, row_id FROM inventory_import_batch_rows
     WHERE status = 'rejected' AND committed_at IS NULL ORDER BY created_at DESC, row_id DESC LIMIT 1`,
  );
  return {
    validatorVersion,
    highWatermark: result.rows[0] ? { createdAt: result.rows[0].created_at, rowId: result.rows[0].row_id } : null,
    finalCursor: null,
    scannedCount: 0,
    normalizedCount: 0,
    normalizedProviderCount: 0,
    alreadyConvergedCount: 0,
    skippedConcurrentCount: 0,
    startedAt: new Date().toISOString(),
    poison: null,
    recoveryRowId: null,
  };
}

async function page(
  db: PgQueryable,
  state: ProductResolutionProgress,
  after: Cursor | null,
  lock = false,
): Promise<readonly LegacyRow[]> {
  if (!state.highWatermark) return [];
  const result = await db.query<LegacyRow>(
    `SELECT ${rowColumns} FROM inventory_import_batch_rows AS row
     JOIN inventory_import_batches AS batch ON batch.batch_id = row.batch_id
     WHERE row.status = 'rejected' AND row.committed_at IS NULL
       AND (row.created_at, row.row_id) <= ($1::timestamptz, $2::text)
       AND ($3::timestamptz IS NULL OR (row.created_at, row.row_id) > ($3::timestamptz, $4::text))
     ORDER BY row.created_at, row.row_id LIMIT $5 ${lock ? "FOR UPDATE OF row" : ""}`,
    [
      state.highWatermark.createdAt,
      state.highWatermark.rowId,
      after?.createdAt ?? null,
      after?.rowId ?? null,
      PRODUCT_RESOLUTION_PAGE_SIZE,
    ],
  );
  return result.rows;
}
async function productState(db: PgQueryable, row: LegacyRow) {
  if (
    !Array.isArray(row.validation_errors) ||
    row.validation_errors.some((error) => typeof error !== "string") ||
    !Array.isArray(row.selected_options) ||
    row.selected_options.some(
      (option) =>
        !closedObject(option, ["dimensionId", "optionId"]) ||
        typeof option.dimensionId !== "string" ||
        typeof option.optionId !== "string",
    )
  ) {
    throw new ProductResolutionMaintenanceError(row.row_id, "row-state");
  }
  let catalogItem;
  try {
    catalogItem = row.catalog_item_id ? await getInventoryCatalogItem(db, row.catalog_item_id) : null;
  } catch {
    throw new ProductResolutionMaintenanceError(row.row_id, "catalog-read");
  }
  const product = validateImportProduct({
    catalogItemId: row.catalog_item_id,
    catalogItem,
    selectedOptions: row.selected_options,
    sourceProductId: row.product_id,
    authority: row.resolution_status === "resolved" ? "resolved" : "native",
    requireExistingProduct: true,
  });
  const previousProductErrors = row.validation_errors.filter(isImportProductError);
  const errors = replaceImportProductErrors(
    row.validation_errors,
    product.errors[0] === "Selected options require seller confirmation of the Product." &&
      previousProductErrors.length > 0
      ? previousProductErrors
      : product.errors,
  );
  return {
    product,
    errors,
    changed:
      product.productId !== row.product_id ||
      product.resolutionStatus !== row.resolution_status ||
      JSON.stringify(errors) !== JSON.stringify(row.validation_errors),
  };
}

export async function normalizeProductResolutionPage(
  db: PgQueryable,
  state: ProductResolutionProgress,
  renew: () => Promise<void>,
): Promise<{
  state: ProductResolutionProgress;
  exhausted: boolean;
}> {
  const recovery = state.recoveryRowId !== null;
  const rows = recovery
    ? (
        await db.query<LegacyRow>(
          `SELECT ${rowColumns} FROM inventory_import_batch_rows AS row
     JOIN inventory_import_batches AS batch ON batch.batch_id = row.batch_id
     WHERE row.row_id = $1 AND row.status = 'rejected' AND row.committed_at IS NULL
       AND (row.created_at, row.row_id) <= ($2::timestamptz, $3::text)`,
          [state.recoveryRowId, state.highWatermark?.createdAt, state.highWatermark?.rowId],
        )
      ).rows
    : await page(db, state, state.finalCursor);
  let next = { ...state };
  for (const snapshot of rows) {
    await renew();
    let current = snapshot;
    let counted = false;
    for (let attempt = 0; attempt < 3 && !counted; attempt += 1) {
      const checked = await productState(db, current);
      if (!checked.changed) {
        next.alreadyConvergedCount += 1;
        counted = true;
        break;
      }
      const updated = await db.query(
        `UPDATE inventory_import_batch_rows SET product_id = $1, resolution_status = $2,
           validation_errors = $3::jsonb, updated_at = clock_timestamp()
         WHERE row_id = $4 AND status = 'rejected' AND committed_at IS NULL AND updated_at = $5::timestamptz`,
        [
          checked.product.productId,
          checked.product.resolutionStatus,
          JSON.stringify(checked.errors),
          current.row_id,
          current.updated_at,
        ],
      );
      if (Number(updated.rowCount ?? 0) === 1) {
        next.normalizedCount += 1;
        if (current.source_key !== "native-csv" && current.source_key !== "saved-list")
          next.normalizedProviderCount += 1;
        counted = true;
      } else {
        next.skippedConcurrentCount += 1;
        const reread = await db.query<LegacyRow>(
          `SELECT ${rowColumns} FROM inventory_import_batch_rows AS row
           JOIN inventory_import_batches AS batch ON batch.batch_id = row.batch_id
           WHERE row.row_id = $1 AND row.status = 'rejected' AND row.committed_at IS NULL`,
          [current.row_id],
        );
        if (!reread.rows[0]) {
          counted = true;
          break;
        }
        current = reread.rows[0];
      }
    }
    if (!counted) throw new ProductResolutionMaintenanceError(current.row_id, "row-state");
    next.scannedCount += 1;
    if (!recovery) next.finalCursor = { createdAt: snapshot.created_at, rowId: snapshot.row_id };
    next.poison = null;
  }
  if (recovery) {
    next.recoveryRowId = null;
    next.poison = null;
  }
  return {
    state: readProductResolutionProgress(next),
    exhausted: !recovery && rows.length < PRODUCT_RESOLUTION_PAGE_SIZE,
  };
}

export async function productResolutionReceipt(
  db: PgQueryable,
  state: ProductResolutionProgress,
): Promise<InventoryImportProductResolutionMaintenanceReceipt> {
  let after: Cursor | null = null;
  for (;;) {
    const rows = await page(db, state, after, true);
    for (const row of rows) {
      if ((await productState(db, row)).changed) throw new ProductResolutionMaintenanceError(row.row_id, "convergence");
      after = { createdAt: row.created_at, rowId: row.row_id };
    }
    if (rows.length < PRODUCT_RESOLUTION_PAGE_SIZE) break;
  }
  const { poison, recoveryRowId, ...receiptState } = state;
  if (poison || recoveryRowId) throw new Error("Poisoned Product maintenance cannot complete.");
  return readProductResolutionReceipt({
    ...receiptState,
    receiptId: PRODUCT_RESOLUTION_RECEIPT_ID,
    jobId: PRODUCT_RESOLUTION_JOB_ID,
    unitId: PRODUCT_RESOLUTION_UNIT_ID,
    completedAt: new Date().toISOString(),
    complete: true,
  });
}

export function productResolutionRollout(
  input: { normalizationEnabled: boolean; stockProgressionEnabled: boolean },
  state: ProductResolutionProgress | null,
  receipt: InventoryImportProductResolutionMaintenanceReceipt | null,
) {
  if (state) readProductResolutionProgress(state);
  if (receipt) readProductResolutionReceipt(receipt);
  return {
    widenedReviewEligibility: true,
    normalizationEnabled: input.normalizationEnabled,
    stockProgressionEnabled: input.stockProgressionEnabled,
  };
}
