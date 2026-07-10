import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";
import {
  coalesceRealtimeProjectionPatchInputs,
  compactRealtimeReplayMessages,
  createRealtimeOutboxWakeSignal,
  createPostgresRealtimeStreamLimiter,
  createRealtimeOutboxPartitionName,
  createRealtimeOutboxPartitionMaintainer,
  createRealtimeRoutes,
  createRealtimeRetentionSweeper,
  createRedisRealtimeStreamLimiter,
  createRealtimeStatusSnapshot,
  pruneExpiredRealtimePatchesWithAdvisoryLock,
  readRealtimePatches,
  recordRealtimeProjectionPatch,
  recordRealtimeProjectionPatches,
  realtimeProjectionNotifyChannel,
  realtimeOutboxPartitionMaintenanceSql,
  realtimeOutboxSchemaSql,
  resolveRealtimeRouteConfig,
  runRealtimeProjectionTransaction,
} from "./realtime";
import { createRealtimeReadHub } from "./realtime-read-hub";
import {
  createWorkSignalEnvelope,
  parseWorkSignalEnvelope,
  serializeWorkSignalEnvelope,
} from "./work-signal-composite";

describe("realtime outbox", () => {
  it("defines a durable topic index for scalable replay", () => {
    expect(realtimeOutboxSchemaSql).toContain("realtime_projection_outbox_topics");
    expect(realtimeOutboxSchemaSql).toContain("PRIMARY KEY (topic, outbox_id)");
    expect(realtimeOutboxSchemaSql).toContain("ON DELETE CASCADE");
    expect(realtimeOutboxSchemaSql).toContain("realtime_projection_topic_heads");
    expect(realtimeOutboxSchemaSql).toContain("payload_json text NOT NULL");
    expect(realtimeOutboxSchemaSql).not.toContain("payload jsonb NOT NULL");
    expect(realtimeOutboxSchemaSql).toContain("payload_context text NOT NULL");
    expect(realtimeOutboxSchemaSql).toContain("payload_projection text NOT NULL");
    expect(realtimeOutboxSchemaSql).toContain("payload_kind text NOT NULL");
    expect(realtimeOutboxSchemaSql).toContain("payload_bytes integer NOT NULL");
    expect(realtimeOutboxSchemaSql).toContain("realtime_projection_outbox_retention");
    expect(realtimeOutboxSchemaSql).toContain("pruned_through_outbox_id bigint NOT NULL DEFAULT 0");
  });

  it("exposes partition maintenance metadata for time-bucketed outbox retention", () => {
    expect(realtimeOutboxPartitionMaintenanceSql).toContain("realtime_projection_outbox_partitions");
    expect(createRealtimeOutboxPartitionName("2026_05_02")).toBe("realtime_projection_outbox_2026_05_02");
    expect(() => createRealtimeOutboxPartitionName("2026-05-02")).toThrow("YYYY_MM_DD");
  });

  it("maintains outbox partition metadata windows", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const db = {
      query: async (sql: string, params?: readonly unknown[]) => {
        calls.push({ sql, params });
        return { rows: [] };
      },
    };
    const maintainer = createRealtimeOutboxPartitionMaintainer({
      db,
      aheadDays: 1,
      retentionDays: 1,
      intervalMs: 60_000,
      now: () => new Date("2026-05-02T12:00:00.000Z"),
    });

    await maintainer.maintain();
    maintainer.stop();

    expect(calls[0].sql).toContain("realtime_projection_outbox_partitions");
    expect(calls[1].params).toEqual([
      "realtime_projection_outbox_2026_05_02",
      "2026-05-02T00:00:00.000Z",
      "2026-05-03T00:00:00.000Z",
    ]);
    expect(calls[2].params).toEqual([
      "realtime_projection_outbox_2026_05_03",
      "2026-05-03T00:00:00.000Z",
      "2026-05-04T00:00:00.000Z",
    ]);
    expect(calls[3].sql).toContain("SET dropped_at");
  });

  it("reports outbox partition maintenance failures without rejecting", async () => {
    const error = new Error("connection timeout");
    const errors: unknown[] = [];
    const maintainer = createRealtimeOutboxPartitionMaintainer({
      db: {
        query: async () => {
          throw error;
        },
      },
      intervalMs: 60_000,
      onError: (reportedError) => {
        errors.push(reportedError);
      },
    });

    await expect(maintainer.maintain()).resolves.toBeUndefined();
    maintainer.stop();

    expect(errors).toEqual([error]);
  });

  it("records idempotent projection patches with a retention cutoff", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const db = {
      query: async (sql: string, params?: readonly unknown[]) => {
        calls.push({ sql, params });
        if (sql.includes("INSERT INTO realtime_projection_outbox")) {
          return { rows: [{ outbox_id: "42" }] };
        }

        return { rows: [] };
      },
    };

    await recordRealtimeProjectionPatch(db, {
      sourceGlobalPosition: "12",
      projectionName: "discovery-market",
      patchKey: "listing:list_1",
      topics: ["public:market", "listing:list_1", "public:market"],
      recordedAt: "2026-04-28T00:00:00.000Z",
      retentionMs: 1_000,
      patch: {
        kind: "projection.patch",
        context: "discovery",
        projection: "discovery-market",
        topics: ["listing:list_1", "public:market", "listing:list_1"],
        changes: [
          {
            op: "remove",
            entity: "discovery.listing",
            id: "list_1",
          },
        ],
      },
    });

    expect(calls[0].sql).toContain("pg_advisory_xact_lock");
    expect(calls[1].sql).toContain("ON CONFLICT");
    expect(calls[1].sql).toContain("RETURNING outbox_id");
    expect(calls[1].params).toEqual([
      "12",
      "discovery-market",
      "listing:list_1",
      JSON.stringify(["listing:list_1", "public:market"]),
      JSON.stringify({
        kind: "projection.patch",
        context: "discovery",
        projection: "discovery-market",
        topics: ["listing:list_1", "public:market"],
        changes: [
          {
            op: "remove",
            entity: "discovery.listing",
            id: "list_1",
          },
        ],
      }),
      "2026-04-28T00:00:00.000Z",
      "2026-04-28T00:00:01.000Z",
      "projection.patch",
      "discovery",
      expect.any(Number),
    ]);
    expect(calls[2].sql).toContain("DELETE FROM realtime_projection_outbox_topics");
    expect(calls[2].params).toEqual(["42"]);
    expect(calls[3].sql).toContain("DELETE FROM realtime_projection_topic_heads");
    expect(calls[3].params).toEqual(["42", ["listing:list_1", "public:market"]]);
    expect(calls[4].sql).toContain("INSERT INTO realtime_projection_outbox_topics");
    expect(calls[4].params).toEqual(["42", ["listing:list_1", "public:market"]]);
    expect(calls[5].sql).toContain("INSERT INTO realtime_projection_topic_heads");
    expect(calls[5].params).toEqual(["42", ["listing:list_1", "public:market"], "2026-04-28T00:00:00.000Z"]);
    expect(calls[6].sql).toContain("pg_notify");
    expect(calls[6].params?.[0]).toBe(realtimeProjectionNotifyChannel);
    const wakeEnvelope = parseWorkSignalEnvelope(String(calls[6].params?.[1]));
    expect(wakeEnvelope).toMatchObject({
      schemaVersion: 1,
      payloadVersion: 1,
      kind: "realtime.outbox-wake",
      source: "realtime-outbox",
      payload: {
        context: "discovery",
        projection: "discovery-market",
        topics: ["listing:list_1", "public:market"],
      },
    });
  });

  it("rejects projection patch contract drift before writing", async () => {
    const db = {
      query: async () => {
        throw new Error("should not write invalid patch");
      },
    };

    await expect(
      recordRealtimeProjectionPatch(db, {
        sourceGlobalPosition: "12",
        projectionName: "discovery-market",
        patchKey: "listing:list_1",
        topics: ["public:market"],
        patch: {
          kind: "projection.patch",
          context: "discovery",
          projection: "other-projection",
          topics: ["public:market"],
          changes: [
            {
              op: "remove",
              entity: "discovery.listing",
              id: "list_1",
            },
          ],
        },
      }),
    ).rejects.toThrow("projection must match");
  });

  it("rejects projection patches that exceed change-count or payload guardrails", async () => {
    const db = {
      query: async () => {
        throw new Error("should not write oversized patch");
      },
    };
    const input = {
      sourceGlobalPosition: "12",
      projectionName: "discovery-market",
      patchKey: "listing:list_1",
      topics: ["public:market"],
      patch: {
        kind: "projection.patch" as const,
        context: "discovery",
        projection: "discovery-market",
        topics: ["public:market"],
        changes: [
          {
            op: "summary" as const,
            entity: "discovery.marketSummary",
            id: "item_1",
            value: { active_listing_count: 1 },
          },
        ],
      },
    };

    await expect(
      recordRealtimeProjectionPatch(db, {
        ...input,
        maxChangeCount: 0,
      }),
    ).rejects.toThrow("more than 0 changes");
    await expect(
      recordRealtimeProjectionPatch(db, {
        ...input,
        maxPayloadBytes: 1,
      }),
    ).rejects.toThrow("cannot exceed 1 bytes");
  });

  it("coalesces compatible outbox inputs before batch writing", () => {
    const [input] = coalesceRealtimeProjectionPatchInputs([
      {
        sourceGlobalPosition: "1",
        projectionName: "discovery-market",
        patchKey: "summary:item_1",
        topics: ["public:market"],
        patch: {
          kind: "projection.patch",
          context: "discovery",
          projection: "discovery-market",
          topics: ["public:market"],
          changes: [
            {
              op: "summary",
              entity: "discovery.marketSummary",
              id: "item_1",
              value: { active_listing_count: 1 },
            },
          ],
        },
      },
      {
        sourceGlobalPosition: "1",
        projectionName: "discovery-market",
        patchKey: "summary:item_1",
        topics: ["public:market"],
        patch: {
          kind: "projection.patch",
          context: "discovery",
          projection: "discovery-market",
          topics: ["public:market"],
          changes: [
            {
              op: "summary",
              entity: "discovery.marketSummary",
              id: "item_1",
              value: { active_listing_count: 2 },
            },
          ],
        },
      },
    ]);

    expect(input?.patch.changes).toEqual([
      {
        op: "summary",
        entity: "discovery.marketSummary",
        id: "item_1",
        value: { active_listing_count: 2 },
      },
    ]);
  });

  it("drops no-op coalesced outbox inputs", () => {
    expect(
      coalesceRealtimeProjectionPatchInputs([
        {
          sourceGlobalPosition: "1",
          projectionName: "discovery-market",
          patchKey: "empty",
          topics: ["public:market"],
          patch: {
            kind: "projection.patch",
            context: "discovery",
            projection: "discovery-market",
            topics: ["public:market"],
            changes: [],
          },
        },
      ]),
    ).toEqual([]);
  });

  it("replays retained patches in per-context outbox order for matching topics", async () => {
    const db = {
      query: async (sql: string, params?: readonly unknown[]) => {
        if (sql.includes("DELETE FROM realtime_projection_outbox")) {
          return { rows: [] };
        }

        if (sql.includes("SELECT outbox.outbox_id AS outbox_id, outbox.payload")) {
          expect(params).toEqual(["4", ["item:item_1"], 100]);
          return {
            rows: [
              {
                outbox_id: "5",
                payload: {
                  kind: "projection.patch",
                  context: "discovery",
                  projection: "discovery-market",
                  topics: ["item:item_1"],
                  changes: [
                    {
                      op: "summary",
                      entity: "discovery.marketSummary",
                      id: "item:item_1",
                      value: { active_listing_count: 2 },
                    },
                  ],
                },
              },
              {
                outbox_id: "6",
                payload: {
                  kind: "projection.patch",
                  context: "discovery",
                  projection: "discovery-market",
                  topics: ["item:item_1"],
                  changes: [
                    {
                      op: "remove",
                      entity: "discovery.listing",
                      id: "list_2",
                    },
                  ],
                },
              },
            ],
          };
        }

        if (sql.includes("pruned_through_outbox_id")) {
          return { rows: [{ pruned_through_outbox_id: "0" }] };
        }

        return { rows: [] };
      },
    };

    const result = await readRealtimePatches([{ contextName: "discovery", db }], ["item:item_1"], { discovery: "4" });

    expect(result.expiredContexts).toEqual([]);
    expect(result.cursor).toEqual({ discovery: "6" });
    expect(result.messages.map((message) => message.outboxId)).toEqual(["5", "6"]);
  });

  it("skips outbox replay reads when subscribed topic heads are already caught up", async () => {
    let outboxReadCount = 0;
    const db = {
      query: async (sql: string) => {
        if (sql.includes("DELETE FROM realtime_projection_outbox")) {
          return { rows: [] };
        }

        if (sql.includes("FROM realtime_projection_topic_heads")) {
          return { rows: [{ topic: "public:market", outbox_id: "4" }] };
        }

        if (sql.includes("SELECT outbox.outbox_id AS outbox_id")) {
          outboxReadCount += 1;
          return { rows: [] };
        }

        throw new Error(`Unexpected query: ${sql}`);
      },
    };

    const result = await readRealtimePatches(
      [{ contextName: "discovery", db }],
      ["public:market"],
      { discovery: "4" },
      100,
      { includeTopicLag: true },
    );

    expect(result.messages).toEqual([]);
    expect(result.topicLags).toEqual([{ contextName: "discovery", topic: "public:market", lag: 0 }]);
    expect(outboxReadCount).toBe(0);
  });

  it("drops cursor entries for stores outside the requested topic family", async () => {
    const db = {
      query: async (sql: string) => {
        if (sql.includes("DELETE FROM realtime_projection_outbox")) {
          return { rows: [] };
        }

        if (sql.includes("SELECT outbox.outbox_id AS outbox_id, outbox.payload")) {
          return { rows: [] };
        }

        throw new Error(`Unexpected query: ${sql}`);
      },
    };

    const result = await readRealtimePatches(
      [
        {
          contextName: "discovery",
          db,
          exactTopics: ["public:market"],
        },
        {
          contextName: "marketplace",
          db,
          topicPrefixes: ["account:"],
        },
      ],
      ["public:market"],
      { discovery: "0", marketplace: "99" },
    );

    expect(result.cursor).toEqual({ discovery: "0" });
  });

  it("requires sync when a cursor is older than retained patches", async () => {
    const db = {
      query: async (sql: string) => {
        if (sql.includes("DELETE FROM realtime_projection_outbox")) {
          return { rows: [] };
        }

        if (sql.includes("pruned_through_outbox_id")) {
          return { rows: [{ pruned_through_outbox_id: "10" }] };
        }

        if (sql.includes("MAX(outbox_id)")) {
          return { rows: [{ head: "14" }] };
        }

        throw new Error(`Unexpected query: ${sql}`);
      },
    };

    const result = await readRealtimePatches([{ contextName: "marketplace", db }], ["account:account_1:offers"], {
      marketplace: "3",
    });

    expect(result).toEqual({
      cursor: { marketplace: "14" },
      expiredContexts: ["marketplace"],
      topicLags: [],
      messages: [],
    });
  });

  it("does not expire a cursor because of a benign sequence gap", async () => {
    const db = {
      query: async (sql: string, params?: readonly unknown[]) => {
        if (sql.includes("DELETE FROM realtime_projection_outbox")) {
          return { rows: [] };
        }

        if (sql.includes("pruned_through_outbox_id")) {
          return { rows: [{ pruned_through_outbox_id: "0" }] };
        }

        if (sql.includes("SELECT outbox.outbox_id AS outbox_id")) {
          expect(params).toEqual(["4", ["account:account_1:offers"], 100]);
          return {
            rows: [
              {
                outbox_id: "10",
                payload_json: JSON.stringify({
                  kind: "projection.patch",
                  context: "marketplace",
                  projection: "marketplace-offers",
                  topics: ["account:account_1:offers"],
                  changes: [
                    {
                      op: "summary",
                      entity: "marketplace.offerSummary",
                      id: "account_1",
                      value: { active_offer_count: 1 },
                    },
                  ],
                }),
                payload_bytes: "1",
              },
            ],
          };
        }

        return { rows: [] };
      },
    };

    const result = await readRealtimePatches([{ contextName: "marketplace", db }], ["account:account_1:offers"], {
      marketplace: "4",
    });

    expect(result.expiredContexts).toEqual([]);
    expect(result.cursor).toEqual({ marketplace: "10" });
    expect(result.messages.map((message) => message.outboxId)).toEqual(["10"]);
  });

  it("limits large replay batches and reports remaining per-topic lag", async () => {
    const outboxRows = Array.from({ length: 5_000 }, (_, index) => ({
      outbox_id: String(index + 1),
      payload: {
        kind: "projection.patch",
        context: "discovery",
        projection: "discovery-market",
        topics: ["public:market"],
        changes: [
          {
            op: "summary",
            entity: "discovery.marketSummary",
            id: `item_${index + 1}`,
            value: { active_listing_count: index + 1 },
          },
        ],
      },
    }));
    const db = {
      query: async (sql: string, params?: readonly unknown[]) => {
        if (sql.includes("DELETE FROM realtime_projection_outbox")) {
          return { rows: [] };
        }

        if (sql.includes("SELECT outbox.outbox_id AS outbox_id, outbox.payload")) {
          const after = Number(params?.[0] ?? 0);
          const limit = Number(params?.[2] ?? 100);
          return {
            rows: outboxRows.filter((row) => Number(row.outbox_id) > after).slice(0, limit),
          };
        }

        if (sql.includes("FROM unnest")) {
          const after = Number(params?.[0] ?? 0);
          return {
            rows: [{ topic: "public:market", lag: String(5_000 - after) }],
          };
        }

        throw new Error(`Unexpected query: ${sql}`);
      },
    };

    const result = await readRealtimePatches([{ contextName: "discovery", db }], ["public:market"], {}, 100, {
      includeTopicLag: true,
    });

    expect(result.messages).toHaveLength(100);
    expect(result.cursor).toEqual({ discovery: "100" });
    expect(result.topicLags).toEqual([{ contextName: "discovery", topic: "public:market", lag: 4_900 }]);
  });

  it("coalesces concurrent identical replay reads through the process-local read hub", async () => {
    let outboxReadCount = 0;
    const observed: string[] = [];
    let markOutboxReadStarted: (() => void) | undefined;
    const outboxReadStarted = new Promise<void>((resolve) => {
      markOutboxReadStarted = resolve;
    });
    let unblockOutboxRead: (() => void) | undefined;
    const outboxReadBlocked = new Promise<void>((resolve) => {
      unblockOutboxRead = resolve;
    });
    const db = {
      query: async (sql: string) => {
        if (sql.includes("DELETE FROM realtime_projection_outbox")) {
          return { rows: [] };
        }

        if (sql.includes("SELECT outbox.outbox_id AS outbox_id, outbox.payload")) {
          outboxReadCount += 1;
          markOutboxReadStarted?.();
          await outboxReadBlocked;
          return { rows: [] };
        }

        return { rows: [] };
      },
    };
    const hub = createRealtimeReadHub({
      observer: {
        readStarted: () => observed.push("started"),
        readCoalesced: () => observed.push("coalesced"),
      },
    });

    const reads = [
      hub.read([{ contextName: "discovery", db }], ["public:market"], {}, 100),
      hub.read([{ contextName: "discovery", db }], ["public:market"], {}, 100),
    ];
    await outboxReadStarted;
    unblockOutboxRead?.();
    await Promise.all(reads);

    expect(outboxReadCount).toBe(1);
    expect(observed).toEqual(["started", "coalesced"]);
  });

  it("compacts superseded summary changes during replay", () => {
    const messages = compactRealtimeReplayMessages([
      {
        contextName: "discovery",
        outboxId: "1",
        payload: {
          kind: "projection.patch",
          context: "discovery",
          projection: "discovery-market",
          topics: ["public:market"],
          changes: [
            {
              op: "summary",
              entity: "discovery.marketSummary",
              id: "item_1",
              value: { active_listing_count: 1 },
            },
          ],
        },
      },
      {
        contextName: "discovery",
        outboxId: "2",
        payload: {
          kind: "projection.patch",
          context: "discovery",
          projection: "discovery-market",
          topics: ["public:market"],
          changes: [
            {
              op: "summary",
              entity: "discovery.marketSummary",
              id: "item_1",
              value: { active_listing_count: 2 },
            },
          ],
        },
      },
    ]);

    expect(messages.map((message) => message.outboxId)).toEqual(["2"]);
  });

  it("builds an internal status snapshot", async () => {
    const snapshot = await createRealtimeStatusSnapshot({
      activeConnectionCount: 2,
      wakeSignalConfigured: true,
      stores: [
        {
          contextName: "discovery",
          exactTopics: ["public:market"],
          topicPrefixes: ["item:"],
          db: {
            query: async (sql: string) => {
              if (sql.includes("MAX(outbox_id)")) {
                return { rows: [{ head: "42" }] };
              }

              throw new Error(`Unexpected query: ${sql}`);
            },
          },
        },
      ],
      routeTuning: {
        batchSize: 25,
      },
      resourceLimits: {
        maxActiveStreams: 200,
      },
    });

    expect(snapshot).toMatchObject({
      activeConnectionCount: 2,
      wakeSignalConfigured: true,
      stores: [{ contextName: "discovery", head: "42" }],
      routeTuning: { batchSize: 25 },
      resourceLimits: { maxActiveStreams: 200 },
      routeConfig: {
        batchSize: 25,
        resourceLimits: { maxActiveStreams: 200 },
      },
    });
  });

  it("redacts cursor signing material from internal status snapshots", async () => {
    const snapshot = await createRealtimeStatusSnapshot({
      stores: [],
      routeConfig: resolveRealtimeRouteConfig({
        cursorSigningKeys: {
          current: "current-secret",
          previous: ["previous-secret"],
        },
      }),
    });

    expect(snapshot.routeConfig).toMatchObject({
      cursorSigningConfigured: true,
    });
    expect(JSON.stringify(snapshot.routeConfig)).not.toContain("secret");
  });

  it("validates formal realtime route config values", () => {
    expect(resolveRealtimeRouteConfig({ routeTuning: { batchSize: 25 } })).toMatchObject({
      batchSize: 25,
      resourceLimits: {
        maxTopicsPerStream: 16,
        maxActiveStreams: 1_000,
      },
    });
    expect(() => resolveRealtimeRouteConfig({ routeTuning: { batchSize: 0 } })).toThrow("batchSize");
  });

  it("acquires and releases distributed stream leases through Redis eval", async () => {
    const evalCalls: Array<{ keys: readonly string[]; arguments: readonly string[] }> = [];
    const limiter = createRedisRealtimeStreamLimiter({
      namespace: "test:realtime",
      leaseTtlSeconds: 30,
      client: {
        eval: async (_script, options) => {
          evalCalls.push(options);
          return evalCalls.length === 1 ? 2 : 1;
        },
      },
    });

    const lease = await limiter.acquire({
      connectionKey: "account:account_1",
      maxActiveStreams: 10,
      maxActiveStreamsPerConnectionKey: 2,
    });
    await lease?.release();

    expect(lease).toMatchObject({ activeConnectionCount: 2 });
    expect(evalCalls[0].keys[0]).toBe("test:realtime:active");
    expect(evalCalls[0].keys[1]).toBe("test:realtime:connection:account:account_1");
    expect(evalCalls[0].arguments).toEqual(["10", "2", "30"]);
    expect(evalCalls[1].arguments).toEqual([]);
  });

  it("renews distributed stream leases before release", async () => {
    const evalCalls: Array<{ keys: readonly string[]; arguments: readonly string[] }> = [];
    const limiter = createRedisRealtimeStreamLimiter({
      namespace: "test:realtime",
      leaseTtlSeconds: 30,
      renewIntervalMs: 60_000,
      client: {
        eval: async (_script, options) => {
          evalCalls.push(options);
          return evalCalls.length === 1 ? 1 : 1;
        },
      },
    });

    const lease = await limiter.acquire({
      connectionKey: "account:account_1",
      maxActiveStreams: 10,
      maxActiveStreamsPerConnectionKey: 2,
    });

    await expect(lease?.renew?.()).resolves.toBe(true);
    await lease?.release();

    expect(evalCalls[1].arguments).toEqual(["30"]);
    expect(evalCalls[2].arguments).toEqual([]);
  });

  it("rejects distributed stream leases when Redis reports capacity is exhausted", async () => {
    const limiter = createRedisRealtimeStreamLimiter({
      client: {
        eval: async () => -1,
      },
    });

    await expect(
      limiter.acquire({
        connectionKey: "anonymous:127.0.0.1",
        maxActiveStreams: 0,
        maxActiveStreamsPerConnectionKey: 0,
      }),
    ).resolves.toBeNull();
  });

  it("returns a retryable response when the stream limiter is unavailable", async () => {
    const app = createRealtimeRoutes({
      stores: [{ contextName: "discovery", db: { query: async () => ({ rows: [] }) } }],
      resolveActor: async () => null,
      streamLimiter: {
        acquire: async () => {
          throw new Error("control plane unavailable");
        },
      },
    });

    const response = await app.request("/public/events?topic=public%3Amarket");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "realtime_limiter_unavailable" },
    });
  });

  it("acquires and releases Postgres-backed stream leases", async () => {
    const statements: string[] = [];
    const client = {
      query: async (sql: string) => {
        statements.push(sql);
        if (sql.includes("SELECT counter_key, active_count")) {
          return {
            rows: [
              { counter_key: "global", active_count: "1" },
              { counter_key: "connection:account:account_1", active_count: "0" },
            ],
            rowCount: 2,
          };
        }
        return { rows: [], rowCount: 1 };
      },
      release: () => undefined,
    };
    const pool = {
      connect: async () => client,
      query: async (sql: string) => {
        statements.push(sql);
        return { rows: [], rowCount: 1 };
      },
    };
    const limiter = createPostgresRealtimeStreamLimiter({
      pool: pool as never,
      leaseTtlMs: 30_000,
      renewIntervalMs: 60_000,
    });

    const lease = await limiter.acquire({
      connectionKey: "account:account_1",
      maxActiveStreams: 10,
      maxActiveStreamsPerConnectionKey: 2,
    });
    await expect(lease?.renew?.()).resolves.toBe(true);
    await lease?.release();

    expect(lease).toMatchObject({ activeConnectionCount: 2 });
    expect(statements).toContain("BEGIN");
    expect(statements.some((sql) => sql.includes("INSERT INTO platform_realtime_stream_counters"))).toBe(true);
    expect(statements.some((sql) => sql.includes("INSERT INTO platform_realtime_stream_leases"))).toBe(true);
    expect(statements.some((sql) => sql.includes("UPDATE platform_realtime_stream_counters"))).toBe(true);
    expect(statements.some((sql) => sql.includes("DELETE FROM platform_realtime_stream_leases"))).toBe(true);
  });

  it("absorbs Postgres connection-ceiling failures from background stream lease renewal", async () => {
    vi.useFakeTimers();
    const connectionCeilingError = Object.assign(
      new Error("remaining connection slots are reserved for roles with the SUPERUSER attribute"),
      { code: "53300", severity: "FATAL" },
    );
    const renewalErrors: unknown[] = [];
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (error: unknown) => unhandledRejections.push(error);
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const client = {
        query: async (sql: string) => {
          if (sql.includes("SELECT counter_key, active_count")) {
            return {
              rows: [
                { counter_key: "global", active_count: "0" },
                { counter_key: "connection:account:account_1", active_count: "0" },
              ],
              rowCount: 2,
            };
          }
          return { rows: [], rowCount: 1 };
        },
        release: () => undefined,
      };
      const pool = {
        connect: async () => client,
        query: async (sql: string) => {
          if (sql.includes("SET expires_at")) {
            throw connectionCeilingError;
          }
          return { rows: [], rowCount: 1 };
        },
      };
      const limiter = createPostgresRealtimeStreamLimiter({
        pool: pool as never,
        leaseTtlMs: 30_000,
        renewIntervalMs: 1_000,
        onRenewalError: (error) => {
          renewalErrors.push(error);
          throw new Error("telemetry observer failed");
        },
      });
      const lease = await limiter.acquire({
        connectionKey: "account:account_1",
        maxActiveStreams: 10,
        maxActiveStreamsPerConnectionKey: 2,
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();

      expect(renewalErrors).toEqual([connectionCeilingError]);
      expect(unhandledRejections).toEqual([]);
      await lease?.release();
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      vi.useRealTimers();
    }
  });

  it("exercises a synthetic multi-instance stream-limit load harness", async () => {
    let active = 0;
    const activeByConnectionKey = new Map<string, number>();
    const client = {
      eval: async (_script: string, options: { keys: readonly string[]; arguments: readonly string[] }) => {
        const connectionKey = options.keys[1] ?? "";
        if (options.arguments.length === 0) {
          active = Math.max(0, active - 1);
          activeByConnectionKey.set(connectionKey, Math.max(0, (activeByConnectionKey.get(connectionKey) ?? 1) - 1));
          return 1;
        }

        const maxActive = Number(options.arguments[0]);
        const maxPerConnection = Number(options.arguments[1]);
        const activeForConnection = activeByConnectionKey.get(connectionKey) ?? 0;
        if (active >= maxActive || activeForConnection >= maxPerConnection) {
          return -1;
        }

        active += 1;
        activeByConnectionKey.set(connectionKey, activeForConnection + 1);
        return active;
      },
    };
    const firstInstance = createRedisRealtimeStreamLimiter({ client, namespace: "load:test" });
    const secondInstance = createRedisRealtimeStreamLimiter({ client, namespace: "load:test" });

    const leases = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        (index % 2 === 0 ? firstInstance : secondInstance).acquire({
          connectionKey: `account:account_${index % 4}`,
          maxActiveStreams: 6,
          maxActiveStreamsPerConnectionKey: 2,
        }),
      ),
    );

    expect(leases.filter(Boolean)).toHaveLength(6);
    expect(leases.filter((lease) => !lease)).toHaveLength(2);
    await Promise.all(leases.map((lease) => lease?.release()));
    expect(active).toBe(0);
  });

  it("prunes expired patches behind an advisory lock", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const db = {
      query: async (sql: string, params?: readonly unknown[]) => {
        calls.push({ sql, params });
        return { rows: [{ deleted_count: 3 }] };
      },
    };

    await expect(pruneExpiredRealtimePatchesWithAdvisoryLock(db, "42")).resolves.toBe(3);
    expect(calls[0].sql).toContain("pg_try_advisory_lock");
    expect(calls[0].sql).toContain("pg_advisory_unlock");
    expect(calls[0].params).toEqual(["42"]);
  });

  it("runs retention sweeping outside subscriber replay", async () => {
    const pruned: unknown[] = [];
    const db = {
      query: async () => ({ rows: [{ deleted_count: 2 }] }),
    };
    const sweeper = createRealtimeRetentionSweeper({
      stores: [{ contextName: "discovery", db }],
      intervalMs: 60_000,
      observer: {
        retentionPruned: (event) => pruned.push(event),
      },
    });

    await sweeper.sweep();
    sweeper.stop();

    expect(pruned).toContainEqual({
      contextName: "discovery",
      deletedCount: 2,
    });
  });

  it("can run projection updates and outbox writes in one transaction", async () => {
    const statements: string[] = [];
    const client = {
      query: async (sql: string) => {
        statements.push(sql);
        return { rows: [] };
      },
      release: () => {
        statements.push("release");
      },
    };
    const pool = {
      query: async (sql: string) => {
        statements.push(`pool:${sql}`);
        return { rows: [] };
      },
      connect: async () => client,
      idleCount: 1,
      totalCount: 1,
      waitingCount: 0,
    };

    await runRealtimeProjectionTransaction(pool, async (tx) => {
      await tx.query("UPDATE read_model");
      await tx.query("INSERT realtime_outbox");
    });

    expect(statements).toEqual(["BEGIN", "UPDATE read_model", "INSERT realtime_outbox", "COMMIT", "release"]);
  });

  it("sets idle transaction timeouts for realtime projection transactions", async () => {
    const statements: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const client = {
      query: async (sql: string, params?: readonly unknown[]) => {
        statements.push({ sql, params });
        return { rows: [] };
      },
      release: () => {
        statements.push({ sql: "release", params: undefined });
      },
    };
    const pool = {
      query: async (sql: string, params?: readonly unknown[]) => {
        statements.push({ sql: `pool:${sql}`, params });
        return { rows: [] };
      },
      connect: async () => client,
      idleCount: 1,
      totalCount: 1,
      waitingCount: 0,
      idleInTransactionSessionTimeoutMillis: 15_000,
    };

    await runRealtimeProjectionTransaction(pool, async (tx) => {
      await tx.query("UPDATE read_model");
    });

    expect(statements).toEqual([
      { sql: "BEGIN", params: undefined },
      { sql: "SELECT set_config('idle_in_transaction_session_timeout', $1, true)", params: ["15000ms"] },
      { sql: "UPDATE read_model", params: undefined },
      { sql: "COMMIT", params: undefined },
      { sql: "release", params: undefined },
    ]);
  });

  it("rolls back realtime projection transaction failures without destroying a clean client", async () => {
    const releaseErrors: unknown[] = [];
    const statements: string[] = [];
    const failure = new Error("projection conflict");
    const client = {
      query: async (sql: string) => {
        statements.push(sql);
        return { rows: [] };
      },
      release: (error?: unknown) => {
        releaseErrors.push(error);
        statements.push("release");
      },
    };
    const pool = {
      query: async (sql: string) => {
        statements.push(`pool:${sql}`);
        return { rows: [] };
      },
      connect: async () => client,
      idleCount: 1,
      totalCount: 1,
      waitingCount: 0,
    };

    await expect(
      runRealtimeProjectionTransaction(pool, async (tx) => {
        await tx.query("UPDATE read_model");
        throw failure;
      }),
    ).rejects.toThrow("projection conflict");

    expect(statements).toEqual(["BEGIN", "UPDATE read_model", "ROLLBACK", "release"]);
    expect(releaseErrors).toEqual([undefined]);
  });

  it("destroys realtime projection transaction clients when rollback fails", async () => {
    const releaseErrors: unknown[] = [];
    const statements: string[] = [];
    const rollbackFailure = new Error("rollback failed");
    const client = {
      query: async (sql: string) => {
        statements.push(sql);
        if (sql === "ROLLBACK") {
          throw rollbackFailure;
        }
        return { rows: [] };
      },
      release: (error?: unknown) => {
        releaseErrors.push(error);
        statements.push("release");
      },
    };
    const pool = {
      query: async (sql: string) => {
        statements.push(`pool:${sql}`);
        return { rows: [] };
      },
      connect: async () => client,
      idleCount: 1,
      totalCount: 1,
      waitingCount: 0,
    };

    await expect(
      runRealtimeProjectionTransaction(pool, async () => {
        throw new Error("projection conflict");
      }),
    ).rejects.toThrow("projection conflict");

    expect(statements).toEqual(["BEGIN", "ROLLBACK", "release"]);
    expect(releaseErrors).toEqual([rollbackFailure]);
  });

  it("records a batch of projection patches through one transaction boundary", async () => {
    const statements: string[] = [];
    let outboxId = 0;
    const client = {
      query: async (sql: string) => {
        statements.push(sql);
        if (sql.includes("INSERT INTO realtime_projection_outbox")) {
          outboxId += 1;
          return { rows: [{ outbox_id: String(outboxId) }] };
        }

        return { rows: [] };
      },
      release: () => {
        statements.push("release");
      },
    };
    const pool = {
      query: async (sql: string) => {
        statements.push(`pool:${sql}`);
        return { rows: [] };
      },
      connect: async () => client,
      idleCount: 1,
      totalCount: 1,
      waitingCount: 0,
    };

    await recordRealtimeProjectionPatches(pool, [
      {
        sourceGlobalPosition: "1",
        projectionName: "marketplace-offer-projection",
        patchKey: "offer-match:one",
        topics: ["account:account_1:offers"],
        patch: {
          kind: "projection.patch",
          context: "marketplace",
          projection: "marketplace-offer-projection",
          topics: ["account:account_1:offers"],
          changes: [
            {
              op: "remove",
              entity: "marketplace.offerMatch",
              id: "offer_1",
            },
          ],
        },
      },
      {
        sourceGlobalPosition: "1",
        projectionName: "marketplace-offer-projection",
        patchKey: "offer-match:two",
        topics: ["account:account_2:offers"],
        patch: {
          kind: "projection.patch",
          context: "marketplace",
          projection: "marketplace-offer-projection",
          topics: ["account:account_2:offers"],
          changes: [
            {
              op: "remove",
              entity: "marketplace.offerMatch",
              id: "offer_1",
            },
          ],
        },
      },
    ]);

    expect(statements[0]).toBe("BEGIN");
    expect(statements.filter((sql) => sql.includes("INSERT INTO realtime_projection_outbox ("))).toHaveLength(2);
    expect(statements.at(-2)).toBe("COMMIT");
    expect(statements.at(-1)).toBe("release");
  });

  it("exposes a composite work-signal wake signal for low-latency polling", async () => {
    const client = createWakeSignalNotificationClient();
    const wakeSignal = createRealtimeOutboxWakeSignal(createWakeSignalPool(client));
    const woke = wakeSignal.wait(60_000);

    await waitForWakeSignalListen(client);
    client.emit("notification", {
      channel: realtimeProjectionNotifyChannel,
      payload: serializeWorkSignalEnvelope(
        createWorkSignalEnvelope({
          kind: "realtime.outbox-wake",
          source: "realtime-outbox",
          payload: { context: "discovery", projection: "discovery-market", topics: ["public:market"] },
        }),
      ),
    });

    await expect(woke).resolves.toBe("notified");
    await wakeSignal.stop?.();

    expect(client.queries).toEqual([
      `LISTEN ${realtimeProjectionNotifyChannel}`,
      `UNLISTEN ${realtimeProjectionNotifyChannel}`,
    ]);
    expect(client.isReleased()).toBe(true);
  });

  it("only wakes topic-aware waiters for intersecting envelope or legacy notification topics", async () => {
    vi.useFakeTimers();
    const client = createWakeSignalNotificationClient();
    const observed: unknown[] = [];
    const wakeSignal = createRealtimeOutboxWakeSignal(createWakeSignalPool(client), {
      observer: {
        wakeNotificationReceived: (event) => observed.push(event),
      },
    });
    try {
      const itemWake = wakeSignal.wait(60_000, ["item:item_1"]);
      const accountWake = wakeSignal.wait(150, ["public-account:account_1"]);
      const legacyWake = wakeSignal.wait(60_000, ["listing:list_9"]);

      await waitForWakeSignalListen(client);
      client.emit("notification", {
        channel: realtimeProjectionNotifyChannel,
        payload: serializeWorkSignalEnvelope(
          createWorkSignalEnvelope({
            kind: "realtime.outbox-wake",
            source: "realtime-outbox",
            payload: { context: "catalog", projection: "catalog-items", topics: ["item:item_1"] },
          }),
        ),
      });
      // Rolling-deploy compatibility: pre-composite emitters send raw topics.
      client.emit("notification", {
        channel: realtimeProjectionNotifyChannel,
        payload: JSON.stringify({ context: "marketplace", projection: "listings", topics: ["listing:list_9"] }),
      });

      await expect(itemWake).resolves.toBe("notified");
      await expect(legacyWake).resolves.toBe("notified");
      await vi.advanceTimersByTimeAsync(150);
      await expect(accountWake).resolves.toBe("timeout");
      expect(observed[0]).toMatchObject({
        notificationTopics: ["item:item_1"],
        waiterCount: 3,
        matchedWaiterCount: 1,
      });
      expect(observed[1]).toMatchObject({
        notificationTopics: ["listing:list_9"],
        matchedWaiterCount: 1,
      });
    } finally {
      await wakeSignal.stop?.();
      vi.useRealTimers();
    }
  });

  it("fails open to wake-all when a notification payload is unparseable", async () => {
    const client = createWakeSignalNotificationClient();
    const wakeSignal = createRealtimeOutboxWakeSignal(createWakeSignalPool(client));
    const itemWake = wakeSignal.wait(60_000, ["item:item_1"]);
    const accountWake = wakeSignal.wait(60_000, ["public-account:account_1"]);

    await waitForWakeSignalListen(client);
    // Deploy-overlap safety: a payload from an unknown emitter version must
    // wake every waiter (a dropped latency hint is worse than an extra
    // outbox poll), never be silently discarded.
    client.emit("notification", {
      channel: realtimeProjectionNotifyChannel,
      payload: "not-json{{{",
    });

    await expect(itemWake).resolves.toBe("notified");
    await expect(accountWake).resolves.toBe("notified");
    await wakeSignal.stop?.();
  });

  it("falls back to a timeout when the wake-signal listener is unavailable", async () => {
    vi.useFakeTimers();
    const client = createWakeSignalNotificationClient({ failListen: true });
    const unavailable: unknown[] = [];
    const wakeSignal = createRealtimeOutboxWakeSignal(createWakeSignalPool(client), {
      onListenerUnavailable: (error) => unavailable.push(error),
    });
    try {
      const firstWait = wakeSignal.wait(100, ["item:item_1"]);
      await vi.advanceTimersByTimeAsync(100);
      await expect(firstWait).resolves.toBe("timeout");

      const secondWait = wakeSignal.wait(100, ["item:item_1"]);
      // Reconnects are circuit-broken: the cooled-down retry does not re-report.
      await vi.advanceTimersByTimeAsync(100);
      await expect(secondWait).resolves.toBe("timeout");
      expect(unavailable).toHaveLength(1);
      expect(client.listenAttempts()).toBe(1);
      expect(client.isReleased()).toBe(true);
    } finally {
      await wakeSignal.stop?.();
      vi.useRealTimers();
    }
  });
});

