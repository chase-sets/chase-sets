import { describe, expect, it } from "vitest";
import {
  authorizeRealtimeTopics,
  createRealtimeRoutes,
  decodeRealtimeCursor,
  encodeRealtimeCursor,
  inspectRealtimeTopicNormalization,
  matchesRealtimeTopicPattern,
  parseRealtimeTopics,
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
      authorizeRealtimeTopics(["public:market", "item:item_1", "listing:listing_1", "public-account:account_1"], null),
    ).toEqual(["item:item_1", "listing:listing_1", "public-account:account_1", "public:market"]);
  });

  it("allows signed-in account topics for the current account and permissions", () => {
    expect(authorizeRealtimeTopics(["account:account_1:listings", "account:account_1:offers"], actor)).toEqual([
      "account:account_1:listings",
      "account:account_1:offers",
    ]);
  });

  it("rejects anonymous account topics", () => {
    expect(authorizeRealtimeTopics(["account:account_1:listings"], null)).toBeNull();
  });

  it("rejects signed-in account topics without matching permissions", () => {
    expect(
      authorizeRealtimeTopics(["account:account_1:offers"], {
        ...actor,
        permissions: ["listings.view"],
      }),
    ).toBeNull();
  });

  it("rejects mixed unauthorized topics", () => {
    expect(authorizeRealtimeTopics(["public:market", "account:other_account:listings"], actor)).toBeNull();
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
  it("rejects new streams while the process is draining", async () => {
    const app = createRealtimeRoutes({
      stores: [{ contextName: "discovery", db: { query: async () => ({ rows: [] }) } }],
      resolveActor: async () => null,
      isDraining: () => true,
    });

    const response = await app.request("/public/events?topic=public%3Amarket");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "process_draining",
        message: "Process is draining for shutdown.",
      },
    });
  });

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

    const response = await app.request("/public/events?topic=public%3Amarket&topic=account%3Aaccount_1%3Aoffers");

    expect(response.status).toBe(403);
  });

  it("exposes public and account endpoint aliases with route-family guards", async () => {
    const app = createRealtimeRoutes({
      stores: [{ contextName: "discovery", db: { query: async () => ({ rows: [] }) } }],
      resolveActor: async () => actor,
    });

    await expect(app.request("/public/events?topic=account%3Aaccount_1%3Aoffers")).resolves.toHaveProperty(
      "status",
      403,
    );
    await expect(app.request("/account/events?topic=public%3Amarket")).resolves.toHaveProperty("status", 403);
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
    const queryParams: (readonly unknown[])[] = [];
    const sentMessages: unknown[] = [];
    const db = {
      query: async (sql: string, params?: readonly unknown[]) => {
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

    const text = await readSseTextUntil(reader!, (value) => value.includes("event: projection.patch"));
    abort.abort();
    await reader!.cancel();
    await reader!.closed.catch(() => undefined);

    expect(response.status).toBe(200);
    expect(queryParams).toContainEqual(["1", ["public:market"], 100]);
    expect(text).toContain(`id: ${encodeRealtimeCursor({ discovery: "2" })}`);
    expect(text).toContain("event: projection.patch");
    expect(text).toContain('"entity":"discovery.marketSummary"');
    expect(sentMessages).toEqual([
      expect.objectContaining({
        contextName: "discovery",
        payloadBytes: expect.any(Number),
      }),
    ]);
  });

  it("starts fresh subscriptions at the current context head instead of replaying retained history", async () => {
    const app = createRealtimeRoutes({
      stores: [
        {
          contextName: "discovery",
          db: {
            query: async (sql: string) => {
              if (sql.includes("COALESCE(MAX(outbox_id), 0)::text AS head")) {
                return { rows: [{ head: "42" }] };
              }

              return { rows: [] };
            },
          },
        },
      ],
      resolveActor: async () => null,
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
    });
    const abort = new AbortController();

    const response = await app.request("/public/events?topic=public%3Amarket", {
      signal: abort.signal,
    });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const text = await readSseTextUntil(reader!, (value) => value.includes("event: heartbeat"), 1);
    abort.abort();
    await reader!.cancel();

    expect(response.status).toBe(200);
    expect(text).toContain(`id: ${encodeRealtimeCursor({ discovery: "42" })}`);
  });

  it("treats malformed Last-Event-ID as an empty cursor", async () => {
    const queryParams: (readonly unknown[])[] = [];
    const db = {
      query: async (sql: string, params?: readonly unknown[]) => {
        if (params) {
          queryParams.push(params);
        }

        if (sql.includes("DELETE FROM realtime_projection_outbox")) {
          return { rows: [] };
        }

        if (sql.includes("COALESCE(MAX(outbox_id), 0)::text AS head")) {
          return { rows: [{ head: "0" }] };
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

    await readSseTextUntil(reader!, () =>
      queryParams.some((params) => JSON.stringify(params) === JSON.stringify(["0", ["public:market"], 100])),
    );
    abort.abort();
    await reader!.cancel();

    expect(response.status).toBe(200);
    expect(queryParams).toContainEqual(["0", ["public:market"], 100]);
  });

  it("applies per-topic-family replay budgets", async () => {
    const queryParams: (readonly unknown[])[] = [];
    const db = {
      query: async (sql: string, params?: readonly unknown[]) => {
        if (params) {
          queryParams.push(params);
        }

        if (sql.includes("DELETE FROM realtime_projection_outbox")) {
          return { rows: [] };
        }

        if (sql.includes("COALESCE(MAX(outbox_id), 0)::text AS head")) {
          return { rows: [{ head: "0" }] };
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
    await readSseTextUntil(reader!, () =>
      queryParams.some((params) => JSON.stringify(params) === JSON.stringify(["0", ["public:market"], 7])),
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

        if (sql.includes("COALESCE(MAX(outbox_id), 0)::text AS head")) {
          return { rows: [{ head: "0" }] };
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

    const text = await readSseTextUntil(reader!, (value) => value.includes("event: sync.required"));
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

        if (sql.includes("COALESCE(MAX(outbox_id), 0)::text AS head")) {
          return { rows: [{ head: "0" }] };
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
      headers: {
        "Last-Event-ID": encodeRealtimeCursor({ discovery: "0" }),
      },
      signal: abort.signal,
    });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const text = await readSseTextUntil(reader!, (value) => value.includes("event: sync.required"));
    await reader!.cancel();
    abort.abort();

    expect(response.status).toBe(200);
    expect(text).toContain("event: sync.required");
    expect(text).toContain('"reason":"replay-backpressure"');
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
    const params = new URLSearchParams("topic=public%3Amarket&topics=item%3Aone,item%3Atwo&topic=item%3Aone");

    expect(parseRealtimeTopics(params)).toEqual(["item:one", "item:two", "public:market"]);
  });

  it("inspects normalization changes without authorizing topics", () => {
    expect(inspectRealtimeTopicNormalization([" public:market ", "public:market", "", "item:item_1"])).toMatchObject({
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
      selectRealtimeStoresForTopics([discoveryStore, marketplaceStore], ["public:market", "item:item_1"]).map(
        (store) => store.contextName,
      ),
    ).toEqual(["discovery"]);
    expect(
      selectRealtimeStoresForTopics([discoveryStore, marketplaceStore], ["account:account_1:offers"]).map(
        (store) => store.contextName,
      ),
    ).toEqual(["marketplace"]);
  });
});
