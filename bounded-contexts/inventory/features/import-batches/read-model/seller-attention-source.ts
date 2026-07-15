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
import type { PgQueryable } from "@chase-sets/event-core-postgres";

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

export function createImportResolutionAttentionSourceFromReadModel(db: PgQueryable): SellerAttentionSource {
  return createImportResolutionAttentionSource({
    loadImportResolutionRows: async (context) => {
      const result = await db.query<{
        batch_id: string;
        source_filename: string | null;
        unresolved_count: number;
        observed_at: string;
      }>(
        `SELECT
           batch.batch_id,
           batch.source_filename,
           COUNT(*)::integer AS unresolved_count,
           MIN(row.updated_at) AS observed_at
         FROM inventory_import_batches AS batch
         INNER JOIN inventory_import_batch_rows AS row
           ON row.batch_id = batch.batch_id
         WHERE batch.account_id = $1
           AND row.resolution_status = 'unresolved'
           AND row.status <> 'committed'
         GROUP BY batch.batch_id, batch.source_filename
         ORDER BY MIN(row.updated_at) ASC, batch.batch_id ASC`,
        [context.accountId],
      );

      return result.rows.map((row) => ({
        batchId: row.batch_id,
        reference: row.source_filename ?? row.batch_id,
        unresolvedCount: row.unresolved_count,
        observedAt: row.observed_at,
      }));
    },
  });
}
