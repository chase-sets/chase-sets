import { describe, expect, it } from "vitest";
import {
  authorizeRealtimeTopics,
  coalesceRealtimeProjectionPatchInputs,
  compactRealtimeReplayMessages,
  createPostgresRealtimeWakeSignal,
  createPostgresRealtimeStreamLimiter,
  createRealtimeOutboxPartitionName,
  createRealtimeOutboxPartitionMaintainer,
  createRealtimeReadHub,
  createRealtimeRoutes,
  createRealtimeRetentionSweeper,
  createRedisRealtimeStreamLimiter,
  createRealtimeStatusSnapshot,
  decodeRealtimeCursor,
  encodeRealtimeCursor,
  inspectRealtimeTopicNormalization,
  matchesRealtimeTopicPattern,
  parseRealtimeTopics,
  pruneExpiredRealtimePatchesWithAdvisoryLock,
  readRealtimePatches,
  recordRealtimeProjectionPatch,
  recordRealtimeProjectionPatches,
  realtimeProjectionNotifyChannel,
  realtimeOutboxPartitionMaintenanceSql,
  realtimeOutboxSchemaSql,
  resolveRealtimeRouteConfig,
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

async function readSseTextUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (text: string) => boolean,
  maxReads = 5,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for (let index = 0; index < maxReads; index += 1) {
    const chunk = await reader.read();
    if (chunk.value) {
      text += decoder.decode(chunk.value);
    }
    if (predicate(text) || chunk.done) {
      return text;
    }
  }

  return text;
}

