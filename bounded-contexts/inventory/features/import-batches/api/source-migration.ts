import { withPgTransaction, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { InventoryDomainError } from "../../../support/runtime-support/common";
import type { InventoryImportBatchJobPayload } from "./runtime";
import {
  loadInventoryImportSnapshotHeader,
  prepareInventoryImportLegacySnapshot,
  stageInventoryImportSnapshot,
  type InventoryImportSnapshotInput,
} from "./safe-snapshot";
import type { ImportCsvRow } from "../domain/csv";

export function isImportMigrationPool(db: PgQueryable): db is PgTransactionalPool {
  return "connect" in db && typeof db.connect === "function";
}

/** The input lock and the conversion commit together, including interruption after any chunk. */
export async function migrateInventoryImportSource(
  pool: PgTransactionalPool,
  inputId: string,
  accountId: string,
  fallback?: InventoryImportBatchJobPayload["create"],
) {
  return withPgTransaction(pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`inventory-import-source/${inputId}`]);
    const result = await db.query<{ legacy: Record<string, unknown> }>(
      `SELECT to_jsonb(input) AS legacy FROM inventory_import_batch_job_inputs AS input
       WHERE input_id = $1 AND account_id = $2 FOR UPDATE`, [inputId, accountId]);
    const legacy = result.rows[0]?.legacy;
    if (legacy?.snapshot_version != null) return loadInventoryImportSnapshotHeader(db, inputId, accountId);
    if (!legacy && !fallback?.normalizedRows) throw new InventoryDomainError("Import source is unavailable; reconciliation is required.");
    const input: InventoryImportSnapshotInput = {
      accountId,
      csvText: typeof legacy?.csv_text === "string" ? legacy.csv_text : undefined,
      parsedRows: Array.isArray(legacy?.parsed_rows) ? legacy.parsed_rows as readonly ImportCsvRow[] : undefined,
      sourceKey: legacy?.source_key as InventoryImportSnapshotInput["sourceKey"],
      quantityMode: legacy?.quantity_mode as InventoryImportSnapshotInput["quantityMode"],
      defaultStorageLocationId: legacy?.default_storage_location_id as string | null | undefined,
    };
    const snapshot = prepareInventoryImportLegacySnapshot(input,
      !input.csvText && !input.parsedRows ? fallback?.normalizedRows : undefined);
    await stageInventoryImportSnapshot(db, inputId, snapshot);
    // Column existence is read from the locked row, so this reader also works after contraction.
    if (legacy && Object.hasOwn(legacy, "csv_text")) {
      await db.query(`UPDATE inventory_import_batch_job_inputs
        SET csv_text = NULL, parsed_rows = NULL, source_filename = NULL
        WHERE input_id = $1 AND account_id = $2 AND snapshot_version = 1 AND snapshot_hash = $3`,
      [inputId, accountId, snapshot.header.hash]);
    }
    await db.query(`UPDATE inventory_import_batch_jobs SET payload = jsonb_set(payload, '{create}',
      (payload->'create' - 'normalizedRows') || jsonb_build_object('snapshotVersion', 1, 'snapshotHash', $3::text, 'rowCount', $4::integer))
      WHERE payload->>'accountId' = $2 AND payload #>> '{create,inputId}' = $1`,
    [inputId, accountId, snapshot.header.hash, snapshot.header.rowCount]);
    return snapshot.header;
  });
}
