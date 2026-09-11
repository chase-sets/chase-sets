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
      { db: pools.channels, recordOutcome: async () => "applied" },
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
});

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
