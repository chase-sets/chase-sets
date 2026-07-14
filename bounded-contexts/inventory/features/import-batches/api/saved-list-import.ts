import { createHash } from "node:crypto";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ProductKey } from "@chase-sets/primitives/catalog-identity";
import type { AccountId, CatalogItemId } from "@chase-sets/primitives/typed-ids";
import type { ImportCsvRow } from "../domain/csv";

export const inventorySavedListImportSourceKind = "saved-list" as const;

export type InventorySavedListImportLine = Readonly<{
  rowId: string;
  lineId: string;
  product: Readonly<{
    catalogItemId: CatalogItemId;
    productId: ProductKey;
    selectedOptions: readonly Readonly<{
      dimensionId: string;
      optionId: string;
    }>[];
  }>;
  trackedQuantity: number;
}>;

export type InventorySavedListImportSourceSnapshot = Readonly<{
  sourceKind: typeof inventorySavedListImportSourceKind;
  listId: string;
  listVersion: number;
  lines: readonly InventorySavedListImportLine[];
}>;

export type CreateInventorySavedListImportBatch = Readonly<{
  requestId: string;
  accountId: AccountId;
  source: InventorySavedListImportSourceSnapshot;
}>;

export type InventorySavedListImportBatchHandoff = Readonly<{
  batchId: string;
  jobId: string;
  reviewHref: string;
}>;

export type InventorySavedListImportBatchCreator = (
  command: CreateInventorySavedListImportBatch,
  context: EventStoreContext,
) => Promise<InventorySavedListImportBatchHandoff>;

export type PreparedInventorySavedListImportBatch = Readonly<{
  batchId: string;
  jobId: string;
  inputId: string;
  inputFingerprint: string;
  parsedRows: readonly ImportCsvRow[];
  reviewHref: string;
}>;

export function prepareInventorySavedListImportBatch(
  command: CreateInventorySavedListImportBatch,
): PreparedInventorySavedListImportBatch {
  const requestId = requiredText(command.requestId, "Saved List Inventory request ID");
  const accountId = requiredText(command.accountId, "Inventory account ID");
  const listId = requiredText(command.source.listId, "Saved List ID");

  if (command.source.sourceKind !== inventorySavedListImportSourceKind) {
    throw new Error("Inventory Saved List imports require source kind 'saved-list'.");
  }
  if (!Number.isSafeInteger(command.source.listVersion) || command.source.listVersion <= 0) {
    throw new Error("Inventory Saved List imports require a positive list version.");
  }
  if (command.source.lines.length === 0 || command.source.lines.length > 10_000) {
    throw new Error("Inventory Saved List imports require between 1 and 10000 lines.");
  }

  const seenRowIds = new Set<string>();
  const seenLineIds = new Set<string>();
  const parsedRows = command.source.lines.map((line, index): ImportCsvRow => {
    const rowId = requiredText(line.rowId, "Saved List source row ID");
    const lineId = requiredText(line.lineId, "Saved List line ID");
    if (seenRowIds.has(rowId)) {
      throw new Error(`Duplicate Saved List source row ID '${rowId}'.`);
    }
    if (seenLineIds.has(lineId)) {
      throw new Error(`Duplicate Saved List line ID '${lineId}'.`);
    }
    seenRowIds.add(rowId);
    seenLineIds.add(lineId);

    if (!Number.isSafeInteger(line.trackedQuantity) || line.trackedQuantity < 0) {
      throw new Error(`Saved List line '${lineId}' has an invalid Tracked Quantity.`);
    }

    const selectedOptions = [...line.product.selectedOptions].sort((left, right) =>
      left.dimensionId === right.dimensionId
        ? left.optionId.localeCompare(right.optionId)
        : left.dimensionId.localeCompare(right.dimensionId),
    );
    const values: Record<string, string> = {
      sourceListId: listId,
      sourceListVersion: String(command.source.listVersion),
      sourceLineId: lineId,
      sourceRowId: rowId,
      catalogItemId: requiredText(line.product.catalogItemId, "Catalog Item ID"),
      productId: requiredText(line.product.productId, "Product ID"),
      totalQuantity: String(line.trackedQuantity),
    };
    for (const option of selectedOptions) {
      const dimensionId = requiredText(option.dimensionId, "Product dimension ID");
      values[`option:${dimensionId}`] = requiredText(option.optionId, "Product option ID");
    }

    return { rowNumber: index + 1, values };
  });

  const identitySeed = `${accountId}:${requestId}`;
  const batchId = deterministicId("imb", identitySeed);
  const jobId = deterministicId("job", `saved-list-import:${identitySeed}`);
  const inputId = deterministicId("job_input", `saved-list-import:${identitySeed}`);
  const inputFingerprint = digest(
    JSON.stringify({
      accountId,
      sourceKind: command.source.sourceKind,
      listId,
      listVersion: command.source.listVersion,
      parsedRows,
    }),
  );

  return {
    batchId,
    jobId,
    inputId,
    inputFingerprint,
    parsedRows,
    reviewHref: `/account/inventory/imports?jobId=${jobId}`,
  };
}

function requiredText(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${fieldName} is required.`);
  }
  return normalized;
}

function deterministicId(prefix: string, seed: string): string {
  return `${prefix}_${digest(seed).slice(0, 24)}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
