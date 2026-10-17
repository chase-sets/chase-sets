import { withPgTransaction, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { InventoryDomainError } from "../../../support/runtime-support/common";
import type { InventoryImportBatchJobPayload } from "./runtime";
import {
  INVENTORY_IMPORT_LEGACY_VALUE_MARKER,
  loadInventoryImportSnapshotHeader,
  prepareInventoryImportLegacySnapshot,
  sanitizeInventoryImportLegacyText,
  stageInventoryImportSnapshot,
  type InventoryImportSnapshotInput,
} from "./safe-snapshot";
import type { ImportCsvRow } from "../domain/csv";
import type { InventoryImportSourceKey } from "../domain/import-source-adapters";
import { INVENTORY_IMPORT_LEGACY_JOB_KIND, INVENTORY_IMPORT_SNAPSHOT_JOB_KIND } from "../domain/job-kinds";

const SNAPSHOT_JOB_KIND = INVENTORY_IMPORT_SNAPSHOT_JOB_KIND;
const LEGACY_JOB_KIND = INVENTORY_IMPORT_LEGACY_JOB_KIND;
type MigrationWarning = Readonly<{ recordType: string; recordId: string; field: string; reason: string }>;
let savepointSequence = 0;

async function isolateConversionFailure(
  db: PgQueryable,
  savepoint: string,
  inputId: string,
  accountId: string,
  error: unknown,
) {
  if (!(error instanceof InventoryDomainError)) throw error;
  await db.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  await isolateLegacySource(db, inputId, accountId);
}

function sanitizeRetainedValue(
  value: unknown,
  path: string,
  warnings: MigrationWarning[],
  recordType: string,
  recordId: string,
): unknown {
  if (typeof value === "string") {
    const sanitized = sanitizeInventoryImportLegacyText(value);
    if (sanitized === INVENTORY_IMPORT_LEGACY_VALUE_MARKER)
      warnings.push({ recordType, recordId, field: path, reason: "unsafe-retained-text" });
    return sanitized;
  }
  if (Array.isArray(value))
    return value.map((item, index) => sanitizeRetainedValue(item, `${path}[${index}]`, warnings, recordType, recordId));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) =>
      key === "source_filename" || key === "sourceFilename"
        ? [key, null]
        : [key, sanitizeRetainedValue(item, path ? `${path}.${key}` : key, warnings, recordType, recordId)],
    ),
  );
}

function safeRetainedResult(
  value: unknown,
  sourceKey: InventoryImportSourceKey | undefined,
  recordType: string,
  recordId: string,
  warnings: MigrationWarning[],
): unknown {
  const sanitized = sanitizeRetainedValue(value, "result", warnings, recordType, recordId);
  if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) return sanitized;
  const record = sanitized as Record<string, unknown>;
  if (!Object.hasOwn(record, "raw_row")) return record;
  const source = (record.source_key ?? sourceKey) as InventoryImportSourceKey | undefined;
  try {
    const snapshot = prepareInventoryImportLegacySnapshot({
      accountId: "legacy-result",
      sourceKey: source,
      parsedRows: [{ rowNumber: 1, values: record.raw_row as Record<string, string> }],
    });
    return { ...record, raw_row: snapshot.rows[0].rawRow };
  } catch {
    warnings.push({ recordType, recordId, field: "result.raw_row", reason: "unsafe-retained-text" });
    return { ...record, raw_row: { rowNote: INVENTORY_IMPORT_LEGACY_VALUE_MARKER } };
  }
}

function addWarnings(value: unknown, warnings: readonly MigrationWarning[]): unknown {
  if (!warnings.length) return value;
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>), legacyMigrationWarnings: warnings }
    : { value, legacyMigrationWarnings: warnings };
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
      ((payload->'create') - 'normalizedRows') || jsonb_build_object('snapshotVersion', 1, 'snapshotHash', $3::text, 'rowCount', $4::integer)),
      job_kind = CASE WHEN job_kind = $5::text THEN $6::text ELSE job_kind END
      WHERE payload->>'accountId' = $2 AND payload #>> '{create,inputId}' = $1`,
    [inputId, accountId, hash, rowCount, LEGACY_JOB_KIND, SNAPSHOT_JOB_KIND],
  );
  await db.query(
    `UPDATE inventory_import_batch_work_units AS unit
        SET unit_kind = $3::text
       FROM inventory_import_batch_jobs AS job
      WHERE unit.job_id = job.job_id
        AND unit.unit_kind = $4::text
        AND unit.state = 'queued'
        AND job.job_kind = $3::text
        AND job.payload->>'accountId' = $2
        AND job.payload #>> '{create,inputId}' = $1`,
    [inputId, accountId, SNAPSHOT_JOB_KIND, LEGACY_JOB_KIND],
  );
}

