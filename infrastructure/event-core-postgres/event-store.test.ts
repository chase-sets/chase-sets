import { describe, expect, it, vi } from "vitest";
import type { AppendToStreamInput } from "@chase-sets/event-core/storage";
import * as observability from "@chase-sets/observability";
import {
  DEFAULT_EVENT_STORE_WAKE_NOTIFICATION_CHANNEL,
  DEFAULT_EVENT_STORE_WAKE_NOTIFICATION_SOURCE,
  EVENT_STORE_MAX_PAYLOAD_BYTES,
  EVENT_STORE_READ_PAGE_SIZE_DEFAULT,
  EVENT_STORE_READ_PAGE_SIZE_LIMIT,
  EVENT_STORE_WAKE_NOTIFICATION_KIND,
  createPostgresEventStore,
  parseEventStoreWakeNotificationEnvelope,
  serializeEventStoreWakeNotificationEnvelope,
  type EventStoreWakeNotificationEnvelope,
} from "./event-store";
import { withPgTransaction, type PgTransactionalPool } from "./types";

const NOW = "2026-06-10T12:00:00.000Z" as const;

describe("postgres event store", () => {
  it("defaults readStream and readAll to the documented read page size", async () => {
    const { pool, calls } = createReadPool();
    const store = createPostgresEventStore({ pool });

    await expect(store.readStream({ streamId: "checkout.checkout-session-chk_01" as never })).resolves.toEqual([]);
    await expect(store.readAll()).resolves.toEqual([]);

    expect(calls).toHaveLength(2);
    expect(calls[0].params).toEqual(["checkout.checkout-session-chk_01", 1, EVENT_STORE_READ_PAGE_SIZE_DEFAULT]);
    expect(calls[1].params?.[calls[1].params.length - 1]).toBe(EVENT_STORE_READ_PAGE_SIZE_DEFAULT);
  });

  it("allows readStream and readAll page sizes at the 1 to 500 boundaries", async () => {
    const { pool, calls } = createReadPool();
    const store = createPostgresEventStore({ pool });

    await expect(
      store.readStream({ streamId: "checkout.checkout-session-chk_01" as never, limit: 1 }),
    ).resolves.toEqual([]);
    await expect(
      store.readStream({
        streamId: "checkout.checkout-session-chk_01" as never,
        limit: EVENT_STORE_READ_PAGE_SIZE_LIMIT,
      }),
    ).resolves.toEqual([]);
    await expect(store.readAll({ limit: 1 })).resolves.toEqual([]);
    await expect(store.readAll({ limit: EVENT_STORE_READ_PAGE_SIZE_LIMIT })).resolves.toEqual([]);

    expect(calls.map((call) => call.params?.[call.params.length - 1])).toEqual([
      1,
      EVENT_STORE_READ_PAGE_SIZE_LIMIT,
      1,
      EVENT_STORE_READ_PAGE_SIZE_LIMIT,
    ]);
  });

  it("rejects readStream and readAll page sizes outside 1 to 500 before querying Postgres", async () => {
    const { pool, calls } = createReadPool();
    const store = createPostgresEventStore({ pool });

    await expect(store.readStream({ streamId: "checkout.checkout-session-chk_01" as never, limit: 0 })).rejects.toThrow(
      "Event store read limit must be an integer between 1 and 500.",
    );
    await expect(
      store.readStream({
        streamId: "checkout.checkout-session-chk_01" as never,
        limit: EVENT_STORE_READ_PAGE_SIZE_LIMIT + 1,
      }),
    ).rejects.toThrow("Event store read limit must be an integer between 1 and 500.");
    await expect(store.readAll({ limit: 0 })).rejects.toThrow(
      "Event store read limit must be an integer between 1 and 500.",
    );
    await expect(store.readAll({ limit: EVENT_STORE_READ_PAGE_SIZE_LIMIT + 1 })).rejects.toThrow(
      "Event store read limit must be an integer between 1 and 500.",
    );

    expect(calls).toEqual([]);
  });

  it("rejects an oversized event payload with a typed error before opening a transaction", async () => {
    const { pool, calls } = createAppendPool();
    const store = createPostgresEventStore({ pool });

    await expect(
      store.appendToStream(
        appendInput({
          events: [
            {
              eventType: "checkout.session.created",
              payload: { content: "x".repeat(EVENT_STORE_MAX_PAYLOAD_BYTES) },
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({
      code: "payload_too_large",
      details: {
        eventType: "checkout.session.created",
        payloadBytes: EVENT_STORE_MAX_PAYLOAD_BYTES + 14,
        maxPayloadBytes: EVENT_STORE_MAX_PAYLOAD_BYTES,
      },
    });

    expect(calls).toEqual([]);
  });

  it("accepts an event payload exactly at the byte limit", async () => {
    const { pool, calls } = createAppendPool();
    const store = createPostgresEventStore({
      pool,
      now: () => NOW as never,
      createEventId: createSequentialEventId(),
    });

    await expect(
      store.appendToStream(
        appendInput({
          events: [
            {
              eventType: "checkout.session.created",
              payload: { content: "x".repeat(EVENT_STORE_MAX_PAYLOAD_BYTES - 14) },
            },
          ],
        }),
      ),
    ).resolves.toHaveLength(1);

    expect(calls.some((call) => call.sql.includes("INSERT INTO event_store_events"))).toBe(true);
  });

  it("rejects an oversized payload anywhere in a multi-stream append before persisting any stream", async () => {
    const { pool, calls } = createAppendPool();
    const store = createPostgresEventStore({ pool });

    await expect(
      store.appendToStreams!([
        appendInput(),
        appendInput({
          streamId: "checkout.checkout-session-chk_02",
          events: [
            {
              eventType: "checkout.session.created",
              payload: { content: "x".repeat(EVENT_STORE_MAX_PAYLOAD_BYTES) },
            },
          ],
        }),
      ]),
    ).rejects.toMatchObject({
      code: "payload_too_large",
      details: {
        eventType: "checkout.session.created",
        maxPayloadBytes: EVENT_STORE_MAX_PAYLOAD_BYTES,
      },
    });

    expect(calls).toEqual([]);
  });

  it("pushes readAll event type and stream prefix filters into SQL", async () => {
    const queries: { sql: string; params: readonly unknown[] }[] = [];
    const store = createPostgresEventStore({
      pool: {
        query: async (sql: string, params: readonly unknown[] = []) => {
          queries.push({ sql, params });
          return { rows: [] };
        },
      } as never,
    });

    await store.readAll({
      afterGlobalPosition: "42" as never,
      tenantId: "tenant_1" as never,
      eventTypes: ["catalog.catalog-item.published", "catalog.catalog-item.published"],
      streamPrefixes: ["catalog.item-", "catalog.category-"],
      limit: 25,
    });

    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("global_position > $1::bigint");
    expect(queries[0].sql).toContain("tenant_id = $2");
    expect(queries[0].sql).toContain("event_type = ANY($3::text[])");
    expect(queries[0].sql).toContain(
      "((stream_context_name = $4 AND stream_id LIKE $5 || '%' ESCAPE '\\') OR (stream_context_name = $6 AND stream_id LIKE $7 || '%' ESCAPE '\\'))",
    );
    expect(queries[0].sql).not.toContain("stream_category = ANY");
    expect(queries[0].sql).toContain("LIMIT $8");
    expect(queries[0].params).toEqual([
      "42",
      "tenant_1",
      ["catalog.catalog-item.published"],
      "catalog",
      "catalog.item-",
      "catalog",
      "catalog.category-",
      25,
    ]);
  });

  it("keeps mixed stream-prefix shapes local to each OR arm", async () => {
    const queries: { sql: string; params: readonly unknown[] }[] = [];
    const store = createPostgresEventStore({
      pool: {
        query: async (sql: string, params: readonly unknown[] = []) => {
          queries.push({ sql, params });
          return { rows: [] };
        },
      } as never,
    });

    await store.readAll({
      afterGlobalPosition: "10" as never,
      eventTypes: ["identity.account.created"],
      streamPrefixes: ["marketplace.review-", "identity."],
      limit: 50,
    });

    expect(queries[0].sql).toContain(
      "((stream_context_name = $3 AND stream_id LIKE $4 || '%' ESCAPE '\\') OR (stream_context_name = $5 AND stream_id LIKE $6 || '%' ESCAPE '\\'))",
    );
    expect(queries[0].sql).not.toContain("stream_category = ANY");
    expect(queries[0].params).toEqual([
      "10",
      ["identity.account.created"],
      "marketplace",
      "marketplace.review-",
      "identity",
      "identity.",
      50,
    ]);
  });

  it("escapes readAll stream prefix metacharacters before the trailing prefix wildcard", async () => {
    const queries: { sql: string; params: readonly unknown[] }[] = [];
    const store = createPostgresEventStore({
      pool: {
        query: async (sql: string, params: readonly unknown[] = []) => {
          queries.push({ sql, params });
          return { rows: [] };
        },
      } as never,
    });

    await store.readAll({
      streamPrefixes: ["catalog.item_%"],
      limit: 5,
    });

    expect(queries[0].sql).toContain("stream_id LIKE $3 || '%' ESCAPE '\\'");
    expect(queries[0].params).toEqual(["0", "catalog", "catalog.item\\_\\%", 5]);
  });

  it("emits a versioned event-store wake notification only after append commit when enabled", async () => {
    const { pool, calls } = createAppendPool({ globalPositions: ["101", "102"] });
    const emitted: unknown[] = [];
    const store = createPostgresEventStore({
      pool,
      now: () => NOW as never,
      createEventId: createSequentialEventId(),
      wakeNotifications: {
        enabled: true,
        observer: {
          notificationEmitted: (event) => emitted.push(event),
        },
      },
    });

    await expect(
      store.appendToStream(
        appendInput({
          events: [
            {
              eventType: "checkout.session.created",
              payload: {
                guestEmail: "todd.skelton@outlook.com",
                paymentIntentId: "pi_secret",
              },
              metadata: {
                rawPayload: "provider-private-payload",
              },
            },
            {
              eventType: "checkout.session.guest-attached",
              payload: {
                actor: "guest",
              },
            },
          ],
        }),
      ),
    ).resolves.toHaveLength(2);

    const commitIndex = calls.findIndex((call) => call.sql === "COMMIT");
    const notifyIndex = calls.findIndex((call) => call.sql === "SELECT pg_notify($1, $2)");
    expect(commitIndex).toBeGreaterThanOrEqual(0);
    expect(notifyIndex).toBeGreaterThan(commitIndex);
    expect(calls[notifyIndex].params?.[0]).toBe(DEFAULT_EVENT_STORE_WAKE_NOTIFICATION_CHANNEL);

    const serialized = String(calls[notifyIndex].params?.[1]);
    const envelope = parseEventStoreWakeNotificationEnvelope(serialized);
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      payloadVersion: 1,
      kind: EVENT_STORE_WAKE_NOTIFICATION_KIND,
      source: DEFAULT_EVENT_STORE_WAKE_NOTIFICATION_SOURCE,
      emittedAt: NOW,
      correlationId: "trace_1",
      payload: {
        sourceContextName: "checkout",
        streamCategory: "checkout.checkout-session",
        firstGlobalPosition: "101",
        lastGlobalPosition: "102",
        eventCount: 2,
        eventTypes: ["checkout.session.created", "checkout.session.guest-attached"],
      },
    });
    expect(serialized).not.toContain("todd.skelton");
    expect(serialized).not.toContain("paymentIntentId");
    expect(serialized).not.toContain("rawPayload");
    expect(serialized).not.toContain("tenant_1");
    expect(serialized).not.toContain("user_1");
    expect(serialized).not.toContain("account_1");
    expect(serialized).not.toContain("chk_01");
    expect(emitted[0]).toMatchObject({
      channel: DEFAULT_EVENT_STORE_WAKE_NOTIFICATION_CHANNEL,
      sourceContextName: "checkout",
      lastGlobalPosition: "102",
      emittedAt: NOW,
      correlationId: "trace_1",
    });
  });

  it("does not emit event-store wake notifications by default or when explicitly disabled", async () => {
    const defaultPool = createAppendPool();
    const defaultStore = createPostgresEventStore({
      pool: defaultPool.pool,
      now: () => NOW as never,
      createEventId: createSequentialEventId(),
    });

    await defaultStore.appendToStream(appendInput());

    const disabledPool = createAppendPool();
    const disabledStore = createPostgresEventStore({
      pool: disabledPool.pool,
      now: () => NOW as never,
      createEventId: createSequentialEventId(),
      wakeNotifications: {
        enabled: false,
      },
    });

    await disabledStore.appendToStream(appendInput());

    expect(defaultPool.calls.some((call) => call.sql === "SELECT pg_notify($1, $2)")).toBe(false);
    expect(disabledPool.calls.some((call) => call.sql === "SELECT pg_notify($1, $2)")).toBe(false);
  });

  it("uses one event INSERT statement for appends of any event count", async () => {
    const singleEventCalls = await appendAndCaptureQueries(1);
    const multiEventCalls = await appendAndCaptureQueries(5);
    const singleEventInserts = singleEventCalls.filter(isEventInsertCall);
    const multiEventInserts = multiEventCalls.filter(isEventInsertCall);

    expect(singleEventCalls).toHaveLength(multiEventCalls.length);
    expect(singleEventInserts).toHaveLength(1);
    expect(multiEventInserts).toHaveLength(1);
    expect(singleEventInserts[0].params).toHaveLength(17);
    expect(multiEventInserts[0].params).toHaveLength(17 * 5);
    expect(multiEventInserts[0].sql).toContain("($1, $2, $3");
    expect(multiEventInserts[0].sql).toContain("($69, $70, $71");
  });

  it("does not emit an event-store wake notification when append rolls back", async () => {
    const { pool, calls } = createAppendPool({ currentVersion: 1 });
    const store = createPostgresEventStore({
      pool,
      now: () => NOW as never,
      createEventId: createSequentialEventId(),
      wakeNotifications: {
        enabled: true,
      },
    });

    await expect(store.appendToStream(appendInput())).rejects.toMatchObject({
      code: "concurrency_conflict",
    });

    expect(calls.map((call) => call.sql)).toContain("ROLLBACK");
    expect(calls.map((call) => call.sql)).not.toContain("COMMIT");
    expect(calls.some((call) => call.sql === "SELECT pg_notify($1, $2)")).toBe(false);
  });

  it.each([
    ["40001", "serialization_failure"],
    ["40P01", "deadlock_detected"],
  ])("maps Postgres %s %s to a retryable concurrency conflict", async (postgresCode) => {
    const { pool, calls } = createAppendPool({ failInsertWithPostgresCode: postgresCode });
    const store = createPostgresEventStore({
      pool,
      now: () => NOW as never,
      createEventId: createSequentialEventId(),
    });

    await expect(store.appendToStream(appendInput())).rejects.toMatchObject({
      code: "concurrency_conflict",
      details: {
        postgresCode,
      },
    });

    expect(calls.map((call) => call.sql)).toContain("ROLLBACK");
    expect(calls.map((call) => call.sql)).not.toContain("COMMIT");
  });

  it("keeps the committed append successful when the post-commit notification fails", async () => {
    const { pool, calls } = createAppendPool({ failNotify: true, globalPositions: ["501"] });
    const failed: unknown[] = [];
    const store = createPostgresEventStore({
      pool,
      now: () => NOW as never,
      createEventId: createSequentialEventId(),
      wakeNotifications: {
        enabled: true,
        observer: {
          notificationFailed: (event) => failed.push(event),
        },
      },
    });

    await expect(store.appendToStream(appendInput())).resolves.toHaveLength(1);

    expect(calls.map((call) => call.sql)).toContain("COMMIT");
    expect(calls.map((call) => call.sql)).not.toContain("ROLLBACK");
    expect(failed[0]).toMatchObject({
      channel: DEFAULT_EVENT_STORE_WAKE_NOTIFICATION_CHANNEL,
      sourceContextName: "checkout",
      streamCategory: "checkout.checkout-session",
      firstGlobalPosition: "501",
      lastGlobalPosition: "501",
      eventCount: 1,
      correlationId: "trace_1",
    });
  });

  it("keeps the committed append successful when wake notification observers throw", async () => {
    const observerFailure = new Error("observer failed");
    const emitted = createPostgresEventStore({
      pool: createAppendPool({ globalPositions: ["501"] }).pool,
      now: () => NOW as never,
      createEventId: createSequentialEventId(),
      wakeNotifications: {
        enabled: true,
        observer: {
          notificationEmitted: () => {
            throw observerFailure;
          },
        },
      },
    });
    const failed = createPostgresEventStore({
      pool: createAppendPool({ failNotify: true, globalPositions: ["502"] }).pool,
      now: () => NOW as never,
      createEventId: createSequentialEventId(),
      wakeNotifications: {
        enabled: true,
        observer: {
          notificationFailed: () => {
            throw observerFailure;
          },
        },
      },
    });
    const rejected = createPostgresEventStore({
      pool: createAppendPool({ globalPositions: ["503"] }).pool,
      now: () => NOW as never,
      createEventId: createSequentialEventId(),
      wakeNotifications: {
        enabled: true,
        maxPayloadBytes: 1,
        observer: {
          payloadRejected: () => {
            throw observerFailure;
          },
        },
      },
    });

    await expect(emitted.appendToStream(appendInput())).resolves.toHaveLength(1);
    await expect(failed.appendToStream(appendInput())).resolves.toHaveLength(1);
    await expect(rejected.appendToStream(appendInput())).resolves.toHaveLength(1);
  });

  it("rejects sensitive or oversized event-store wake notification envelopes", () => {
    const envelope = eventStoreWakeEnvelope();

    expect(() =>
      serializeEventStoreWakeNotificationEnvelope({
        ...envelope,
        payload: {
          ...envelope.payload,
          guestEmail: "buyer@example.com",
        } as never,
      }),
    ).toThrow(/sensitive payload key/);

    expect(() =>
      serializeEventStoreWakeNotificationEnvelope(
        {
          ...envelope,
          payload: {
            ...envelope.payload,
            eventTypes: ["checkout.session.created", "x".repeat(200)],
          },
        },
        { maxPayloadBytes: 50 },
      ),
    ).toThrow(/exceeds the 50 byte limit/);

    expect(
      parseEventStoreWakeNotificationEnvelope(
        JSON.stringify({
          ...envelope,
          payloadVersion: 2,
          payload: {
            ...envelope.payload,
            additiveRoutingHint: "safe-over-wake-only",
          },
          additiveEnvelopeHint: "ignored-by-current-relay",
        }),
      ),
    ).toMatchObject({
      payloadVersion: 2,
      payload: {
        sourceContextName: "checkout",
        lastGlobalPosition: "1",
      },
    });

    expect(
      parseEventStoreWakeNotificationEnvelope(
        JSON.stringify({
          ...envelope,
          payloadVersion: 0,
        }),
      ),
    ).toBeNull();
  });
});

describe("postgres event store independent multi-stream appends", () => {
  it("isolates a per-stream version conflict without rolling back sibling streams", async () => {
    const { pool, calls } = createIndependentAppendPool({ versions: { "marketplace.listing-conflict": 3 } });
    const store = createPostgresEventStore({
      pool,
      now: () => NOW as never,
      createEventId: createSequentialEventId(),
    });

    const results = await store.appendToStreamsIndependently!([
      independentInput({
        streamId: "marketplace.listing-conflict",
        expectedVersion: 1, // stale -- real current version is 3
      }),
      independentInput({ streamId: "marketplace.listing-ok", expectedVersion: "no_stream" }),
    ]);

    expect(results).toMatchObject([
      {
        streamId: "marketplace.listing-conflict",
        outcome: "conflict",
        storedEvents: [],
        error: { code: "concurrency_conflict" },
      },
      { streamId: "marketplace.listing-ok", outcome: "appended" },
    ]);
    expect(results[1]?.storedEvents).toHaveLength(1);

    // The whole chunk committed -- a conflict on one stream never rolls back another.
    expect(calls.map((call) => call.sql)).toContain("COMMIT");
    expect(calls.map((call) => call.sql)).not.toContain("ROLLBACK");
    expect(calls.filter(isEventInsertCall)).toHaveLength(1);
  });

  it("uses exactly one multi-row INSERT across every stream in an independent batch", async () => {
    const { pool, calls } = createIndependentAppendPool();
    const store = createPostgresEventStore({
      pool,
      now: () => NOW as never,
      createEventId: createSequentialEventId(),
    });

    const results = await store.appendToStreamsIndependently!([
      independentInput({ streamId: "marketplace.listing-a", expectedVersion: "no_stream" }),
      independentInput({ streamId: "marketplace.listing-b", expectedVersion: "no_stream" }),
      independentInput({ streamId: "marketplace.listing-c", expectedVersion: "no_stream" }),
    ]);

    const inserts = calls.filter(isEventInsertCall);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params).toHaveLength(17 * 3);
    expect(results.every((result) => result.outcome === "appended")).toBe(true);
    expect(results.map((result) => result.streamId)).toEqual([
      "marketplace.listing-a",
      "marketplace.listing-b",
      "marketplace.listing-c",
    ]);
  });

  it("returns no_op for zero-event inputs without touching the database, alongside real appends", async () => {
    const { pool, calls } = createIndependentAppendPool();
    const store = createPostgresEventStore({
      pool,
      now: () => NOW as never,
      createEventId: createSequentialEventId(),
    });

    const results = await store.appendToStreamsIndependently!([
      independentInput({ streamId: "marketplace.listing-noop", expectedVersion: "no_stream", events: [] }),
      independentInput({ streamId: "marketplace.listing-real", expectedVersion: "no_stream" }),
    ]);

    expect(results).toMatchObject([
      { streamId: "marketplace.listing-noop", outcome: "no_op", storedEvents: [] },
      { streamId: "marketplace.listing-real", outcome: "appended" },
    ]);
    expect(calls.some((call) => call.params?.includes("marketplace.listing-noop"))).toBe(false);
  });

  it("produces events identical in shape to a single-stream append", async () => {
    const singlePool = createIndependentAppendPool();
    const singleStore = createPostgresEventStore({
      pool: singlePool.pool,
      now: () => NOW as never,
      createEventId: createSequentialEventId(),
    });
    const [single] = await singleStore.appendToStream(
      appendInput({ streamId: "marketplace.listing-shape", expectedVersion: "no_stream" }),
    );

    const independentPool = createIndependentAppendPool();
    const independentStore = createPostgresEventStore({
      pool: independentPool.pool,
      now: () => NOW as never,
      createEventId: createSequentialEventId(),
    });
    const [independentResult] = await independentStore.appendToStreamsIndependently!([
      independentInput({ streamId: "marketplace.listing-shape", expectedVersion: "no_stream" }),
    ]);

    expect(independentResult.storedEvents[0]).toEqual(single);
  });

  it("records an advisory-lock hold sample only when a lock was actually acquired", async () => {
    const recordSpy = vi.spyOn(observability, "recordEventStoreAppendAdvisoryLockHold");
    recordSpy.mockClear();

    const noopPool = createIndependentAppendPool();
    const noopStore = createPostgresEventStore({ pool: noopPool.pool, createEventId: createSequentialEventId() });
    await noopStore.appendToStreamsIndependently!([independentInput({ events: [] })]);
    expect(recordSpy).not.toHaveBeenCalled();

    const appendPool = createIndependentAppendPool();
    const appendStore = createPostgresEventStore({ pool: appendPool.pool, createEventId: createSequentialEventId() });
    await appendStore.appendToStreamsIndependently!(
      [independentInput({ streamId: "marketplace.listing-telemetry", expectedVersion: "no_stream" })],
      { telemetry: { holderKind: "bulk_chunk_append", sourceContextName: "marketplace" } },
    );

    expect(recordSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "committed",
        holderKind: "bulk_chunk_append",
        sourceContextName: "marketplace",
      }),
    );

    recordSpy.mockRestore();
  });

  it("rejects a batch that repeats the same stream id more than once", async () => {
    const { pool } = createIndependentAppendPool();
    const store = createPostgresEventStore({ pool, createEventId: createSequentialEventId() });

    await expect(
      store.appendToStreamsIndependently!([
        independentInput({ streamId: "marketplace.listing-dup", expectedVersion: "no_stream" }),
        independentInput({ streamId: "marketplace.listing-dup", expectedVersion: "no_stream" }),
      ]),
    ).rejects.toThrow("does not support the same stream id more than once");
  });
});

describe("postgres transaction helper", () => {
  it("commits successful work and releases the client", async () => {
    const queries: string[] = [];
    const releaseErrors: unknown[] = [];
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [], rowCount: 0 };
      },
      release: (error?: unknown) => {
        releaseErrors.push(error);
      },
    };

    await expect(
      withPgTransaction(
        {
          query: client.query,
          connect: async () => client,
        },
        async (tx) => {
          await tx.query("SELECT 1");
          return "ok";
        },
      ),
    ).resolves.toBe("ok");

    expect(queries).toEqual(["BEGIN", "SELECT 1", "COMMIT"]);
    expect(releaseErrors).toEqual([undefined]);
  });

  it("sets transaction-local idle-in-transaction timeout when the pool is configured", async () => {
    const queries: QueryCall[] = [];
    const releaseErrors: unknown[] = [];
    const client = {
      query: async (sql: string, params?: readonly unknown[]) => {
        queries.push({ sql: sql.trim(), ...(params ? { params } : {}) });
        return { rows: [], rowCount: 0 };
      },
      release: (error?: unknown) => {
        releaseErrors.push(error);
      },
    };

    await expect(
      withPgTransaction(
        {
          query: client.query,
          connect: async () => client,
          idleInTransactionSessionTimeoutMillis: 15_000,
        },
        async (tx) => {
          await tx.query("SELECT 1");
          return "ok";
        },
      ),
    ).resolves.toBe("ok");

    expect(queries).toEqual([
      { sql: "BEGIN" },
      { sql: "SELECT set_config('idle_in_transaction_session_timeout', $1, true)", params: ["15000ms"] },
      { sql: "SELECT 1" },
      { sql: "COMMIT" },
    ]);
    expect(releaseErrors).toEqual([undefined]);
  });

  it("rolls back failed work and keeps the client reusable", async () => {
    const queries: string[] = [];
    const releaseErrors: unknown[] = [];
    const failure = new Error("boom");
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [], rowCount: 0 };
      },
      release: (error?: unknown) => {
        releaseErrors.push(error);
      },
    };

    await expect(
      withPgTransaction(
        {
          query: client.query,
          connect: async () => client,
        },
        async () => {
          throw failure;
        },
      ),
    ).rejects.toThrow("boom");

    expect(queries).toEqual(["BEGIN", "ROLLBACK"]);
    expect(releaseErrors).toEqual([undefined]);
  });

  it("preserves the original work error and destroys the client when rollback also fails", async () => {
    const queries: string[] = [];
    const releaseErrors: unknown[] = [];
    const failure = new Error("boom");
    const rollbackFailure = new Error("rollback failed");
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql === "ROLLBACK") {
          throw rollbackFailure;
        }
        return { rows: [], rowCount: 0 };
      },
      release: (error?: unknown) => {
        releaseErrors.push(error);
      },
    };

    await expect(
      withPgTransaction(
        {
          query: client.query,
          connect: async () => client,
        },
        async () => {
          throw failure;
        },
      ),
    ).rejects.toThrow("boom");

    expect(queries).toEqual(["BEGIN", "ROLLBACK"]);
    expect(releaseErrors).toEqual([rollbackFailure]);
  });

  it("destroys the client when failed work reports a connection-level error", async () => {
    const queries: string[] = [];
    const releaseErrors: unknown[] = [];
    const failure = Object.assign(new Error("connection terminated unexpectedly"), { code: "ECONNRESET" });
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [], rowCount: 0 };
      },
      release: (error?: unknown) => {
        releaseErrors.push(error);
      },
    };

    await expect(
      withPgTransaction(
        {
          query: client.query,
          connect: async () => client,
        },
        async () => {
          throw failure;
        },
      ),
    ).rejects.toThrow("connection terminated unexpectedly");

    expect(queries).toEqual(["BEGIN", "ROLLBACK"]);
    expect(releaseErrors).toEqual([failure]);
  });

  it("runs afterCommit after committing and before releasing the client", async () => {
    const queries: string[] = [];
    const releaseErrors: unknown[] = [];
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [], rowCount: 0 };
      },
      release: (error?: unknown) => {
        releaseErrors.push(error);
        queries.push("RELEASE");
      },
    };

    await expect(
      withPgTransaction(
        {
          query: client.query,
          connect: async () => client,
        },
        async () => "ok",
        {
          afterCommit: async (tx, result) => {
            await tx.query(`AFTER ${result}`);
          },
        },
      ),
    ).resolves.toBe("ok");

    expect(queries).toEqual(["BEGIN", "COMMIT", "AFTER ok", "RELEASE"]);
    expect(releaseErrors).toEqual([undefined]);
  });
});

