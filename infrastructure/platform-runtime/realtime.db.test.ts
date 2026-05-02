import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import {
  pruneExpiredRealtimePatchesWithAdvisoryLock,
  readRealtimePatches,
  recordRealtimeProjectionPatch,
  realtimeOutboxSchemaSql,
} from "./realtime";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
const maybeDescribe = adminDatabaseUrl ? describe : describe.skip;

maybeDescribe("realtime outbox Postgres integration", () => {
  let pools: Readonly<Record<"realtime", PgTransactionalPool>>;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      adminDatabaseUrl!,
      ["realtime"],
      "platform_realtime",
    );
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.realtime.query(realtimeOutboxSchemaSql);
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  it("records idempotent patches, indexes topics, and replays in outbox order", async () => {
    await recordRealtimeProjectionPatch(pools.realtime, {
      sourceGlobalPosition: "1",
      projectionName: "discovery-market-projection",
      patchKey: "listing:list_1",
      topics: ["public:market", "listing:list_1"],
      recordedAt: "2026-05-02T00:00:00.000Z",
      patch: {
        kind: "projection.patch",
        context: "discovery",
        projection: "discovery-market-projection",
        topics: ["listing:list_1", "public:market"],
        changes: [
          {
            op: "upsert",
            entity: "discovery.marketListing",
            id: "list_1",
            value: { listing_id: "list_1", status: "active" },
          },
        ],
      },
    });
    await recordRealtimeProjectionPatch(pools.realtime, {
      sourceGlobalPosition: "1",
      projectionName: "discovery-market-projection",
      patchKey: "listing:list_1",
      topics: ["listing:list_1"],
      recordedAt: "2026-05-02T00:00:01.000Z",
      patch: {
        kind: "projection.patch",
        context: "discovery",
        projection: "discovery-market-projection",
        topics: ["listing:list_1"],
        changes: [
          {
            op: "summary",
            entity: "discovery.marketSummary",
            id: "item_1",
            value: { active_listing_count: 1 },
          },
        ],
      },
    });
    await recordRealtimeProjectionPatch(pools.realtime, {
      sourceGlobalPosition: "2",
      projectionName: "discovery-market-projection",
      patchKey: "listing:list_2",
      topics: ["listing:list_2"],
      recordedAt: "2026-05-02T00:00:02.000Z",
      patch: {
        kind: "projection.patch",
        context: "discovery",
        projection: "discovery-market-projection",
        topics: ["listing:list_2"],
        changes: [
          {
            op: "remove",
            entity: "discovery.marketListing",
            id: "list_2",
          },
        ],
      },
    });

    const topics = await pools.realtime.query<{ topic: string }>(
      `SELECT topic
       FROM realtime_projection_outbox_topics
       ORDER BY topic`,
    );
    expect(topics.rows.map((row) => row.topic)).toEqual([
      "listing:list_1",
      "listing:list_2",
    ]);
    const heads = await pools.realtime.query<{ topic: string; outbox_id: string }>(
      `SELECT topic, outbox_id::text
       FROM realtime_projection_topic_heads
       ORDER BY topic`,
    );
    expect(heads.rows).toEqual([
      { topic: "listing:list_1", outbox_id: "1" },
      { topic: "listing:list_2", outbox_id: "3" },
    ]);

    const replay = await readRealtimePatches(
      [{ contextName: "discovery", db: pools.realtime }],
      ["listing:list_1", "listing:list_2"],
      {},
      10,
      { pruneExpired: false },
    );

    expect(replay.expiredContexts).toEqual([]);
    expect(replay.messages.map((message) => message.outboxId)).toEqual(["1", "3"]);
    expect(replay.cursor).toEqual({ discovery: "3" });
    expect(replay.messages.map((message) => message.payload.changes[0].op)).toEqual([
      "summary",
      "remove",
    ]);
  });

  it("prunes expired rows and cascades topic index rows", async () => {
    await recordRealtimeProjectionPatch(pools.realtime, {
      sourceGlobalPosition: "1",
      projectionName: "discovery-market-projection",
      patchKey: "listing:list_1",
      topics: ["listing:list_1"],
      recordedAt: "2020-01-01T00:00:00.000Z",
      retentionMs: 1,
      patch: {
        kind: "projection.patch",
        context: "discovery",
        projection: "discovery-market-projection",
        topics: ["listing:list_1"],
        changes: [
          {
            op: "remove",
            entity: "discovery.marketListing",
            id: "list_1",
          },
        ],
      },
    });

    await expect(
      pruneExpiredRealtimePatchesWithAdvisoryLock(pools.realtime, "433"),
    ).resolves.toBe(1);

    const remaining = await pools.realtime.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM realtime_projection_outbox_topics`,
    );
    expect(remaining.rows[0]?.count).toBe("0");
    const remainingHeads = await pools.realtime.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM realtime_projection_topic_heads`,
    );
    expect(remainingHeads.rows[0]?.count).toBe("0");
  });
});
