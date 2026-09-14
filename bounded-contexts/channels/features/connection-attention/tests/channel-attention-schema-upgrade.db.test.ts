import { afterAll, beforeAll, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as channelsModule } from "../../../index";
import { describeDb } from "../../connection-health/tests/test-support";
import { channelAttentionSchemaSql, channelAttentionSchemaMigrations } from "../read-model/schema";

describeDb("channel-attention boot and ledgered migration", () => {
  let pools: Readonly<Record<"channels", PgTransactionalPool>>;
  beforeAll(async () => {
    const base = process.env.TEST_DATABASE_URL!;
    const urls = createMultiContextTestDatabaseUrls(base, ["channels"], "attention_upgrade");
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
    await bootstrapContextDatabase(channelsModule, pools.channels);
    await pools.channels.query(
      `INSERT INTO channel_connection_attention (connection_id,account_id,reason_code,reason_generation,fingerprint,opened_at) VALUES ('synthetic-upgrade','acc_synthetic','polling',1,$1,'2026-09-13T00:00:00Z')`,
      ["a".repeat(64)],
    );
    await bootstrapContextDatabase(channelsModule, pools.channels);
    expect(
      (await pools.channels.query("SELECT count(*)::text AS count FROM channel_connection_attention")).rows,
    ).toEqual([{ count: "1" }]);
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
