import { afterAll, beforeAll, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createInventoryExternalChannelSaleRecorderForPool } from "@chase-sets/inventory/server";
import { module as channelsModule } from "../../../index";
import { context, describeDb } from "../../connection-health/tests/test-support";
import { healthDigest } from "../../connection-health/domain/identity";
import { writeHealthSnapshot } from "../../connection-health/read-model/store";
import { decodeChannelAttentionFact } from "../domain/codecs";
import { channelAttentionSchemaSql, channelAttentionSchemaMigrations } from "../read-model/schema";

describeDb("channel-attention boot and ledgered migration", () => {
  let pools: Readonly<Record<"channels" | "inventory", PgTransactionalPool>>;
  beforeAll(async () => {
    const base = process.env.TEST_DATABASE_URL!;
    const urls = createMultiContextTestDatabaseUrls(base, ["channels", "inventory"], "attention_upgrade");
    await ensureMultiContextTestDatabases(base, urls);
    pools = createMultiContextTestPools(urls);
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });
  it("upgrades the predecessor boot/ledger and preserves rows across repeated boots", async () => {
    const migrationId = channelAttentionSchemaMigrations[0].migrationId;
    const previous = {
      ...channelsModule,
      schemaSql: channelsModule.schemaSql.replace(channelAttentionSchemaSql, ""),
      schemaMigrations: (channelsModule.schemaMigrations ?? []).filter(
        (migration) => migration.migrationId !== migrationId,
      ),
    };
    await bootstrapContextDatabase(previous, pools.channels);
    expect(
      (await pools.channels.query("SELECT to_regclass('channel_connection_attention')::text AS name")).rows,
    ).toEqual([{ name: null }]);
    const services = channelsModule.createServices(pools.channels, {
      channelSaleRecorder: createInventoryExternalChannelSaleRecorderForPool(pools.inventory, context),
    });
    const connection = { connectionId: "synthetic-predecessor-open", accountId: context.audit.forAccountId };
    await services.connections.connectChannel(
      { ...connection, providerKey: "tcgplayer" },
      { deploymentEnvironment: "test" },
      context,
    );
    const health = (await services.connectionHealth.readConnectionHealth(connection)).health;
    const opening = {
      sourceWorkId: healthDigest("synthetic-predecessor-work"),
      sourceAttempt: 1,
      occurredAt: "2026-09-13T00:00:00Z",
    };
    const reason = {
      reasonCode: "polling" as const,
      generation: 1,
      fingerprint: healthDigest("synthetic-predecessor-fingerprint"),
      state: "degraded" as const,
      consecutiveFailures: 1,
      trailingFailures: 1,
      opening,
      lastOccurredAt: opening.occurredAt,
    };
    expect(
      await writeHealthSnapshot(pools.channels, connection.connectionId, health, {
        ...health,
        state: "degraded",
        reasons: [reason],
        observedAt: opening.occurredAt,
      }),
    ).toBe(1);
    await pools.channels.query(
      `INSERT INTO channel_sync_runs
      (run_id,revision,sequence,connection_id,provider_key,reservation_id,claimant_kind,claimant_id,lease_expires_at,
       manual_claim_lease_policy_snapshot,state,basis_snapshot_id,basis_snapshot_generation,csv_header,member_count,member_digest,created_at,updated_at,last_stream_version)
      VALUES ('synthetic-upgrade-manual',1,1,$1,'tcgplayer','synthetic-reservation','manual','synthetic-manual',
        '2027-01-01T00:00:00Z','{}','composed','synthetic-basis',1,'[]',1,$2,'2026-09-01T00:00:00Z','2026-09-01T00:00:00Z',1)`,
      [connection.connectionId, "a".repeat(64)],
    );
    const independentState = async () => ({
      manual: (await pools.channels.query("SELECT * FROM channel_sync_runs ORDER BY run_id")).rows,
      clamp: (await pools.channels.query("SELECT * FROM channels_manual_sync_clamp_status ORDER BY run_id")).rows,
      crossContext: (
        await pools.channels.query(
          "SELECT * FROM event_store_events WHERE event_type ~ '^(inventory|ordering|fulfillment|payments)\\.' ORDER BY global_position",
        )
      ).rows,
    });
    const before = await independentState();
    await bootstrapContextDatabase(channelsModule, pools.channels);
    expect((await pools.channels.query("SELECT * FROM channel_connection_attention")).rows).toEqual([]);
    const success = {
      schemaVersion: "ChannelHealthObservation/v1" as const,
      connectionId: connection.connectionId,
      reasonCode: reason.reasonCode,
      sourceKind: "polling" as const,
      sourceWorkId: opening.sourceWorkId,
      sourceAttempt: 2,
      resultOrdinal: 1,
      policyRevision: health.policyRevision,
      evaluationGeneration: health.evaluationGeneration,
      fingerprint: reason.fingerprint,
      outcome: "success" as const,
      occurredAt: "2026-09-13T00:01:00Z",
    };
    expect((await services.connectionHealth.submitObservation(success, context)).outcome).toBe("accepted");
    expect((await services.connectionHealth.submitObservation(success, context)).outcome).toBe("replayed");
    const facts = (
      await pools.channels.query<{ event_type: string; payload: unknown }>(
        "SELECT event_type,payload FROM event_store_events WHERE stream_id=$1 ORDER BY stream_version",
        [`channels.connection-attention-${connection.connectionId}`],
      )
    ).rows;
    expect(facts.map((fact) => fact.event_type)).toEqual([
      "channels.connection.attention-opened",
      "channels.connection.attention-resolved",
    ]);
    expect(facts.map((fact) => decodeChannelAttentionFact(fact.payload))).toEqual([
      {
        schemaVersion: "ChannelAttentionOpened/v1",
        connection,
        reasonCode: reason.reasonCode,
        generation: 1,
        resolutionReason: null,
        openedAt: opening.occurredAt,
        resolvedAt: null,
      },
      {
        schemaVersion: "ChannelAttentionResolved/v1",
        connection,
        reasonCode: reason.reasonCode,
        generation: 1,
        resolutionReason: "recovered-automatically",
        openedAt: opening.occurredAt,
        resolvedAt: success.occurredAt,
      },
    ]);
    expect(
      (
        await pools.channels.query(
          "SELECT connection_id,reason_generation::text,resolution_reason,resolved_at FROM channel_connection_attention",
        )
      ).rows,
    ).toEqual([
      {
        connection_id: connection.connectionId,
        reason_generation: "1",
        resolution_reason: "recovered-automatically",
        resolved_at: new Date(success.occurredAt),
      },
    ]);
    expect(await independentState()).toEqual(before);
    await pools.channels.query(
      `INSERT INTO channel_connection_attention (connection_id,account_id,reason_code,reason_generation,fingerprint,opened_at) VALUES ('synthetic-upgrade','acc_synthetic','polling',1,$1,'2026-09-13T00:00:00Z')`,
      ["a".repeat(64)],
    );
    await bootstrapContextDatabase(channelsModule, pools.channels);
    expect(
      (await pools.channels.query("SELECT count(*)::text AS count FROM channel_connection_attention")).rows,
    ).toEqual([{ count: "2" }]);
    expect(
      (
        await pools.channels.query("SELECT migration_id FROM bounded_context_schema_migrations WHERE migration_id=$1", [
          migrationId,
        ])
      ).rows,
    ).toEqual([{ migration_id: migrationId }]);
    expect(
      (
        await pools.channels.query(
          "SELECT indexname FROM pg_indexes WHERE indexname IN ('channel_connection_attention_account_idx','channel_connection_health_account_attention_idx') ORDER BY indexname",
        )
      ).rows,
    ).toHaveLength(2);
  });
});
