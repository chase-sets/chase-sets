import type { PgQueryFunction, PgTransactionalPool } from "@chase-sets/event-core-postgres";

export const INVENTORY_IMPORT_SOURCE_FLOOR_MARKER = "20261016_inventory_import_source_contracted";
export const INVENTORY_IMPORT_SOURCE_CONTRACTION = "20261020_inventory_import_raw_source_contraction";

/**
 * Puts a bootstrapped database in the floor window (S2): the safe-snapshot release kept
 * the four raw-source columns a base schema created and wrote its marker, and the
 * ledgered contraction has not run yet. A base rollback may still write those columns.
 */
export async function enterSourceFloor(pool: PgTransactionalPool) {
  await pool.query("DELETE FROM bounded_context_schema_migrations WHERE migration_id = $1", [
    INVENTORY_IMPORT_SOURCE_CONTRACTION,
  ]);
  await pool.query(`ALTER TABLE inventory_import_batch_job_inputs
    ADD COLUMN IF NOT EXISTS csv_text text NULL,
    ADD COLUMN IF NOT EXISTS parsed_rows jsonb NULL,
    ADD COLUMN IF NOT EXISTS source_filename text NULL`);
  await pool.query("ALTER TABLE inventory_import_batches ADD COLUMN IF NOT EXISTS source_filename text NULL");
  await pool.query(
    `INSERT INTO bounded_context_schema_migrations (migration_id, description, applied_at)
     VALUES ($1, 'Safe sources converted before raw writer retirement', now()) ON CONFLICT (migration_id) DO NOTHING`,
    [INVENTORY_IMPORT_SOURCE_FLOOR_MARKER],
  );
}

export async function rawSourceColumns(pool: PgTransactionalPool) {
  const result = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name IN ('inventory_import_batch_job_inputs', 'inventory_import_batches')
       AND column_name IN ('csv_text', 'parsed_rows', 'source_filename')
     ORDER BY table_name, column_name`,
  );
  return result.rows;
}

export async function contractionLedgerRows(pool: PgTransactionalPool) {
  const result = await pool.query<{ migration_id: string }>(
    "SELECT migration_id FROM bounded_context_schema_migrations WHERE migration_id = $1",
    [INVENTORY_IMPORT_SOURCE_CONTRACTION],
  );
  return result.rows;
}

/** Records every statement the pool and its checked-out clients send, in order. */
export function recordingPool(pool: PgTransactionalPool, statements: string[]): PgTransactionalPool {
  return {
    query: ((sql: string, values?: readonly unknown[]) => {
      statements.push(sql);
      return pool.query(sql, values);
    }) as PgQueryFunction,
    connect: async () => {
      const client = await pool.connect();
      return {
        release: (error) => client.release(error),
        query: async <Row>(sql: string, values?: readonly unknown[]) => {
          statements.push(sql);
          return client.query<Row>(sql, values);
        },
      };
    },
  };
}
