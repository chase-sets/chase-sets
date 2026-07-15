// The import-row resolution flow: which rows still need the seller, and the
// auto-advance target after one is resolved. Pure functions shared by the
// import-batch surface (to render resolve triggers and open the resolution
// drawer) and the route action (to auto-advance to the next unresolved row),
// so the "never leave the batch surface" one-flow has a single source of truth.

import type { InventoryImportBatch, InventoryImportBatchDetail, InventoryImportBatchRow } from "../read-model/queries";

// A row still needs the seller when it was rejected, is not yet committed, and
// either came from a saved list (always needs a location/catalog confirmation)
// or is a native-CSV row whose account SKU never resolved to a catalog item.
export function rowNeedsResolution(
  row: InventoryImportBatchRow,
  sourceKey: InventoryImportBatch["source_key"],
): boolean {
  return (
    row.status === "rejected" &&
    (sourceKey === "saved-list" || (sourceKey === "native-csv" && row.resolution_status === "unresolved")) &&
    !row.committed_at
  );
}

// The batch's unresolved rows, in row order — the resolution work queue.
export function unresolvedResolutionRowIds(detail: InventoryImportBatchDetail): readonly string[] {
  return detail.rows.filter((row) => rowNeedsResolution(row, detail.source_key)).map((row) => row.row_id);
}

// The row the resolution drawer should advance to next. After a row is resolved
// it is no longer unresolved, so the auto-advance target is simply the first
// remaining unresolved row; null closes the drawer once the batch is clean.
export function firstUnresolvedRowId(detail: InventoryImportBatchDetail): string | null {
  return unresolvedResolutionRowIds(detail)[0] ?? null;
}

// The row the drawer is currently resolving — only if it still needs the seller,
// so a stale deep link (row already resolved) closes the drawer instead of
// showing an empty form.
export function activeResolutionRow(
  detail: InventoryImportBatchDetail | null,
  rowId: string | null | undefined,
): InventoryImportBatchRow | null {
  if (!detail || !rowId) {
    return null;
  }
  const row = detail.rows.find((candidate) => candidate.row_id === rowId);
  return row && rowNeedsResolution(row, detail.source_key) ? row : null;
}

// The batch surface to return to after resolving a row: the same batch page,
// re-opening the drawer on the next unresolved row (auto-advance) or closing it
// when none remain. The route path never changes, so the seller never leaves.
export function resolveRowRedirectTarget(batchId: string, detail: InventoryImportBatchDetail): string {
  const nextRowId = firstUnresolvedRowId(detail);
  const base = `/account/inventory/imports/${batchId}`;
  return nextRowId ? `${base}?resolveRowId=${encodeURIComponent(nextRowId)}` : base;
}
