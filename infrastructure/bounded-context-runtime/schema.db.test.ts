import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";
import type { PgQueryResult, PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase, SCHEMA_MIGRATIONS_TABLE, type SchemaBootstrapOptions } from "./schema";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "./test-support";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
const describeDb = databaseUrl ? describe : describe.skip;

const contextName = "runtime";
const schemaSql = "CREATE TABLE IF NOT EXISTS data_step_writes (source text NOT NULL);";
const migrationId = "20261017_data_step_example";
const description = "Write through a data step and a statement.";
const ledgerCheckSql = `SELECT 1 FROM ${SCHEMA_MIGRATIONS_TABLE} WHERE migration_id = $1`;
const ledgerInsertSql = `INSERT INTO ${SCHEMA_MIGRATIONS_TABLE} (migration_id, description, applied_at) VALUES ($1, $2, now())`;
const stepWriteSql = "INSERT INTO data_step_writes (source) VALUES ($1)";
const statementWriteSql = "INSERT INTO data_step_writes (source) VALUES ('statement')";

type ForwardedSql = Readonly<{ sql: string; values?: readonly unknown[] }>;

describeDb("applies a migration data step atomically", () => {
  let pool: PgTransactionalPool;
  let pools: Readonly<Record<typeof contextName, PgTransactionalPool>>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseUrl!, [contextName], "schema_data_step");
    await ensureMultiContextTestDatabases(databaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    pool = pools[contextName];
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrap([], pool);
  });
  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  it("applies the step, its statements and its ledger row once", async () => {
    let stepCalls = 0;
    const migration = dataStepMigration(async (db) => {
      stepCalls += 1;
      await writeFromStep(db, "step");
      await db.query("SAVEPOINT data_step_row");
      await writeFromStep(db, "discarded");
      await db.query("ROLLBACK TO SAVEPOINT data_step_row");
      await db.query("RELEASE SAVEPOINT data_step_row");
    });

    const first = observeForwardedSql(pool);
    await bootstrap([migration], first.pool);
    const second = observeForwardedSql(pool);
    await bootstrap([migration], second.pool);

    expect(migrationSql(first.forwarded)).toEqual([
      ledgerCheckSql,
      "BEGIN",
      stepWriteSql,
      "SAVEPOINT data_step_row",
      stepWriteSql,
      "ROLLBACK TO SAVEPOINT data_step_row",
      "RELEASE SAVEPOINT data_step_row",
      statementWriteSql,
      ledgerInsertSql,
      "COMMIT",
    ]);
    expect(migrationSql(second.forwarded)).toEqual([ledgerCheckSql]);
    expect(stepCalls).toBe(1);
    expect(await writes()).toEqual(["statement", "step"]);
    expect(await ledgerRows()).toEqual([migrationId]);
  });

  it("upgrades the prior configuration-epoch schema and ledgers it exactly once", async () => {
    await pool.query(
      "DROP TABLE event_configuration_guard_history, event_configuration_journal_heads, event_configuration_store_identity",
    );
    await pool.query(`DELETE FROM ${SCHEMA_MIGRATIONS_TABLE} WHERE migration_id = $1`, [
      "20261022_configuration_epoch_closure",
    ]);
    await pool.query("INSERT INTO data_step_writes (source) VALUES ('prior-schema-business-row')");
    await bootstrap([], pool);
    await bootstrap([], pool);
    const tables = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM information_schema.tables WHERE table_schema = current_schema() AND table_name IN ('event_configuration_guard_history', 'event_configuration_journal_heads', 'event_configuration_store_identity')",
    );
    expect(tables.rows[0]?.count).toBe("3");
    const ledger = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${SCHEMA_MIGRATIONS_TABLE} WHERE migration_id = $1`,
      ["20261022_configuration_epoch_closure"],
    );
    expect(ledger.rows[0]?.count).toBe("1");
    expect(await writes()).toEqual(["prior-schema-business-row"]);
  });

  it("upgrades the prior owner-stream schema, preserves business data and ledgers it once", async () => {
    await pool.query(
      "DROP TABLE event_owner_stream_reservations, event_owner_stream_invalidations, event_request_terminals, event_owner_stream_inbound_evidence",
    );
    await pool.query(`DELETE FROM ${SCHEMA_MIGRATIONS_TABLE} WHERE migration_id = $1`, [
      "20261028_owner_stream_reservations",
    ]);
    await pool.query("INSERT INTO data_step_writes (source) VALUES ('prior-owner-stream-business-row')");
    const first = observeForwardedSql(pool);
    await bootstrap([], first.pool);
    const second = observeForwardedSql(pool);
    await bootstrap([], second.pool);
    const creates = first.forwarded.filter((entry) =>
      entry.sql.includes("CREATE TABLE IF NOT EXISTS event_owner_stream_reservations"),
    );
    expect(creates).toHaveLength(1);
    expect(first.forwarded.findIndex((entry) => entry === creates[0])).toBeGreaterThan(
      first.forwarded.findIndex(
        (entry) => entry.sql === ledgerCheckSql && entry.values?.[0] === "20261028_owner_stream_reservations",
      ),
    );
    expect(
      second.forwarded.some((entry) =>
        entry.sql.includes("CREATE TABLE IF NOT EXISTS event_owner_stream_reservations"),
      ),
    ).toBe(false);
    const tables = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM information_schema.tables WHERE table_schema = current_schema() AND table_name IN ('event_owner_stream_reservations', 'event_owner_stream_invalidations', 'event_request_terminals', 'event_owner_stream_inbound_evidence')",
    );
    expect(tables.rows[0]?.count).toBe("4");
    const ledger = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${SCHEMA_MIGRATIONS_TABLE} WHERE migration_id = $1`,
      ["20261028_owner_stream_reservations"],
    );
    expect(ledger.rows[0]?.count).toBe("1");
    expect(await writes()).toEqual(["prior-owner-stream-business-row"]);
  });

  it("leaves no write or ledger row when the step throws after writing, then applies once", async () => {
    let failStep = true;
    const migration = dataStepMigration(async (db) => {
      await writeFromStep(db, "step");
      if (failStep) throw new Error("data step failed after writing");
    });

    await expect(bootstrap([migration], pool)).rejects.toThrow("data step failed after writing");
    expect(await writes()).toEqual([]);
    expect(await ledgerRows()).toEqual([]);

    failStep = false;
    await bootstrap([migration], pool);
    await bootstrap([migration], pool);
    expect(await writes()).toEqual(["statement", "step"]);
    expect(await ledgerRows()).toEqual([migrationId]);
  });

  it("leaves no write or ledger row when a statement fails after writes, then applies once", async () => {
    const migration: BcSchemaMigration = {
      ...dataStepMigration((db) => writeFromStep(db, "step")),
      statements: [statementWriteSql, "INSERT INTO data_step_prerequisites (source) VALUES ('statement')"],
    };

    await expect(bootstrap([migration], pool)).rejects.toThrow('relation "data_step_prerequisites" does not exist');
    expect(await writes()).toEqual([]);
    expect(await ledgerRows()).toEqual([]);

    await pool.query("CREATE TABLE data_step_prerequisites (source text NOT NULL)");
    await bootstrap([migration], pool);
    await bootstrap([migration], pool);
    expect(await writes()).toEqual(["statement", "step"]);
    expect(await ledgerRows()).toEqual([migrationId]);
  });

  it("retries a lock-timed-out step from scratch through the bootstrap retry loop", async () => {
    await pool.query("CREATE TABLE data_step_locked (source text NOT NULL)");
    const locker = await pool.connect();
    let stepCalls = 0;
    const migration: BcSchemaMigration = {
      ...dataStepMigration(async (db) => {
        stepCalls += 1;
        if (stepCalls === 2) await locker.query("COMMIT");
        await writeFromStep(db, "step");
      }),
      statements: ["INSERT INTO data_step_locked (source) VALUES ('statement')"],
    };

    try {
      await locker.query("BEGIN");
      await locker.query("LOCK TABLE data_step_locked IN ACCESS EXCLUSIVE MODE");
      await bootstrap([migration], pool, {
        lockTimeoutMs: 100,
        lockTimeoutRetryBudgetMs: 30_000,
        lockTimeoutRetryBaseDelayMs: 1,
        lockTimeoutRetryJitterMs: 0,
      });
    } finally {
      locker.release(true);
    }

    expect(stepCalls).toBe(2);
    expect(await writes()).toEqual(["step"]);
    expect((await pool.query("SELECT source FROM data_step_locked")).rows).toEqual([{ source: "statement" }]);
    expect(await ledgerRows()).toEqual([migrationId]);
  });

  it("rejects CONCURRENTLY in a data step migration's statements before its ledger check", async () => {
    let stepCalls = 0;
    const migration: BcSchemaMigration = {
      ...dataStepMigration(async (db) => {
        stepCalls += 1;
        await writeFromStep(db, "step");
      }),
      statements: ["create index concurrently if not exists data_step_writes_source_idx on data_step_writes (source)"],
    };

    const baseline = observeForwardedSql(pool);
    await bootstrap([], baseline.pool);
    const observed = observeForwardedSql(pool);
    const failure = await bootstrap([migration], observed.pool).catch((error: unknown) => error);

    expect(observed.forwarded).toEqual(baseline.forwarded);
    expect(stepCalls).toBe(0);
    expect(failure).toMatchObject({
      message: `Schema migration ${migrationId} has a data step, so its statements run in a transaction and cannot use CONCURRENTLY.`,
    });
    expect(await writes()).toEqual([]);
    expect(await ledgerRows()).toEqual([]);
  });

  it("refuses a step's CREATE INDEX CONCURRENTLY before forwarding it", async () => {
    const migration = dataStepMigration(async (db) => {
      await db.query("CREATE INDEX CONCURRENTLY data_step_writes_source_idx ON data_step_writes (source)");
    });

    const observed = observeForwardedSql(pool);
    const failure = await bootstrap([migration], observed.pool).catch((error: unknown) => error);

    expect(migrationSql(observed.forwarded)).toEqual([ledgerCheckSql, "BEGIN", "ROLLBACK"]);
    expect(failure).toMatchObject({
      message: `Schema migration ${migrationId} data step SQL cannot use CONCURRENTLY inside the migration transaction.`,
    });
    expect(await writes()).toEqual([]);
    expect(await writesIndexes()).toEqual([]);
    expect(await ledgerRows()).toEqual([]);
  });

  it("keeps statement-only migrations outside a transaction", async () => {
    const createIndexSql =
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS data_step_writes_source_idx ON data_step_writes (source)";
    const migration: BcSchemaMigration = { migrationId, description, statements: [createIndexSql] };

    const observed = observeForwardedSql(pool);
    await bootstrap([migration], observed.pool);

    expect(migrationSql(observed.forwarded)).toEqual([ledgerCheckSql, createIndexSql, ledgerInsertSql]);
    expect(await writesIndexes()).toEqual(["data_step_writes_source_idx"]);
    expect(await ledgerRows()).toEqual([migrationId]);
  });

  function bootstrap(
    schemaMigrations: readonly BcSchemaMigration[],
    target: PgTransactionalPool,
    options?: SchemaBootstrapOptions,
  ): Promise<void> {
    return bootstrapContextDatabase({ contextName, schemaSql, schemaMigrations }, target, options);
  }

  async function writes(): Promise<readonly string[]> {
    const result = await pool.query<{ source: string }>("SELECT source FROM data_step_writes ORDER BY source");
    return result.rows.map((row) => row.source);
  }

  async function writesIndexes(): Promise<readonly string[]> {
    const result = await pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'data_step_writes' ORDER BY indexname",
    );
    return result.rows.map((row) => row.indexname);
  }

  async function ledgerRows(): Promise<readonly string[]> {
    const result = await pool.query<{ migration_id: string }>(
      `SELECT migration_id FROM ${SCHEMA_MIGRATIONS_TABLE} WHERE migration_id = $1`,
      [migrationId],
    );
    return result.rows.map((row) => row.migration_id);
  }
});

