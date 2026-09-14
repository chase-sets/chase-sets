import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { parseGlobalPosition } from "@chase-sets/event-core/storage";
import { module as channelsModule } from "../../../index";
import { channelProviderRegistry } from "../../publication-port/api/registry";
import { createOutboundSyncRuntime } from "../api/runtime";
import { outboundSyncSchemaMigrations } from "../read-model/schema";
import {
  outboundSyncSchemaMigrations as predecessorMigrations,
  outboundSyncSchemaSql as predecessorSchemaSql,
} from "./fixtures/pre-reconciliation-schema.test-data";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for Channels DB tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
let pools: Readonly<Record<"channels", PgTransactionalPool>>;

describeDb("outbound-sync schema upgrades", () => {
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["channels"], "outbound_schema_upgrade");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => resetMultiContextTestSchemas(pools));
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  it("boots the retained last-good outbound schema through production Channels with data, guards and fresh parity", async () => {
    await retainLastGoodOutboundSchema();
    const retained = await outboundRows();
    const predecessorLedger = await outboundLedger();
    expect(retained.channel_outbound_operations).toHaveLength(4);
    expect(retained.channel_outbound_operations.every((row) => !("operation_origin" in row))).toBe(true);
    const oldIndexes = await outboundIndexes();
    expect(
      oldIndexes.find((row) => row.name === "channel_outbound_operations_source_event_uidx")?.predicate,
    ).toBeNull();
    expect(oldIndexes.some((row) => row.name === "channel_outbound_operations_pending_lane_order_idx")).toBe(false);

    // The deployed entry executes the complete Channels schemaSql before its ledgered migrations.
    await bootstrapContextDatabase(channelsModule, pools.channels);
    const upgradedRows = await outboundRows();
    expect(upgradedRows).toEqual({
      ...retained,
      channel_outbound_operations: retained.channel_outbound_operations.map((row) => ({
        ...row,
        operation_origin: "desired-state",
      })),
    });
    const upgradedLedger = await outboundLedger();
    expect(upgradedLedger).toEqual(expect.arrayContaining(predecessorLedger));
    expect(upgradedLedger.map((row) => row.migration_id)).toEqual(
      outboundSyncSchemaMigrations.map((entry) => entry.migrationId).sort(),
    );
    const upgradedShape = await outboundShape();
    const upgradedIndexes = await outboundIndexes();
    expect(upgradedIndexes).toHaveLength(9);
    expect(upgradedIndexes.every((row) => row.indisvalid && row.indisready)).toBe(true);
    await assertOutboundGuards();
    const guardedRows = await outboundRows();

    await bootstrapContextDatabase(channelsModule, pools.channels);
    await bootstrapContextDatabase(channelsModule, pools.channels);
    expect(await outboundRows()).toEqual(guardedRows);
    expect(await outboundLedger()).toEqual(upgradedLedger);
    expect(await outboundIndexes()).toEqual(upgradedIndexes);
    expect(await outboundShape()).toEqual(upgradedShape);

    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(channelsModule, pools.channels);
    expect(await outboundShape()).toEqual(upgradedShape);
    expect((await outboundLedger()).map((row) => row.migration_id)).toEqual(
      upgradedLedger.map((row) => row.migration_id),
    );
    await seedRetainedOutboundRows();
    await assertOutboundGuards();
  });

  it("rejects the compatibility-omitted production boot with exactly PostgreSQL 42703 before migrations", async () => {
    await retainLastGoodOutboundSchema();
    const retained = await outboundRows();
    const ledger = await outboundLedger();
    const indexes = await outboundIndexes();
    const compatibilityStatement = outboundSyncSchemaMigrations[2]!.statements[1]!;
    const compatibilityOmitted = {
      ...channelsModule,
      schemaSql: channelsModule.schemaSql.replace(`${compatibilityStatement};`, ""),
    };
    await expect(bootstrapContextDatabase(compatibilityOmitted, pools.channels)).rejects.toMatchObject({
      code: "42703",
      message: 'column "operation_origin" does not exist',
    });
    expect(await outboundRows()).toEqual(retained);
    expect(await outboundLedger()).toEqual(ledger);
    expect(await outboundIndexes()).toEqual(indexes);
  });

  it("upgrades the exact predecessor ledger and replays a durable reservation receipt", async () => {
    const predecessor = outboundSyncSchemaMigrations[0];
    const receiptMigration = outboundSyncSchemaMigrations[1];
    expect(predecessor).toMatchObject({
      migrationId: "20260907_channels_outbound_sync",
      description: "Create durable latest-state outbound operations, lane isolation, and provider rate state.",
    });
    expect(predecessor?.statements.join("\n")).not.toContain("channel_outbound_reservation_settlements");
    expect(receiptMigration).toMatchObject({ migrationId: "20260910_channels_outbound_reservation_settlements" });

    await pools.channels.query(`CREATE TABLE bounded_context_schema_migrations (
      migration_id text PRIMARY KEY,
      description text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    for (const statement of predecessor!.statements) await pools.channels.query(statement);
    await pools.channels.query(
      `INSERT INTO bounded_context_schema_migrations (migration_id,description)
       VALUES ($1,$2)`,
      [predecessor!.migrationId, predecessor!.description],
    );
    await expect(
      pools.channels.query("SELECT to_regclass('channel_outbound_reservation_settlements')::text AS table_name"),
    ).resolves.toMatchObject({ rows: [{ table_name: null }] });

    await bootstrapContextDatabase(channelsModule, pools.channels);
    expect(
      await pools.channels.query(
        `SELECT migration_id FROM bounded_context_schema_migrations
         WHERE migration_id IN ('20260907_channels_outbound_sync','20260910_channels_outbound_reservation_settlements')
         ORDER BY migration_id`,
      ),
    ).toMatchObject({
      rows: [
        { migration_id: "20260907_channels_outbound_sync" },
        { migration_id: "20260910_channels_outbound_reservation_settlements" },
      ],
    });
    await pools.channels.query(
      `INSERT INTO channel_connections
       (connection_id,account_id,provider_key,environment,status,created_at,created_at_instant,bindings,projection_updated_at,last_stream_version)
       VALUES ('connection-upgrade','account-upgrade','tcgplayer','sandbox','active',now(),now(),'[]'::jsonb,now(),1)`,
    );
    const runtime = createOutboundSyncRuntime(
      {
        db: pools.channels,
        recordOutcome: async () => "applied",
        readAdditionalOutboundHold: async () => ({ held: false, sources: [] }),
      },
      { assertDelistDirective: () => undefined },
    );
    await runtime.enqueueDesiredState(desiredState());
    const reservation = await runtime.reserveClaimedOutboundOperations({
      registry: channelProviderRegistry,
      connectionId: "connection-upgrade",
      claimant: { claimantKind: "connector", claimantId: "connector-upgrade" },
      maxOperations: 1,
      leaseMs: 60_000,
    });
    const operation = reservation?.operations[0];
    if (!reservation || !operation) throw new Error("Upgrade reservation was unavailable.");
    const report = {
      reservationId: reservation.reservationId,
      claimant: reservation.claimant,
      outcomes: [
        {
          operationId: operation.operationId,
          attemptId: operation.attemptId,
          claimGeneration: operation.claimGeneration,
          desiredStateSequence: operation.desiredStateSequence,
          outcome: {
            kind: "applied" as const,
            result: { kind: "succeeded" as const, externalListingId: "synthetic:upgrade" },
          },
        },
      ],
    };
    await expect(runtime.reportClaimedOperationOutcomes(report)).resolves.toBeUndefined();
    await expect(runtime.reportClaimedOperationOutcomes(report)).resolves.toBeUndefined();
    expect(
      await pools.channels.query(
        "SELECT reservation_id FROM channel_outbound_reservation_settlements WHERE reservation_id=$1",
        [reservation.reservationId],
      ),
    ).toMatchObject({ rows: [{ reservation_id: reservation.reservationId }] });
  });

  it("keeps the current fresh schema and migration ledger inert across two boots", async () => {
    await bootstrapContextDatabase(channelsModule, pools.channels);
    const first = await migrationAndTableCounts();
    await bootstrapContextDatabase(channelsModule, pools.channels);
    expect(await migrationAndTableCounts()).toEqual(first);
    expect(first).toEqual({ migration: "1", table: "channel_outbound_reservation_settlements" });
  });

  it("upgrades a populated pending queue through the index migration with fresh-boot parity", async () => {
    const migrationId = "20260912_channels_outbound_pending_lane_order";
    const migration = outboundSyncSchemaMigrations.find((entry) => entry.migrationId === migrationId)!;
    const bootIndex = migration.statements[0]!.replace("CREATE INDEX CONCURRENTLY", "CREATE INDEX");
    const predecessor = {
      ...channelsModule,
      schemaSql: channelsModule.schemaSql.replace(`${bootIndex};`, ""),
      schemaMigrations: channelsModule.schemaMigrations!.filter((entry) => entry.migrationId !== migrationId),
    };
    await bootstrapContextDatabase(predecessor, pools.channels);
    expect(await pendingLaneIndex()).toEqual([]);
    await pools.channels.query(
      `INSERT INTO channel_connections
       (connection_id,account_id,provider_key,environment,status,created_at,created_at_instant,bindings,projection_updated_at,last_stream_version)
       VALUES ('connection-upgrade','account-upgrade','tcgplayer','sandbox','active',now(),now(),'[]'::jsonb,now(),1)`,
    );
    const runtime = createOutboundSyncRuntime(
      {
        db: pools.channels,
        recordOutcome: async () => "applied",
        readAdditionalOutboundHold: async () => ({ held: false, sources: [] }),
      },
      { assertDelistDirective: () => undefined },
    );
    await runtime.enqueueDesiredState(desiredState());
    const before = await pools.channels.query("SELECT * FROM channel_outbound_operations ORDER BY operation_id");
    expect(before.rows).toHaveLength(1);

    // Omit boot DDL so only the real ledgered migration can supply the missing index.
    await bootstrapContextDatabase({ ...channelsModule, schemaSql: "" }, pools.channels);
    const upgradedIndex = await pendingLaneIndex();
    expect(upgradedIndex).toHaveLength(1);
    expect(upgradedIndex[0]).toMatchObject({ indisvalid: true, indisready: true });
    expect(
      (await pools.channels.query("SELECT * FROM channel_outbound_operations ORDER BY operation_id")).rows,
    ).toEqual(before.rows);
    expect(
      (
        await pools.channels.query("SELECT migration_id FROM bounded_context_schema_migrations WHERE migration_id=$1", [
          migrationId,
        ])
      ).rows,
    ).toEqual([{ migration_id: migrationId }]);
    const reservation = await runtime.reserveClaimedOutboundOperations({
      registry: channelProviderRegistry,
      connectionId: "connection-upgrade",
      claimant: { claimantKind: "connector", claimantId: "synthetic-index-upgrade" },
      maxOperations: 1,
      leaseMs: 60_000,
    });
    expect(reservation?.operations).toHaveLength(1);
    expect(reservation?.operations[0]?.operationId).toBe(before.rows[0]!.operation_id);
    await bootstrapContextDatabase(channelsModule, pools.channels);
    expect(await pendingLaneIndex()).toEqual(upgradedIndex);

    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(channelsModule, pools.channels);
    expect(await pendingLaneIndex()).toEqual(upgradedIndex);
  });
});

async function pendingLaneIndex() {
  const result = await pools.channels.query(
    `SELECT pg_get_indexdef(indexrelid) AS definition, indisvalid, indisready
     FROM pg_index WHERE indexrelid=to_regclass('channel_outbound_operations_pending_lane_order_idx')`,
  );
  return result.rows;
}

// Verbatim schema.ts from last-good staging/production deploy 34804634571,
// commit 6652ce6b60570e753b0a2c36eccc32444a5855e4, blob dde5c7b46193df8d421e7ad552609a8d9ef370a4.
async function retainLastGoodOutboundSchema() {
  await bootstrapContextDatabase(
    { contextName: "channels", schemaSql: predecessorSchemaSql, schemaMigrations: predecessorMigrations },
    pools.channels,
  );
  await seedRetainedOutboundRows();
}

async function seedRetainedOutboundRows() {
  await pools.channels.query(`INSERT INTO channel_outbound_operations (
    operation_id, connection_id, channel_listing_id, listing_id, operation_kind,
    listing_revision, source_desired_state_sequence, payload, payload_digest, status,
    revision, attempt_id, claim_generation, claimant_kind, claim_owner_id, reservation_id,
    claimed_until, attempt_count, next_attempt_at, source_event_id, source_stream_id,
    source_stream_version, source_global_position, source_desired_state_hash, source_occurred_at,
    enqueued_at, first_claimed_at, terminal_at
  ) SELECT 'retained-' || status, 'retained-connection', 'retained-link-' || status,
    'retained-listing', 'update', 1, 1, '{"retained":true}'::jsonb, repeat('a',64), status,
    7, CASE WHEN status='in-flight' THEN 'retained-attempt' END, 3,
    CASE WHEN status='in-flight' THEN 'connector' END,
    CASE WHEN status='in-flight' THEN 'retained-owner' END,
    CASE WHEN status='in-flight' THEN 'retained-reservation' END,
    CASE WHEN status='in-flight' THEN '2099-01-01'::timestamptz END,
    2, '2026-09-10'::timestamptz, 'retained-event-' || status, 'retained-stream-' || status,
    1, 9, repeat('b',64), '2026-09-10'::timestamptz, '2026-09-10'::timestamptz,
    CASE WHEN status='in-flight' THEN '2026-09-10'::timestamptz END,
    CASE WHEN status IN ('succeeded','failed') THEN '2026-09-10'::timestamptz END
    FROM unnest(ARRAY['pending','in-flight','succeeded','failed']) AS status`);
  await pools.channels.query(`INSERT INTO channel_outbound_lanes
    (connection_id, channel_listing_id, generation, blocked_operation_id, blocked_reason, blocked_at, revision)
    VALUES ('retained-connection','retained-link-failed',4,'retained-failed','retained-poison','2026-09-10',8)`);
  await pools.channels.query(`INSERT INTO channel_provider_rate_state
    (provider_key, environment, window_started_at, request_count, adaptive_divisor, revision)
    VALUES ('synthetic-retained','sandbox','2026-09-10',2,4,9)`);
  await pools.channels.query(`INSERT INTO channel_outbound_reservation_settlements
    (reservation_id, claimant, outcomes, run_settlement, settled_at)
    VALUES ('retained-settled','{"claimantId":"retained-owner"}', '[]', '{"retained":true}', '2026-09-10')`);
}

async function outboundRows() {
  const tables = [
    "channel_outbound_operations",
    "channel_outbound_lanes",
    "channel_provider_rate_state",
    "channel_outbound_reservation_settlements",
  ] as const;
  const rows: Record<string, Record<string, unknown>[]> = {};
  for (const table of tables) rows[table] = (await pools.channels.query(`SELECT * FROM ${table} ORDER BY 1,2`)).rows;
  return rows as Record<(typeof tables)[number], Record<string, unknown>[]>;
}

async function outboundLedger() {
  return (
    await pools.channels.query<{ migration_id: string; description: string; applied_at: Date }>(
      "SELECT * FROM bounded_context_schema_migrations WHERE migration_id = ANY($1::text[]) ORDER BY migration_id",
      [outboundSyncSchemaMigrations.map((entry) => entry.migrationId)],
    )
  ).rows;
}

async function outboundIndexes() {
  return (
    await pools.channels.query(
      `SELECT indexrelid::text AS oid, indexrelid::regclass::text AS name,
       pg_get_indexdef(indexrelid) AS definition, pg_get_expr(indpred,indrelid) AS predicate, indisvalid, indisready
     FROM pg_index WHERE indrelid='channel_outbound_operations'::regclass AND NOT indisprimary ORDER BY name`,
    )
  ).rows;
}

async function outboundShape() {
  const columns = await pools.channels.query(`SELECT table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns WHERE table_schema='public'
      AND table_name IN ('channel_outbound_operations','channel_outbound_lanes',
        'channel_provider_rate_state','channel_outbound_reservation_settlements') ORDER BY table_name,column_name`);
  const constraints = await pools.channels.query(`SELECT conrelid::regclass::text AS table_name,
    conname, pg_get_constraintdef(oid) AS definition, convalidated FROM pg_constraint
    WHERE conrelid IN ('channel_outbound_operations'::regclass,'channel_outbound_lanes'::regclass,
      'channel_provider_rate_state'::regclass,'channel_outbound_reservation_settlements'::regclass)
    ORDER BY table_name,conname`);
  const indexes = (await outboundIndexes()).map(({ oid: _oid, ...index }) => index);
  return { columns: columns.rows, constraints: constraints.rows, indexes };
}

async function assertOutboundGuards() {
  const clone = (source: string, overrides: Record<string, unknown>) =>
    pools.channels.query(
      `INSERT INTO channel_outbound_operations SELECT
       (jsonb_populate_record(NULL::channel_outbound_operations, to_jsonb(o) || $2::jsonb)).*
     FROM channel_outbound_operations o WHERE operation_id=$1`,
      [source, JSON.stringify(overrides)],
    );
  await expect(
    clone("retained-pending", {
      operation_id: "duplicate-event",
      channel_listing_id: "other-link",
    }),
  ).rejects.toMatchObject({ code: "23505", constraint: "channel_outbound_operations_source_event_uidx" });
  await expect(
    clone("retained-pending", {
      operation_id: "duplicate-pending",
      source_event_id: "other-event",
    }),
  ).rejects.toMatchObject({ code: "23505", constraint: "channel_outbound_operations_one_pending_per_lane_uidx" });
  for (const origin of ["desired-state", "repush", "reconciliation-repair"]) {
    await expect(
      clone("retained-in-flight", {
        operation_id: `duplicate-flight-${origin}`,
        source_event_id: `flight-event-${origin}`,
        operation_origin: origin,
      }),
    ).rejects.toMatchObject({ code: "23505", constraint: "channel_outbound_operations_one_inflight_per_lane_uidx" });
  }
  for (const origin of ["repush", "reconciliation-repair"]) {
    await expect(
      clone("retained-pending", {
        operation_id: `retained-${origin}`,
        operation_origin: origin,
      }),
    ).resolves.toMatchObject({ rowCount: 1 });
  }
  await expect(
    clone("retained-pending", {
      operation_id: "invalid-origin",
      source_event_id: "invalid-event",
      channel_listing_id: "invalid-link",
      operation_origin: "invalid",
    }),
  ).rejects.toMatchObject({ code: "23514", constraint: "channel_outbound_operations_operation_origin_check" });
}

function desiredState() {
  return {
    connectionId: "connection-upgrade",
    channelListingId: "channel-listing-upgrade",
    listingId: "listing-upgrade",
    operationKind: "update" as const,
    listingRevision: 1,
    desiredStateSequence: 1,
    desiredStateHash: "a".repeat(64),
    payload: {
      kind: "draft" as const,
      draft: {
        channelListingId: "channel-listing-upgrade",
        listingRevision: 1,
        title: "synthetic upgrade",
        description: "synthetic upgrade",
        categoryKey: "synthetic",
        conditionKey: "synthetic",
        price: { amountMinor: 100, currency: "USD" },
        quantity: 1,
        attributes: [],
      },
    },
    envelope: {
      sourceEventId: "event-upgrade",
      sourceStreamId: "channels.channel-listing-channel-listing-upgrade",
      sourceStreamVersion: 1,
      sourceGlobalPosition: parseGlobalPosition("1"),
      sourceOccurredAt: "2026-09-10T00:00:00Z",
    },
  };
}

async function migrationAndTableCounts() {
  const result = await pools.channels.query<{ migration: string; table_name: string | null }>(
    `SELECT
       (SELECT count(*)::text FROM bounded_context_schema_migrations
        WHERE migration_id='20260910_channels_outbound_reservation_settlements') AS migration,
       to_regclass('channel_outbound_reservation_settlements')::text AS table_name`,
  );
  const row = result.rows[0];
  if (!row) throw new Error("Migration evidence was unavailable.");
  return { migration: row.migration, table: row.table_name };
}
