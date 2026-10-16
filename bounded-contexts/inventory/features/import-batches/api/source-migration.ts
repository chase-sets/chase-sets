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
import type { InventoryImportSourceKey } from "../domain/import-source-adapters";

function safeRetainedResult(value: unknown, sourceKey?: InventoryImportSourceKey): unknown {
  if (Array.isArray(value)) return value.map((item) => safeRetainedResult(item, sourceKey));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const source = (record.source_key ?? sourceKey) as InventoryImportSourceKey | undefined;
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => {
      if (key === "source_filename" || key === "sourceFilename") return [key, null];
      if (key === "raw_row") {
        const snapshot = prepareInventoryImportLegacySnapshot({
          accountId: "legacy-result",
          sourceKey: source,
          parsedRows: [{ rowNumber: 1, values: item as Record<string, string> }],
        });
        return [key, snapshot.rows[0].rawRow];
      }
      return [key, safeRetainedResult(item, source)];
    }),
  );
}

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
  return withPgTransaction(pool, (db) => convertSource(db, inputId, accountId, fallback));
}

async function convertSource(
  db: PgQueryable,
  inputId: string,
  accountId: string,
  fallback?: InventoryImportBatchJobPayload["create"],
) {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`inventory-import-source/${inputId}`]);
  const result = await db.query<{ legacy: Record<string, unknown> }>(
    `SELECT to_jsonb(input) AS legacy FROM inventory_import_batch_job_inputs AS input
       WHERE input_id = $1 AND account_id = $2 FOR UPDATE`,
    [inputId, accountId],
  );
  const legacy = result.rows[0]?.legacy;
  if (legacy?.snapshot_version != null) {
    const header = await loadInventoryImportSnapshotHeader(db, inputId, accountId);
    await bindJobs(db, inputId, accountId, header.hash, header.rowCount);
    return header;
  }
  if (!legacy && !fallback?.normalizedRows)
    throw new InventoryDomainError("Import source is unavailable; reconciliation is required.");
  const input: InventoryImportSnapshotInput = {
    accountId,
    csvText: typeof legacy?.csv_text === "string" ? legacy.csv_text : undefined,
    parsedRows: Array.isArray(legacy?.parsed_rows) ? (legacy.parsed_rows as readonly ImportCsvRow[]) : undefined,
    sourceKey: legacy?.source_key as InventoryImportSnapshotInput["sourceKey"],
    quantityMode: legacy?.quantity_mode as InventoryImportSnapshotInput["quantityMode"],
    defaultStorageLocationId: legacy?.default_storage_location_id as string | null | undefined,
  };
  let normalizedRows = fallback?.normalizedRows;
  if (!input.csvText && !input.parsedRows && !normalizedRows) {
    const jobs = await db.query<{ payload: InventoryImportBatchJobPayload }>(
      `SELECT payload
        FROM inventory_import_batch_jobs WHERE payload->>'accountId' = $2 AND payload #>> '{create,inputId}' = $1
          AND payload #> '{create,normalizedRows}' IS NOT NULL LIMIT 2`,
      [inputId, accountId],
    );
    if (jobs.rows.length !== 1) throw new InventoryDomainError("Import source requires reconciliation.");
    normalizedRows = jobs.rows[0].payload.create?.normalizedRows;
  }
  const snapshot = prepareInventoryImportLegacySnapshot(
    input,
    !input.csvText && !input.parsedRows ? normalizedRows : undefined,
  );
  await stageInventoryImportSnapshot(db, inputId, snapshot);
  // Column existence is read from the locked row, so this reader also works after contraction.
  if (legacy && Object.hasOwn(legacy, "csv_text")) {
    await db.query(
      `UPDATE inventory_import_batch_job_inputs
        SET csv_text = NULL, parsed_rows = NULL, source_filename = NULL
        WHERE input_id = $1 AND account_id = $2 AND snapshot_version = 1 AND snapshot_hash = $3`,
      [inputId, accountId, snapshot.header.hash],
    );
  }
  await bindJobs(db, inputId, accountId, snapshot.header.hash, snapshot.header.rowCount);
  return snapshot.header;
}

async function bindJobs(db: PgQueryable, inputId: string, accountId: string, hash: string, rowCount: number) {
  await db.query(
    `UPDATE inventory_import_batch_jobs SET payload = jsonb_set(payload, '{create}',
      (payload->'create' - 'normalizedRows') || jsonb_build_object('snapshotVersion', 1, 'snapshotHash', $3::text, 'rowCount', $4::integer))
      WHERE payload->>'accountId' = $2 AND payload #>> '{create,inputId}' = $1`,
    [inputId, accountId, hash, rowCount],
  );
}