function createWakeSignalNotificationClient(options: { failListen?: boolean } = {}) {
  const emitter = new EventEmitter();
  const queries: string[] = [];
  let released = false;
  let listenAttempts = 0;
  let resolveListen: (() => void) | undefined;
  const listenIssued = new Promise<void>((resolve) => {
    resolveListen = resolve;
  });

  return Object.assign(emitter, {
    queries,
    isReleased: () => released,
    listenAttempts: () => listenAttempts,
    waitForListen: () => listenIssued,
    query: async (sql: string) => {
      if (sql.startsWith("LISTEN")) {
        listenAttempts += 1;
        if (options.failListen) {
          throw new Error("LISTEN is unavailable on this connection.");
        }
        resolveListen?.();
        resolveListen = undefined;
      }
      queries.push(sql);
      return { rows: [], rowCount: 0 };
    },
    release: () => {
      released = true;
    },
  });
}

function createWakeSignalPool(client: ReturnType<typeof createWakeSignalNotificationClient>) {
  return {
    connect: async () => client,
    query: async () => ({ rows: [], rowCount: 0 }),
  } as unknown as Parameters<typeof createRealtimeOutboxWakeSignal>[0];
}

async function waitForWakeSignalListen(client: ReturnType<typeof createWakeSignalNotificationClient>): Promise<void> {
  await client.waitForListen();
  await Promise.resolve();
  await Promise.resolve();
}