type QueryCall = Readonly<{
  sql: string;
  params?: readonly unknown[];
}>;

async function appendAndCaptureQueries(eventCount: number): Promise<readonly QueryCall[]> {
  const { pool, calls } = createAppendPool();
  const store = createPostgresEventStore({
    pool,
    now: () => NOW as never,
    createEventId: createSequentialEventId(),
  });

  await store.appendToStream(
    appendInput({
      events: Array.from({ length: eventCount }, (_, index) => ({
        eventType: `checkout.session.step-${index + 1}`,
        payload: { step: index + 1 },
      })),
    }),
  );

  return calls;
}

function isEventInsertCall(call: QueryCall): boolean {
  return call.sql.includes("INSERT INTO event_store_events");
}

function createReadPool(): Readonly<{ pool: PgTransactionalPool; calls: QueryCall[] }> {
  const calls: QueryCall[] = [];

  return {
    pool: {
      query: async (sql: string, params?: readonly unknown[]) => {
        calls.push({ sql: sql.trim(), ...(params ? { params } : {}) });
        return { rows: [], rowCount: 0 };
      },
      connect: async () => {
        throw new Error("read tests should not open transactions");
      },
    },
    calls,
  };
}

function createAppendPool(
  options: Readonly<{
    currentVersion?: number;
    failInsertWithPostgresCode?: string;
    failNotify?: boolean;
    globalPositions?: readonly string[];
  }> = {},
): Readonly<{ pool: PgTransactionalPool; calls: QueryCall[] }> {
  const calls: QueryCall[] = [];
  let insertCount = 0;

  const client = {
    query: async (sql: string, params?: readonly unknown[]) => {
      const normalizedSql = sql.trim();
      calls.push({ sql: normalizedSql, ...(params ? { params } : {}) });

      if (normalizedSql === "BEGIN" || normalizedSql === "COMMIT" || normalizedSql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }

      if (normalizedSql === "SELECT pg_notify($1, $2)") {
        if (options.failNotify) {
          throw new Error("notify unavailable");
        }
        return { rows: [], rowCount: 1 };
      }

      if (normalizedSql.includes("SELECT current_version")) {
        return { rows: [{ current_version: options.currentVersion ?? 0 }], rowCount: 1 };
      }

      if (normalizedSql.includes("WHERE event_id = ANY")) {
        return { rows: [], rowCount: 0 };
      }

      if (normalizedSql.includes("RETURNING")) {
        if (options.failInsertWithPostgresCode) {
          throw Object.assign(new Error("simulated postgres append conflict"), {
            code: options.failInsertWithPostgresCode,
          });
        }

        const values = params ?? [];
        const rowWidth = 17;
        const rows = [];
        for (let offset = 0; offset < values.length; offset += rowWidth) {
          const globalPosition = options.globalPositions?.[insertCount] ?? String(insertCount + 1);
          insertCount += 1;
          rows.push({
            event_id: values[offset],
            stream_id: values[offset + 1],
            stream_version: values[offset + 2],
            global_position: globalPosition,
            tenant_id: values[offset + 3],
            stream_context_name: values[offset + 4],
            stream_category: values[offset + 5],
            event_type: values[offset + 6],
            payload: values[offset + 7],
            metadata: values[offset + 8],
            occurred_at: values[offset + 9],
            recorded_at: values[offset + 10],
            performed_by_user_id: values[offset + 11],
            for_account_id: values[offset + 12],
            trace_id: values[offset + 13] ?? null,
            span_id: values[offset + 14] ?? null,
            parent_span_id: values[offset + 15] ?? null,
            trace_state: values[offset + 16] ?? null,
          });
        }
        return {
          rows,
          rowCount: rows.length,
        };
      }

      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };

  return {
    pool: {
      query: client.query,
      connect: async () => client,
    },
    calls,
  };
}

function createIndependentAppendPool(
  options: Readonly<{ versions?: Readonly<Record<string, number>> }> = {},
): Readonly<{ pool: PgTransactionalPool; calls: QueryCall[] }> {
  const calls: QueryCall[] = [];
  let insertCount = 0;

  const client = {
    query: async (sql: string, params?: readonly unknown[]) => {
      const normalizedSql = sql.trim();
      calls.push({ sql: normalizedSql, ...(params ? { params } : {}) });

      if (normalizedSql === "BEGIN" || normalizedSql === "COMMIT" || normalizedSql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }

      if (normalizedSql === "SELECT pg_notify($1, $2)") {
        return { rows: [], rowCount: 1 };
      }

      if (normalizedSql.includes("SELECT current_version")) {
        const streamId = String(params?.[0]);
        return { rows: [{ current_version: options.versions?.[streamId] ?? 0 }], rowCount: 1 };
      }

      if (normalizedSql.includes("WHERE event_id = ANY")) {
        return { rows: [], rowCount: 0 };
      }

      if (normalizedSql.includes("RETURNING")) {
        const values = params ?? [];
        const rowWidth = 17;
        const rows = [];
        for (let offset = 0; offset < values.length; offset += rowWidth) {
          const globalPosition = String(insertCount + 1);
          insertCount += 1;
          rows.push({
            event_id: values[offset],
            stream_id: values[offset + 1],
            stream_version: values[offset + 2],
            global_position: globalPosition,
            tenant_id: values[offset + 3],
            stream_context_name: values[offset + 4],
            stream_category: values[offset + 5],
            event_type: values[offset + 6],
            payload: values[offset + 7],
            metadata: values[offset + 8],
            occurred_at: values[offset + 9],
            recorded_at: values[offset + 10],
            performed_by_user_id: values[offset + 11],
            for_account_id: values[offset + 12],
            trace_id: values[offset + 13] ?? null,
            span_id: values[offset + 14] ?? null,
            parent_span_id: values[offset + 15] ?? null,
            trace_state: values[offset + 16] ?? null,
          });
        }
        return { rows, rowCount: rows.length };
      }

      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };

  return {
    pool: {
      query: client.query,
      connect: async () => client,
    },
    calls,
  };
}

function independentInput(overrides: Partial<AppendToStreamInput> = {}): AppendToStreamInput {
  return appendInput(overrides);
}

function appendInput(overrides: Partial<AppendToStreamInput> = {}): AppendToStreamInput {
  return {
    streamId: "checkout.checkout-session-chk_01",
    expectedVersion: "no_stream",
    events: [
      {
        eventType: "checkout.session.created",
        payload: {
          guestEmail: "todd.skelton@outlook.com",
        },
      },
    ],
    context: {
      tenantId: "tenant_1" as never,
      audit: {
        performedByUserId: "user_1" as never,
        forAccountId: "account_1" as never,
      },
      trace: {
        traceId: "trace_1" as never,
      },
    },
    ...overrides,
  };
}

function createSequentialEventId(): () => never {
  let next = 1;
  return () => `evt_${next++}` as never;
}

function eventStoreWakeEnvelope(
  overrides: Partial<EventStoreWakeNotificationEnvelope> = {},
): EventStoreWakeNotificationEnvelope {
  return {
    schemaVersion: 1,
    payloadVersion: 1,
    kind: EVENT_STORE_WAKE_NOTIFICATION_KIND,
    source: DEFAULT_EVENT_STORE_WAKE_NOTIFICATION_SOURCE,
    emittedAt: NOW as never,
    correlationId: "trace_1",
    payload: {
      sourceContextName: "checkout",
      streamCategory: "checkout.checkout-session",
      firstGlobalPosition: "1" as never,
      lastGlobalPosition: "1" as never,
      eventCount: 1,
      eventTypes: ["checkout.session.created"],
    },
    ...overrides,
  };
}