function dataStepMigration(dataStep: NonNullable<BcSchemaMigration["dataStep"]>): BcSchemaMigration {
  return { migrationId, description, statements: [statementWriteSql], dataStep };
}

async function writeFromStep(db: PgQueryable, source: string): Promise<void> {
  await db.query(stepWriteSql, [source]);
}

function observeForwardedSql(
  pool: PgTransactionalPool,
): Readonly<{ pool: PgTransactionalPool; forwarded: readonly ForwardedSql[] }> {
  const forwarded: ForwardedSql[] = [];

  return {
    forwarded,
    pool: {
      query<Row = Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<PgQueryResult<Row>> {
        return pool.query<Row>(sql, values);
      },
      async connect() {
        const client = await pool.connect();
        return {
          query<Row = Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<PgQueryResult<Row>> {
            forwarded.push(values === undefined ? { sql: normalizeSql(sql) } : { sql: normalizeSql(sql), values });
            return client.query<Row>(sql, values);
          },
          release: (error?: unknown) => client.release(error),
        };
      },
    },
  };
}

function migrationSql(forwarded: readonly ForwardedSql[]): readonly string[] {
  const start = forwarded.findIndex((entry) => entry.values?.includes(migrationId));
  const end = forwarded.findIndex((entry) => entry.sql === "RESET lock_timeout");
  return start === -1 ? [] : forwarded.slice(start, end).map((entry) => entry.sql);
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}
