import { describe, expect, it } from "vitest";
import {
  authorizeRealtimeTopics,
  createPostgresRealtimeWakeSignal,
  createRealtimeRoutes,
  createRealtimeRetentionSweeper,
  decodeRealtimeCursor,
  encodeRealtimeCursor,
  parseRealtimeTopics,
  pruneExpiredRealtimePatchesWithAdvisoryLock,
  readRealtimePatches,
  recordRealtimeProjectionPatch,
  recordRealtimeProjectionPatches,
  realtimeProjectionNotifyChannel,
  realtimeOutboxSchemaSql,
  runRealtimeProjectionTransaction,
  selectRealtimeStoresForTopics,
} from "./realtime";

const actor = {
  sessionId: "sess_1",
  tenantId: "tenant_1",
  userId: "user_1",
  accountId: "account_1",
  membershipId: "member_1",
  roleKey: "manager",
  permissions: ["listings.view", "offers.view"],
};

describe("realtime topic authorization", () => {
  it("allows anonymous public marketplace topics", () => {
    expect(
      authorizeRealtimeTopics(
        ["public:market", "item:item_1", "listing:listing_1", "seller:account_1"],
        null,
      ),
    ).toEqual(["item:item_1", "listing:listing_1", "public:market", "seller:account_1"]);
  });

  it("allows signed-in account topics for the current account and permissions", () => {
    expect(
      authorizeRealtimeTopics(
        ["account:account_1:listings", "account:account_1:offers"],
        actor,
      ),
    ).toEqual(["account:account_1:listings", "account:account_1:offers"]);
  });

  it("rejects anonymous account topics", () => {
    expect(
      authorizeRealtimeTopics(["account:account_1:listings"], null),
    ).toBeNull();
  });

  it("rejects signed-in account topics without matching permissions", () => {
    expect(
      authorizeRealtimeTopics(
        ["account:account_1:offers"],
        {
          ...actor,
          permissions: ["listings.view"],
        },
      ),
    ).toBeNull();
  });

  it("rejects mixed unauthorized topics", () => {
    expect(
      authorizeRealtimeTopics(
        ["public:market", "account:other_account:listings"],
        actor,
      ),
    ).toBeNull();
  });

  it("rejects malformed and oversized topic requests before authorization", () => {
    expect(authorizeRealtimeTopics(["item:"], null)).toBeNull();
    expect(authorizeRealtimeTopics(["item:item_1:extra"], null)).toBeNull();
    expect(
      authorizeRealtimeTopics(
        Array.from({ length: 17 }, (_, index) => `item:item_${index}`),
        null,
      ),
    ).toBeNull();
  });
});