/** Drain the reader-compatible expansion before retiring the old writer surface. */
export async function contractInventoryImportSources(pool: PgTransactionalPool) {
  return withPgTransaction(pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('inventory-import-source-cutover/v1', 0))");
    const columns = await db.query(`SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'inventory_import_batch_job_inputs'
        AND column_name = 'csv_text'`);
    if (!columns.rows.length) return;
    // Old writers cannot insert between the final census and column retirement.
    await db.query(`LOCK TABLE inventory_import_batch_job_inputs, inventory_import_batch_jobs,
      inventory_import_batches, inventory_import_batch_rows, inventory_import_batch_job_events IN SHARE ROW EXCLUSIVE MODE`);
    let after = "";
    for (;;) {
      const page = await db.query<{ input_id: string; account_id: string }>(
        `SELECT input_id, account_id
        FROM inventory_import_batch_job_inputs WHERE input_id > $1 ORDER BY input_id LIMIT 100`,
        [after],
      );
      if (!page.rows.length) break;
      for (const row of page.rows) await convertSource(db, row.input_id, row.account_id);
      after = page.rows[page.rows.length - 1].input_id;
    }
    after = "";
    for (;;) {
      const page = await db.query<{ job_id: string; payload: InventoryImportBatchJobPayload }>(
        `SELECT job_id, payload
        FROM inventory_import_batch_jobs WHERE job_id > $1 AND payload #> '{create,normalizedRows}' IS NOT NULL
        ORDER BY job_id LIMIT 100`,
        [after],
      );
      if (!page.rows.length) break;
      for (const job of page.rows) {
        if (!job.payload.create?.inputId) throw new InventoryDomainError("Import source requires reconciliation.");
        await convertSource(db, job.payload.create.inputId, job.payload.accountId, job.payload.create);
      }
      after = page.rows[page.rows.length - 1].job_id;
    }
    after = "";
    for (;;) {
      const page = await db.query<{
        row_id: string;
        account_id: string;
        source_key: InventoryImportSourceKey;
        row_number: number;
        raw_row: Record<string, string>;
      }>(
        `SELECT row.row_id, batch.account_id,
          batch.source_key, row.row_number, row.raw_row FROM inventory_import_batch_rows AS row
        JOIN inventory_import_batches AS batch ON batch.batch_id = row.batch_id
        WHERE row.row_id > $1 ORDER BY row.row_id LIMIT 100`,
        [after],
      );
      if (!page.rows.length) break;
      for (const row of page.rows) {
        const safe = prepareInventoryImportLegacySnapshot({
          accountId: row.account_id,
          sourceKey: row.source_key,
          parsedRows: [{ rowNumber: row.row_number, values: row.raw_row }],
        });
        await db.query("UPDATE inventory_import_batch_rows SET raw_row = $2::jsonb WHERE row_id = $1", [
          row.row_id,
          JSON.stringify(safe.rows[0].rawRow),
        ]);
      }
      after = page.rows[page.rows.length - 1].row_id;
    }
    after = "";
    for (;;) {
      const page = await db.query<{ job_id: string; result: unknown }>(
        `SELECT job_id, result
        FROM inventory_import_batch_jobs WHERE job_id > $1 ORDER BY job_id LIMIT 100`,
        [after],
      );
      if (!page.rows.length) break;
      for (const job of page.rows) {
        await db.query("UPDATE inventory_import_batch_jobs SET result = $2::jsonb WHERE job_id = $1", [
          job.job_id,
          JSON.stringify(safeRetainedResult(job.result)),
        ]);
        let sequence = 0;
        for (;;) {
          const events = await db.query<{ sequence: number; snapshot: unknown }>(
            `SELECT sequence, snapshot
            FROM inventory_import_batch_job_events WHERE job_id = $1 AND sequence > $2 ORDER BY sequence LIMIT 100`,
            [job.job_id, sequence],
          );
          if (!events.rows.length) break;
          for (const event of events.rows)
            await db.query(
              `UPDATE inventory_import_batch_job_events SET snapshot = $3::jsonb
            WHERE job_id = $1 AND sequence = $2`,
              [job.job_id, event.sequence, JSON.stringify(safeRetainedResult(event.snapshot))],
            );
          sequence = events.rows[events.rows.length - 1].sequence;
        }
      }
      after = page.rows[page.rows.length - 1].job_id;
    }
    await db.query(`ALTER TABLE inventory_import_batch_job_inputs
      DROP COLUMN csv_text, DROP COLUMN parsed_rows, DROP COLUMN source_filename`);
    await db.query("ALTER TABLE inventory_import_batches DROP COLUMN IF EXISTS source_filename");
    await db.query(`INSERT INTO bounded_context_schema_migrations (migration_id, description, applied_at)
      VALUES ('20261016_inventory_import_source_contracted', 'Safe sources converted before raw writer retirement', now())
      ON CONFLICT (migration_id) DO NOTHING`);
  });
}