describe("realtime topic authorization", () => {
  it("allows anonymous public marketplace topics", () => {
    expect(
      authorizeRealtimeTopics(
        ["public:market", "item:item_1", "listing:listing_1", "public-account:account_1"],
        null,
      ),
    ).toEqual(["item:item_1", "listing:listing_1", "public-account:account_1", "public:market"]);
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

    const response = await app.request("/public/events?topic=public%3Amarket");

    expect(response.status).toBe(429);
    expect(rejected).toEqual([
      expect.objectContaining({
        reason: "resource-limit",
      }),
    ]);
  });

  it("rejects mixed public and forbidden account topics at the SSE boundary", async () => {
    const app = createRealtimeRoutes({
      stores: [{ contextName: "discovery", db: { query: async () => ({ rows: [] }) } }],
      resolveActor: async () => null,
    });

    const response = await app.request(
      "/public/events?topic=public%3Amarket&topic=account%3Aaccount_1%3Aoffers",
    );

    expect(response.status).toBe(403);
  });

  it("exposes public and account endpoint aliases with route-family guards", async () => {
    const app = createRealtimeRoutes({
      stores: [{ contextName: "discovery", db: { query: async () => ({ rows: [] }) } }],
      resolveActor: async () => actor,
    });

    await expect(app.request("/public/events?topic=account%3Aaccount_1%3Aoffers"))
      .resolves.toHaveProperty("status", 403);
    await expect(app.request("/account/events?topic=public%3Amarket"))
      .resolves.toHaveProperty("status", 403);
  });

  it("reports topic normalization diagnostics before authorization", async () => {
    const diagnostics: unknown[] = [];
    const app = createRealtimeRoutes({
      stores: [{ contextName: "discovery", db: { query: async () => ({ rows: [] }) } }],
      resolveActor: async () => null,
      observer: {
        topicNormalizationAdjusted: (event) => diagnostics.push(event),
      },
    });

    const response = await app.request(
      "/public/events?topic=%20&topic=public%3Amarket&topic=public%3Amarket&topic=nope",
    );

    expect(response.status).toBe(403);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        normalizedTopics: ["nope", "public:market"],
        diagnostic: expect.objectContaining({
          blankCount: 1,
          duplicateCount: 1,
          invalidCount: 1,
          requestedCount: 4,
          normalizedCount: 2,
        }),
      }),
    ]);
  });

  it("reconnects from Last-Event-ID and streams the next retained patch", async () => {
    const queryParams: unknown[][] = [];
    const sentMessages: unknown[] = [];
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

        if (sql.includes("SELECT outbox.outbox_id AS outbox_id, outbox.payload")) {
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
      observer: {
        messageSent: (event) => sentMessages.push(event),
      },
    });
    const abort = new AbortController();

    const response = await app.request("/public/events?topic=public%3Amarket", {
      headers: {
        "Last-Event-ID": encodeRealtimeCursor({ discovery: "1" }),
      },
      signal: abort.signal,
    });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const text = await readSseTextUntil(
      reader!,
      (value) => value.includes("event: projection.patch"),
    );
    abort.abort();
    await reader!.cancel();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(response.status).toBe(200);
    expect(queryParams).toContainEqual(["1", ["public:market"], 100]);
    expect(text).toContain(`id: ${encodeRealtimeCursor({ discovery: "2" })}`);
    expect(text).toContain("event: projection.patch");
    expect(text).toContain("\"entity\":\"discovery.marketSummary\"");
    expect(sentMessages).toEqual([
      expect.objectContaining({
        contextName: "discovery",
        payloadBytes: expect.any(Number),
      }),
    ]);
  });

  it("treats malformed Last-Event-ID as an empty cursor", async () => {
    const queryParams: unknown[][] = [];
    const db = {
      query: async (sql: string, params?: unknown[]) => {
        if (params) {
          queryParams.push(params);
        }

        if (sql.includes("DELETE FROM realtime_projection_outbox")) {
          return { rows: [] };
        }

        if (sql.includes("SELECT outbox.outbox_id AS outbox_id, outbox.payload")) {
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

    const response = await app.request("/public/events?topic=public%3Amarket", {
      headers: {
        "Last-Event-ID": "not-a-cursor",
      },
      signal: abort.signal,
    });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    await readSseTextUntil(
      reader!,
      () => queryParams.some((params) =>
        JSON.stringify(params) === JSON.stringify(["0", ["public:market"], 100])
      ),
    );
    abort.abort();
    await reader!.cancel();

    expect(response.status).toBe(200);
    expect(queryParams).toContainEqual(["0", ["public:market"], 100]);
  });

  it("applies per-topic-family replay budgets", async () => {
    const queryParams: unknown[][] = [];
    const db = {
      query: async (sql: string, params?: unknown[]) => {
        if (params) {
          queryParams.push(params);
        }

        if (sql.includes("DELETE FROM realtime_projection_outbox")) {
          return { rows: [] };
        }

        if (sql.includes("SELECT outbox.outbox_id AS outbox_id, outbox.payload")) {
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
      topicFamilyBudgets: [{ family: "public", batchSize: 7 }],
    });
    const abort = new AbortController();

    const response = await app.request("/public/events?topic=public%3Amarket", {
      signal: abort.signal,
    });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    await readSseTextUntil(
      reader!,
      () => queryParams.some((params) =>
        JSON.stringify(params) === JSON.stringify(["0", ["public:market"], 7])
      ),
    );
    abort.abort();
    void reader!.cancel();

    expect(response.status).toBe(200);
    expect(queryParams).toContainEqual(["0", ["public:market"], 7]);
  });

  it("keeps heartbeat cadence separate from poll cadence", async () => {
    const db = {
      query: async (sql: string) => {
        if (sql.includes("DELETE FROM realtime_projection_outbox")) {
          return { rows: [] };
        }

        if (sql.includes("SELECT outbox.outbox_id AS outbox_id, outbox.payload")) {
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

    const response = await app.request("/public/events?topic=public%3Amarket", {
      signal: abort.signal,
    });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const text = await readSseTextUntil(
      reader!,
      (value) => value.includes("event: sync.required"),
    );
    abort.abort();
    void reader!.cancel();

    expect(response.status).toBe(200);
    expect(text).toContain("event: heartbeat");
  });

  it("emits an immediate heartbeat so idle SSE streams do not look completed", async () => {
    const db = {
      query: async (sql: string) => {
        if (sql.includes("DELETE FROM realtime_projection_outbox")) {
          return { rows: [] };
        }

        if (sql.includes("SELECT outbox.outbox_id AS outbox_id")) {
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
      pollIntervalMs: 1_000,
      heartbeatIntervalMs: 60_000,
    });
    const abort = new AbortController();

    const response = await app.request("/public/events?topic=public%3Amarket", {
      signal: abort.signal,
    });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const initial = await reader!.read();
    const initialText = new TextDecoder().decode(initial.value);
    expect(initialText).toContain("event: heartbeat");
    await reader!.cancel();
    abort.abort();

    expect(response.status).toBe(200);
    expect(initialText).toContain("retry: 1000");
  });

  it("requires sync instead of replaying an unbounded backlog", async () => {
    const db = {
      query: async (sql: string) => {
        if (sql.includes("DELETE FROM realtime_projection_outbox")) {
          return { rows: [] };
        }

        if (sql.includes("SELECT outbox.outbox_id AS outbox_id, outbox.payload")) {
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

    const response = await app.request("/public/events?topic=public%3Amarket", {
      signal: abort.signal,
    });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const text = await readSseTextUntil(
      reader!,
      (value) => value.includes("event: sync.required"),
    );
    await reader!.cancel();
    abort.abort();

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

  it("supports signed cursor ids and rejects tampered unsigned cursors when signing is required", () => {
    const cursor = { discovery: "42" };
    const signed = encodeRealtimeCursor(cursor, "secret");

    expect(decodeRealtimeCursor(signed, "secret")).toEqual(cursor);
    expect(decodeRealtimeCursor(encodeRealtimeCursor(cursor), "secret")).toEqual({});
    expect(decodeRealtimeCursor(signed, "other-secret")).toEqual({});
  });

  it("accepts previous cursor signing keys during key rotation", () => {
    const cursor = { discovery: "42" };
    const signedWithPreviousKey = encodeRealtimeCursor(cursor, "old-secret");

    expect(
      decodeRealtimeCursor(signedWithPreviousKey, {
        current: "new-secret",
        previous: ["old-secret"],
      }),
    ).toEqual(cursor);
    expect(
      decodeRealtimeCursor(signedWithPreviousKey, {
        current: "new-secret",
        previous: [],
      }),
    ).toEqual({});
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

  it("inspects normalization changes without authorizing topics", () => {
    expect(
      inspectRealtimeTopicNormalization([" public:market ", "public:market", "", "item:item_1"]),
    ).toMatchObject({
      requestedCount: 4,
      normalizedCount: 2,
      duplicateCount: 1,
      blankCount: 1,
      invalidCount: 0,
    });
  });

  it("matches internal exact and prefix topic patterns", () => {
    expect(matchesRealtimeTopicPattern("item:item_1", "item:*")).toBe(true);
    expect(matchesRealtimeTopicPattern("account:account_1:offers", "account:*")).toBe(true);
    expect(matchesRealtimeTopicPattern("listing:list_1", "listing:list_1")).toBe(true);
    expect(matchesRealtimeTopicPattern("public-account:account_1", "item:*")).toBe(false);
  });
});

describe("realtime store topic ownership", () => {
  it("filters context stores to the topic families they own", () => {
    const discoveryStore = {
      contextName: "discovery",
      db: { query: async () => ({ rows: [] }) },
      exactTopics: ["public:market"],
      topicPrefixes: ["item:", "listing:", "public-account:"],
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
    expect(realtimeOutboxSchemaSql).toContain("realtime_projection_topic_heads");
    expect(realtimeOutboxSchemaSql).toContain("payload_json text NOT NULL");
    expect(realtimeOutboxSchemaSql).not.toContain("payload jsonb NOT NULL");
    expect(realtimeOutboxSchemaSql).toContain("payload_context text NOT NULL");
    expect(realtimeOutboxSchemaSql).toContain("payload_projection text NOT NULL");
    expect(realtimeOutboxSchemaSql).toContain("payload_kind text NOT NULL");
    expect(realtimeOutboxSchemaSql).toContain("payload_bytes integer NOT NULL");
  });

  it("exposes partition maintenance metadata for time-bucketed outbox retention", () => {
    expect(realtimeOutboxPartitionMaintenanceSql).toContain(
      "realtime_projection_outbox_partitions",
    );
    expect(createRealtimeOutboxPartitionName("2026_05_02"))
      .toBe("realtime_projection_outbox_2026_05_02");
    expect(() => createRealtimeOutboxPartitionName("2026-05-02")).toThrow("YYYY_MM_DD");
  });

  it("maintains outbox partition metadata windows", async () => {
    const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const db = {
      query: async (sql: string, params?: unknown[]) => {
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
    const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const db = {
      query: async (sql: string, params?: unknown[]) => {
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

    expect(calls[0].sql).toContain("ON CONFLICT");
    expect(calls[0].sql).toContain("RETURNING outbox_id");
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
      "projection.patch",
      "discovery",
      expect.any(Number),
    ]);
    expect(calls[1].sql).toContain("DELETE FROM realtime_projection_outbox_topics");
    expect(calls[1].params).toEqual(["42"]);
    expect(calls[2].sql).toContain("DELETE FROM realtime_projection_topic_heads");
    expect(calls[2].params).toEqual(["42", ["listing:list_1", "public:market"]]);
    expect(calls[3].sql).toContain("INSERT INTO realtime_projection_outbox_topics");
    expect(calls[3].params).toEqual(["42", ["listing:list_1", "public:market"]]);
    expect(calls[4].sql).toContain("INSERT INTO realtime_projection_topic_heads");
    expect(calls[4].params).toEqual([
      "42",
      ["listing:list_1", "public:market"],
      "2026-04-28T00:00:00.000Z",
    ]);
    expect(calls[5].sql).toContain("pg_notify");
    expect(calls[5].params).toEqual([
      realtimeProjectionNotifyChannel,
      "discovery",
      "discovery-market",
      ["listing:list_1", "public:market"],
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
      query: async (sql: string, params?: unknown[]) => {
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
    expect(result.topicLags).toEqual([
      { contextName: "discovery", topic: "public:market", lag: 0 },
    ]);
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

        if (sql.includes("SELECT outbox.outbox_id AS outbox_id, outbox.payload")) {
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

  it("coalesces concurrent identical replay reads through the process-local read hub", async () => {
    let outboxReadCount = 0;
    const observed: string[] = [];
    const db = {
      query: async (sql: string) => {
        if (sql.includes("DELETE FROM realtime_projection_outbox")) {
          return { rows: [] };
        }

        if (sql.includes("SELECT outbox.outbox_id AS outbox_id, outbox.payload")) {
          outboxReadCount += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
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

    await Promise.all([
      hub.read([{ contextName: "discovery", db }], ["public:market"], {}, 100),
      hub.read([{ contextName: "discovery", db }], ["public:market"], {}, 100),
    ]);

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
    expect(resolveRealtimeRouteConfig({ routeTuning: { batchSize: 25 } }))
      .toMatchObject({
        batchSize: 25,
        resourceLimits: {
          maxTopicsPerStream: 16,
          maxActiveStreams: 1_000,
        },
      });
    expect(() => resolveRealtimeRouteConfig({ routeTuning: { batchSize: 0 } }))
      .toThrow("batchSize");
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
        if (sql.includes("SELECT") && sql.includes("active_count")) {
          return { rows: [{ active_count: "1", connection_count: "0" }], rowCount: 1 };
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
      pool,
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
    expect(statements.some((sql) => sql.includes("INSERT INTO platform_realtime_stream_leases"))).toBe(true);
    expect(statements.some((sql) => sql.includes("DELETE FROM platform_realtime_stream_leases WHERE lease_id"))).toBe(true);
  });

  it("exercises a synthetic multi-instance stream-limit load harness", async () => {
    let active = 0;
    const activeByConnectionKey = new Map<string, number>();
    const client = {
      eval: async (_script: string, options: { keys: readonly string[]; arguments: readonly string[] }) => {
        const connectionKey = options.keys[1] ?? "";
        if (options.arguments.length === 0) {
          active = Math.max(0, active - 1);
          activeByConnectionKey.set(
            connectionKey,
            Math.max(0, (activeByConnectionKey.get(connectionKey) ?? 1) - 1),
          );
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
      idleCount: 1,
      totalCount: 1,
      waitingCount: 0,
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
    expect(statements.filter((sql) => sql.includes("INSERT INTO realtime_projection_outbox (")))
      .toHaveLength(2);
    expect(statements.at(-2)).toBe("COMMIT");
    expect(statements.at(-1)).toBe("release");
  });

  it("exposes a Postgres notification wake signal for low-latency polling", async () => {
    const listeners = new Set<(message: { channel: string; payload?: string }) => void>();
    const queries: string[] = [];
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [] };
      },
      on: (_event: "notification", listener: (message: { channel: string; payload?: string }) => void) => {
        listeners.add(listener);
      },
      off: (_event: "notification", listener: (message: { channel: string; payload?: string }) => void) => {
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

  it("only wakes topic-aware Postgres waiters for intersecting notification topics", async () => {
    const listeners = new Set<(message: { channel: string; payload?: string }) => void>();
    const observed: unknown[] = [];
    const client = {
      query: async () => ({ rows: [] }),
      on: (_event: "notification", listener: (message: { channel: string; payload?: string }) => void) => {
        listeners.add(listener);
      },
      off: () => undefined,
    };
    const wakeSignal = await createPostgresRealtimeWakeSignal(client, {
      wakeNotificationReceived: (event) => observed.push(event),
    });
    const itemWake = wakeSignal.wait(60_000, ["item:item_1"]);
    const accountWake = wakeSignal.wait(5, ["public-account:account_1"]);

    for (const listener of listeners) {
      listener({
        channel: realtimeProjectionNotifyChannel,
        payload: JSON.stringify({ topics: ["item:item_1"] }),
      });
    }

    await expect(itemWake).resolves.toBe("notified");
    await expect(accountWake).resolves.toBe("timeout");
    await wakeSignal.stop?.();
    expect(observed).toEqual([
      {
        notificationTopics: ["item:item_1"],
        waiterCount: 2,
        matchedWaiterCount: 1,
      },
    ]);
  });
});