async function isolateLegacySource(db: PgQueryable, inputId: string, accountId: string) {
  await db.query(
    `UPDATE inventory_import_batch_job_inputs
        SET csv_text = NULL, parsed_rows = NULL, source_filename = NULL
      WHERE input_id = $1 AND account_id = $2`,
    [inputId, accountId],
  );
  await db.query(
    `UPDATE inventory_import_batch_jobs
        SET status = 'failed',
            progress = jsonb_set(jsonb_set(progress, '{phase}', '"failed"'::jsonb), '{message}', '"import_job_failed_reconciliation_required"'::jsonb),
            error_message = 'import_job_failed_reconciliation_required',
            claim_owner_id = NULL, claimed_until = NULL,
            completed_at = COALESCE(completed_at, now()), updated_at = now()
      WHERE payload->>'accountId' = $2
        AND payload #>> '{create,inputId}' = $1
        AND status IN ('queued', 'running')`,
    [inputId, accountId],
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
    const state = await db.query<
      Readonly<{ marker_exists: boolean; legacy_inputs: boolean; normalized_jobs: boolean }>
    >(`
      SELECT
        EXISTS (
          SELECT 1 FROM bounded_context_schema_migrations
          WHERE migration_id = '20261016_inventory_import_source_contracted'
        ) AS marker_exists,
        EXISTS (
          SELECT 1 FROM inventory_import_batch_job_inputs
          WHERE csv_text IS NOT NULL OR parsed_rows IS NOT NULL OR source_filename IS NOT NULL
        ) AS legacy_inputs,
        EXISTS (
          SELECT 1 FROM inventory_import_batch_jobs
          WHERE status IN ('queued', 'running') AND payload #> '{create,normalizedRows}' IS NOT NULL
        ) AS normalized_jobs`);
    const current = state.rows[0];
    if (current?.marker_exists && !current.legacy_inputs && !current.normalized_jobs) return;
    // Old writers cannot insert between the final census and source nulling.
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
      for (const row of page.rows) {
        const savepoint = `import_source_${savepointSequence++}`;
        await db.query(`SAVEPOINT ${savepoint}`);
        try {
          await convertSource(db, row.input_id, row.account_id);
        } catch (error) {
          await isolateConversionFailure(db, savepoint, row.input_id, row.account_id, error);
        }
        await db.query(`RELEASE SAVEPOINT ${savepoint}`);
      }
      after = page.rows[page.rows.length - 1].input_id;
    }
    after = "";
    for (;;) {
      const page = await db.query<{ job_id: string; payload: InventoryImportBatchJobPayload }>(
        `SELECT job_id, payload
        FROM inventory_import_batch_jobs WHERE job_id > $1 AND status IN ('queued', 'running')
          AND payload #> '{create,normalizedRows}' IS NOT NULL
        ORDER BY job_id LIMIT 100`,
        [after],
      );
      if (!page.rows.length) break;
      for (const job of page.rows) {
        if (!job.payload.create?.inputId) throw new InventoryDomainError("Import source requires reconciliation.");
        const savepoint = `import_source_${savepointSequence++}`;
        await db.query(`SAVEPOINT ${savepoint}`);
        try {
          await convertSource(db, job.payload.create.inputId, job.payload.accountId, job.payload.create);
        } catch (error) {
          await isolateConversionFailure(db, savepoint, job.payload.create.inputId, job.payload.accountId, error);
        }
        await db.query(`RELEASE SAVEPOINT ${savepoint}`);
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
        const warnings: MigrationWarning[] = [];
        const sanitized = sanitizeRetainedValue(row.raw_row, "raw_row", warnings, "batch-row", row.row_id);
        let rawRow: Record<string, string>;
        try {
          const safe = prepareInventoryImportLegacySnapshot({
            accountId: row.account_id,
            sourceKey: row.source_key,
            parsedRows: [{ rowNumber: row.row_number, values: sanitized as Record<string, string> }],
          });
          rawRow = safe.rows[0].rawRow;
        } catch {
          warnings.push({
            recordType: "batch-row",
            recordId: row.row_id,
            field: "raw_row",
            reason: "unsafe-retained-text",
          });
          rawRow = { rowNote: INVENTORY_IMPORT_LEGACY_VALUE_MARKER };
        }
        await db.query("UPDATE inventory_import_batch_rows SET raw_row = $2::jsonb WHERE row_id = $1", [
          row.row_id,
          JSON.stringify(addWarnings(rawRow, warnings)),
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
        const warnings: MigrationWarning[] = [];
        await db.query("UPDATE inventory_import_batch_jobs SET result = $2::jsonb WHERE job_id = $1", [
          job.job_id,
          JSON.stringify(
            addWarnings(safeRetainedResult(job.result, undefined, "job-result", job.job_id, warnings), warnings),
          ),
        ]);
        let sequence = 0;
        for (;;) {
          const events = await db.query<{ sequence: number; snapshot: unknown }>(
            `SELECT sequence, snapshot
            FROM inventory_import_batch_job_events WHERE job_id = $1 AND sequence > $2 ORDER BY sequence LIMIT 100`,
            [job.job_id, sequence],
          );
          if (!events.rows.length) break;
          for (const event of events.rows) {
            const warnings: MigrationWarning[] = [];
            await db.query(
              `UPDATE inventory_import_batch_job_events SET snapshot = $3::jsonb
            WHERE job_id = $1 AND sequence = $2`,
              [
                job.job_id,
                event.sequence,
                JSON.stringify(
                  addWarnings(
                    safeRetainedResult(
                      event.snapshot,
                      undefined,
                      "job-event",
                      `${job.job_id}:${event.sequence}`,
                      warnings,
                    ),
                    warnings,
                  ),
                ),
              ],
            );
          }
          sequence = events.rows[events.rows.length - 1].sequence;
        }
      }
      after = page.rows[page.rows.length - 1].job_id;
    }
    // Keep raw columns through this release so a base worker can roll back safely.
    await db.query(`INSERT INTO bounded_context_schema_migrations (migration_id, description, applied_at)
      VALUES ('20261016_inventory_import_source_contracted', 'Safe sources converted before raw writer retirement', now())
      ON CONFLICT (migration_id) DO NOTHING`);
  });
}