describe("realtime SSE routes", () => {
  it("rejects streams that exceed active connection limits", async () => {
    const rejected: unknown[] = [];
    const app = createRealtimeRoutes({
      stores: [{ contextName: "discovery", db: { query: async () => ({ rows: [] }) } }],
      resolveActor: async () => null,
      resourceLimits: {
        maxActiveStreams: 0,
      },
      observer: {
        authorizationRejected: (event) => rejected.push(event),
      },
    });

    const response = await app.request("/events?topic=public%3Amarket");

    expect(response.status).toBe(429);
    expect(rejected).toEqual([
      expect.objectContaining({
        reason: "resource-limit",
      }),
    ]);
  });

  it("reconnects from Last-Event-ID and streams the next retained patch", async () => {
    const queryParams: unknown[][] = [];
    const db = {
      query: async (sql: string, params?: unknown[]) => {
        if (params) {
          queryParams.push(params);
        }

        if (sql.includes("DELETE FROM realtime_projection_outbox")) {
          return { rows: [] };
        }

        if (sql.includes("MIN(outbox_id)")) {
          return { rows: [{ min_outbox_id: "2" }] };
        }

        if (sql.includes("SELECT outbox_id, payload")) {
          return {
            rows: [
              {
                outbox_id: "2",
                payload: {
                  kind: "projection.patch",
                  context: "discovery",
                  projection: "discovery-market-projection",
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
            ],
          };
        }

        if (sql.includes("FROM unnest")) {
          return { rows: [{ topic: "public:market", lag: "0" }] };
        }

        throw new Error(`Unexpected query: ${sql}`);
      },
    };
    const app = createRealtimeRoutes({
      stores: [{ contextName: "discovery", db }],
      resolveActor: async () => null,
      pollIntervalMs: 60_000,
    });
    const abort = new AbortController();

    const response = await app.request("/events?topic=public%3Amarket", {
      headers: {
        "Last-Event-ID": encodeRealtimeCursor({ discovery: "1" }),
      },
      signal: abort.signal,
    });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const chunk = await reader!.read();
    await reader!.cancel();
    abort.abort();

    const text = new TextDecoder().decode(chunk.value);
    expect(response.status).toBe(200);
    expect(queryParams).toContainEqual(["1", ["public:market"], 100]);
    expect(text).toContain(`id: ${encodeRealtimeCursor({ discovery: "2" })}`);
    expect(text).toContain("event: projection.patch");
    expect(text).toContain("\"entity\":\"discovery.marketSummary\"");
  });

  it("keeps heartbeat cadence separate from poll cadence", async () => {
    const db = {
      query: async (sql: string) => {
        if (sql.includes("DELETE FROM realtime_projection_outbox")) {
          return { rows: [] };
        }

        if (sql.includes("SELECT outbox_id, payload")) {
          return { rows: [] };
        }

        if (sql.includes("FROM unnest")) {
          return { rows: [{ topic: "public:market", lag: "0" }] };
        }

        throw new Error(`Unexpected query: ${sql}`);
      },
    };
    const app = createRealtimeRoutes({
      stores: [{ contextName: "discovery", db }],
      resolveActor: async () => null,
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 0,
    });
    const abort = new AbortController();

    const response = await app.request("/events?topic=public%3Amarket", {
      signal: abort.signal,
    });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const chunk = await reader!.read();
    await reader!.cancel();
    abort.abort();

    const text = new TextDecoder().decode(chunk.value);
    expect(response.status).toBe(200);
    expect(text).toContain("event: heartbeat");
  });

  it("requires sync instead of replaying an unbounded backlog", async () => {
    const db = {
      query: async (sql: string) => {
        if (sql.includes("DELETE FROM realtime_projection_outbox")) {
          return { rows: [] };
        }

        if (sql.includes("SELECT outbox_id, payload")) {
          return {
            rows: [
              {
                outbox_id: "7",
                payload: {
                  kind: "projection.patch",
                  context: "discovery",
                  projection: "discovery-market-projection",
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
            ],
          };
        }

        if (sql.includes("MAX(outbox_id)")) {
          return { rows: [{ head: "9" }] };
        }

        if (sql.includes("FROM unnest")) {
          return { rows: [{ topic: "public:market", lag: "2" }] };
        }

        throw new Error(`Unexpected query: ${sql}`);
      },
    };
    const app = createRealtimeRoutes({
      stores: [{ contextName: "discovery", db }],
      resolveActor: async () => null,
      batchSize: 1,
      maxConsecutiveFullBatches: 1,
      pollIntervalMs: 60_000,
    });
    const abort = new AbortController();

    const response = await app.request("/events?topic=public%3Amarket", {
      signal: abort.signal,
    });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const chunk = await reader!.read();
    await reader!.cancel();
    abort.abort();

    const text = new TextDecoder().decode(chunk.value);
    expect(response.status).toBe(200);
    expect(text).toContain("event: sync.required");
    expect(text).toContain("\"reason\":\"replay-backpressure\"");
    expect(text).toContain(`id: ${encodeRealtimeCursor({ discovery: "9" })}`);
    expect(text).not.toContain("event: projection.patch");
  });
});

describe("realtime cursors", () => {
  it("round-trips opaque cursor ids", () => {
    const cursor = { discovery: "42", marketplace: "7" };

    expect(decodeRealtimeCursor(encodeRealtimeCursor(cursor))).toEqual(cursor);
  });

  it("ignores malformed cursors", () => {
    expect(decodeRealtimeCursor("not valid")).toEqual({});
  });
});

describe("realtime topic parsing", () => {
  it("accepts repeated and comma-separated topic query parameters", () => {
    const params = new URLSearchParams(
      "topic=public%3Amarket&topics=item%3Aone,item%3Atwo&topic=item%3Aone",
    );

    expect(parseRealtimeTopics(params)).toEqual([
      "item:one",
      "item:two",
      "public:market",
    ]);
  });
});

describe("realtime store topic ownership", () => {
  it("filters context stores to the topic families they own", () => {
    const discoveryStore = {
      contextName: "discovery",
      db: { query: async () => ({ rows: [] }) },
      exactTopics: ["public:market"],
      topicPrefixes: ["item:", "listing:", "seller:"],
    };
    const marketplaceStore = {
      contextName: "marketplace",
      db: { query: async () => ({ rows: [] }) },
      topicPrefixes: ["account:"],
    };

    expect(
      selectRealtimeStoresForTopics(
        [discoveryStore, marketplaceStore],
        ["public:market", "item:item_1"],
      ).map((store) => store.contextName),
    ).toEqual(["discovery"]);
    expect(
      selectRealtimeStoresForTopics(
        [discoveryStore, marketplaceStore],
        ["account:account_1:offers"],
      ).map((store) => store.contextName),
    ).toEqual(["marketplace"]);
  });
});

describe("realtime outbox", () => {
  it("defines a durable topic index for scalable replay", () => {
    expect(realtimeOutboxSchemaSql).toContain("realtime_projection_outbox_topics");
    expect(realtimeOutboxSchemaSql).toContain("PRIMARY KEY (topic, outbox_id)");
    expect(realtimeOutboxSchemaSql).toContain("ON DELETE CASCADE");
  });

  it("records idempotent projection patches with a retention cutoff", async () => {
    const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const db = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
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

    expect(calls[0].sql).toContain("ON CONFLICT");
    expect(calls[0].sql).toContain("realtime_projection_outbox_topics");
    expect(calls[0].params).toEqual([
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
      ["listing:list_1", "public:market"],
      realtimeProjectionNotifyChannel,
      "discovery",
    ]);
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

  it("replays retained patches in per-context outbox order for matching topics", async () => {
    const db = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes("DELETE FROM realtime_projection_outbox")) {
          return { rows: [] };
        }

        if (sql.includes("SELECT outbox_id, payload")) {
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

        if (sql.includes("MIN(outbox_id)")) {
          return { rows: [{ min_outbox_id: "5" }] };
        }

        return { rows: [] };
      },
    };

    const result = await readRealtimePatches(
      [{ contextName: "discovery", db }],
      ["item:item_1"],
      { discovery: "4" },
    );

    expect(result.expiredContexts).toEqual([]);
    expect(result.cursor).toEqual({ discovery: "6" });
    expect(result.messages.map((message) => message.outboxId)).toEqual(["5", "6"]);
  });

  it("drops cursor entries for stores outside the requested topic family", async () => {
    const db = {
      query: async (sql: string) => {
        if (sql.includes("DELETE FROM realtime_projection_outbox")) {
          return { rows: [] };
        }

        if (sql.includes("SELECT outbox_id, payload")) {
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

        if (sql.includes("MIN(outbox_id)")) {
          return { rows: [{ min_outbox_id: "10" }] };
        }

        if (sql.includes("MAX(outbox_id)")) {
          return { rows: [{ head: "14" }] };
        }

        throw new Error(`Unexpected query: ${sql}`);
      },
    };

    const result = await readRealtimePatches(
      [{ contextName: "marketplace", db }],
      ["account:account_1:offers"],
      { marketplace: "3" },
    );

    expect(result).toEqual({
      cursor: { marketplace: "14" },
      expiredContexts: ["marketplace"],
      topicLags: [],
      messages: [],
    });
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
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes("DELETE FROM realtime_projection_outbox")) {
          return { rows: [] };
        }

        if (sql.includes("SELECT outbox_id, payload")) {
          const after = Number(params?.[0] ?? 0);
          const limit = Number(params?.[2] ?? 100);
          return {
            rows: outboxRows
              .filter((row) => Number(row.outbox_id) > after)
              .slice(0, limit),
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

    const result = await readRealtimePatches(
      [{ contextName: "discovery", db }],
      ["public:market"],
      {},
      100,
      { includeTopicLag: true },
    );

    expect(result.messages).toHaveLength(100);
    expect(result.cursor).toEqual({ discovery: "100" });
    expect(result.topicLags).toEqual([
      { contextName: "discovery", topic: "public:market", lag: 4_900 },
    ]);
  });

  it("prunes expired patches behind an advisory lock", async () => {
    const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const db = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        return { rows: [{ deleted_count: 3 }] };
      },
    };

    await expect(pruneExpiredRealtimePatchesWithAdvisoryLock(db, "42"))
      .resolves.toBe(3);
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
    };

    await runRealtimeProjectionTransaction(pool, async (tx) => {
      await tx.query("UPDATE read_model");
      await tx.query("INSERT realtime_outbox");
    });

    expect(statements).toEqual([
      "BEGIN",
      "UPDATE read_model",
      "INSERT realtime_outbox",
      "COMMIT",
      "release",
    ]);
  });

  it("records a batch of projection patches through one transaction boundary", async () => {
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
    expect(statements.filter((sql) => sql.includes("INSERT INTO realtime_projection_outbox")))
      .toHaveLength(2);
    expect(statements.at(-2)).toBe("COMMIT");
    expect(statements.at(-1)).toBe("release");
  });

  it("exposes a Postgres notification wake signal for low-latency polling", async () => {
    const listeners = new Set<(message: { channel: string }) => void>();
    const queries: string[] = [];
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [] };
      },
      on: (_event: "notification", listener: (message: { channel: string }) => void) => {
        listeners.add(listener);
      },
      off: (_event: "notification", listener: (message: { channel: string }) => void) => {
        listeners.delete(listener);
      },
    };
    const wakeSignal = await createPostgresRealtimeWakeSignal(client);
    const woke = wakeSignal.wait(60_000);

    for (const listener of listeners) {
      listener({ channel: realtimeProjectionNotifyChannel });
    }
    await expect(woke).resolves.toBe("notified");
    await wakeSignal.stop?.();

    expect(queries).toEqual([
      `LISTEN ${realtimeProjectionNotifyChannel}`,
      `UNLISTEN ${realtimeProjectionNotifyChannel}`,
    ]);
  });
});
