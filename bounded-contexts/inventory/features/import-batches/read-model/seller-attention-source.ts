// Inventory's contribution to the Seller Desk attention queue — the import
// resolution source. A plain query module (no HTTP, no UI) that maps import
// batches still carrying unresolved rows into the shared attention item shape.
// Resolution happens in a drawer over the current page, so the deep link opens
// the resolution drawer rather than routing away.

import {
  buildSellerAttentionItem,
  type SellerAttentionContext,
  type SellerAttentionItem,
  type SellerAttentionSource,
} from "@chase-sets/seller-attention-queue";

// The projected fields the source reads from the import-batch read model. Only
// batches whose resolution status is unresolved, with a positive count of rows
// still needing the seller, appear.
export type ImportResolutionAttentionRow = Readonly<{
  batchId: string;
  // Human display reference for the import batch.
  reference: string;
  // How many rows still need the seller to resolve them.
  unresolvedCount: number;
  // ISO-8601 UTC time the batch first needed resolution.
  observedAt: string;
}>;

// Pure mapping: unresolved import-batch rows → attention items. Batches with no
// outstanding rows are dropped so a resolved batch never lingers in the queue.
export function toImportResolutionAttentionItems(
  rows: readonly ImportResolutionAttentionRow[],
): readonly SellerAttentionItem[] {
  return rows
    .filter((row) => row.unresolvedCount > 0)
    .map((row) =>
      buildSellerAttentionItem({
        source: "inventory-resolution",
        entityId: row.batchId,
        severity: "warning",
        summary: { code: "import-rows-unresolved", params: { reference: row.reference, count: row.unresolvedCount } },
        observedAt: row.observedAt,
      }),
    );
}

export type ImportResolutionAttentionSourceDependencies = Readonly<{
  loadImportResolutionRows: (context: SellerAttentionContext) => Promise<readonly ImportResolutionAttentionRow[]>;
}>;

export function createImportResolutionAttentionSource(
  dependencies: ImportResolutionAttentionSourceDependencies,
): SellerAttentionSource {
  return {
    id: "inventory-resolution",
    load: async (context) => toImportResolutionAttentionItems(await dependencies.loadImportResolutionRows(context)),
  };
}
