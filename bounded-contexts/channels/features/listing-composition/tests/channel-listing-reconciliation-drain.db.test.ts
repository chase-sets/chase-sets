import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as channelsModule } from "../../../index";
import { createChannelListingCompositionRuntime, type ChannelListingCompositionServices } from "../api/runtime";
import { createChannelCompositionProfileRegistry } from "../domain/canonical";
import { testContext } from "../../connections/tests/test-support";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for Channels DB tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
let pools: Readonly<Record<"channels", PgTransactionalPool>>;
let services: ChannelListingCompositionServices;

describeDb("channel-listing-reconciliation-drain", () => {
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["channels"], "channel_listing_reconciliation");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(channelsModule, pools.channels);
    await seedListings(pools.channels, ["listing-1", "listing-2", "listing-3", "listing-4", "listing-5"]);
    services = createChannelListingCompositionRuntime({
      db: pools.channels,
      eventStore: createPostgresEventStore({ pool: pools.channels }),
      profiles: createChannelCompositionProfileRegistry(),
    });
  });
  afterAll(async () => closeMultiContextTestPools(pools));

  it("drains three pages at limit two and reconciles the independent completion count", async () => {
    const runId = await enqueue();
    await drain(runId, 3);
    const events = await runEvents(runId);
    expect(events.map((event) => event.event_type)).toEqual([
      "channels.channel-listing-reconciliation.run-enqueued",
      "channels.channel-listing-reconciliation.chunk-drained",
      "channels.channel-listing-reconciliation.chunk-drained",
      "channels.channel-listing-reconciliation.run-settled",
    ]);
    expect(events[1]!.payload).toMatchObject({
      fromCursor: null,
      toCursor: "listing-2",
      processedCount: 2,
      remaining: true,
    });
    expect(events[2]!.payload).toMatchObject({
      fromCursor: "listing-2",
      toCursor: "listing-4",
      processedCount: 2,
      remaining: true,
    });
    expect(events[3]!.payload).toMatchObject({ outcome: { kind: "complete", processedCount: 5 } });
    expect(await linkEventCount()).toBe(5);
  });

  it("rewinds after a mid-drain lower-key listing and loses no changes", async () => {
    const runId = await enqueue();
    await projectLiveRun(runId);
    await services.drainChannelListingDesiredStateReconciliation({ runId, limit: 2 }, testContext);
    await seedListings(pools.channels, ["listing-0"]);
    await services.enqueueChannelListingDesiredStateReconciliation(
      {
        connectionId: "connection-synthetic",
        scope: "connection",
        scopeKey: "connection-synthetic",
      },
      testContext,
    );
    await services.drainChannelListingDesiredStateReconciliation({ runId, limit: 2 }, testContext);
    await drainUntilSettled(runId);
    const events = await runEvents(runId);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: "channels.channel-listing-reconciliation.chunk-drained",
          payload: expect.objectContaining({ toCursor: null, processedCount: 0, remaining: true }),
        }),
        expect.objectContaining({
          event_type: "channels.channel-listing-reconciliation.run-settled",
          payload: expect.objectContaining({ outcome: { kind: "complete", processedCount: 6 } }),
        }),
      ]),
    );
    expect(await linkEventCount()).toBe(6);
  });

  it("settles failed when the independently counted affected set no longer matches processed count", async () => {
    const runId = await enqueue();
    await services.drainChannelListingDesiredStateReconciliation({ runId, limit: 2 }, testContext);
    await pools.channels.query(`DELETE FROM channels_listing_publication_facts WHERE listing_id='listing-1'`);
    await drainUntilSettled(runId);
    const events = await runEvents(runId);
    expect(events.at(-1)?.payload).toMatchObject({ outcome: { kind: "failed", code: "affected-count-mismatch" } });
  });

  async function enqueue(): Promise<string> {
    const result = await services.enqueueChannelListingDesiredStateBackfill(
      { connectionId: "connection-synthetic" },
      testContext,
    );
    if (result.kind === "refused") throw new Error("Expected reconciliation run.");
    return result.value.runId;
  }
  async function drain(runId: string, calls: number): Promise<void> {
    for (let index = 0; index < calls; index += 1) {
      await services.drainChannelListingDesiredStateReconciliation({ runId, limit: 2 }, testContext);
    }
  }
  async function drainUntilSettled(runId: string): Promise<void> {
    for (let index = 0; index < 10; index += 1) {
      const events = await runEvents(runId);
      if (events.at(-1)?.event_type === "channels.channel-listing-reconciliation.run-settled") return;
      await services.drainChannelListingDesiredStateReconciliation({ runId, limit: 2 }, testContext);
    }
    throw new Error("Reconciliation run did not settle.");
  }
  async function runEvents(runId: string) {
    return (
      await pools.channels.query<{ event_type: string; payload: Record<string, unknown> }>(
        `SELECT event_type,payload FROM event_store_events WHERE stream_id=$1 ORDER BY stream_version`,
        [`channels.channel-listing-reconciliation-${runId}`],
      )
    ).rows;
  }
  async function linkEventCount(): Promise<number> {
    const result = await pools.channels.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM event_store_events WHERE event_type='channels.channel-listing.publication-blocked'`,
    );
    return Number(result.rows[0]?.count ?? 0);
  }
  async function projectLiveRun(runId: string): Promise<void> {
    await pools.channels.query(
      `INSERT INTO channels_listing_reconciliation_runs
       (run_id,connection_id,scope,scope_key,cursor_listing_id,restart_required,processed_count,state,failure_code,attempt_count,updated_at,last_stream_version)
       VALUES ($1,'connection-synthetic','connection','connection-synthetic',NULL,false,0,'pending',NULL,0,now(),1)`,
      [runId],
    );
  }
});

async function seedListings(db: PgTransactionalPool, listingIds: readonly string[]): Promise<void> {
  await db.query(
    `INSERT INTO channels_connection_facts
       (connection_id,account_id,provider_key,environment,status,updated_at,connection_stream_version)
     VALUES ('connection-synthetic','account-synthetic','synthetic-provider','sandbox','active',now(),1)
     ON CONFLICT (connection_id) DO NOTHING`,
  );
  for (const listingId of listingIds) {
    await db.query(
      `INSERT INTO channels_listing_publication_facts
       (listing_id,account_id,inventory_item_id,catalog_item_id,price_amount,price_currency_code,quantity_cap,
        selected_options,selected_option_key,listing_status,pause_reason,item_title,item_subtitle,product_summary,graded_card,
        updated_at,listing_stream_version)
       VALUES ($1,'account-synthetic',$2,$3,'20.00','USD',1,'[]'::jsonb,'','active',NULL,'Synthetic',NULL,NULL,NULL,now(),1)`,
      [listingId, `item-${listingId}`, `catalog-${listingId}`],
    );
  }
}
