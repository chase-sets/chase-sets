import { describe, expect, it } from "vitest";
import type { AppendToStreamInput } from "@chase-sets/event-core/storage";
import {
  DEFAULT_EVENT_STORE_WAKE_NOTIFICATION_CHANNEL,
  DEFAULT_EVENT_STORE_WAKE_NOTIFICATION_SOURCE,
  EVENT_STORE_WAKE_NOTIFICATION_KIND,
  createPostgresEventStore,
  parseEventStoreWakeNotificationEnvelope,
  serializeEventStoreWakeNotificationEnvelope,
  type EventStoreWakeNotificationEnvelope,
} from "./event-store";
import { withPgTransaction, type PgTransactionalPool } from "./types";

const NOW = "2026-06-10T12:00:00.000Z" as const;

describe("postgres event store", () => {
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
    expect(queries[0].sql).toContain("stream_context_name = ANY($4::text[])");
    expect(queries[0].sql).toContain("stream_category = ANY($5::text[])");
    expect(queries[0].sql).toContain("(stream_id LIKE $6 || '%' OR stream_id LIKE $7 || '%')");
    expect(queries[0].sql).toContain("LIMIT $8");
    expect(queries[0].params).toEqual([
      "42",
      "tenant_1",
      ["catalog.catalog-item.published"],
      ["catalog"],
      ["catalog.item", "catalog.category"],
      "catalog.item-",
      "catalog.category-",
      25,
    ]);
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
        }),
      ),
    ).toBeNull();
  });
});

describe("postgres transaction helper", () => {
  it("commits successful work and releases the client", async () => {
    const queries: string[] = [];
    let released = false;
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [], rowCount: 0 };
      },
      release: () => {
        released = true;
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
    expect(released).toBe(true);
  });

  it("rolls back failed work and releases the client", async () => {
    const queries: string[] = [];
    let released = false;
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [], rowCount: 0 };
      },
      release: () => {
        released = true;
      },
    };

    await expect(
      withPgTransaction(
        {
          query: client.query,
          connect: async () => client,
        },
        async () => {
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");

    expect(queries).toEqual(["BEGIN", "ROLLBACK"]);
    expect(released).toBe(true);
  });
});

type QueryCall = Readonly<{
  sql: string;
  params?: readonly unknown[];
}>;

function createAppendPool(
  options: Readonly<{
    currentVersion?: number;
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

      if (normalizedSql.includes("RETURNING")) {
        const values = params ?? [];
        const globalPosition = options.globalPositions?.[insertCount] ?? String(insertCount + 1);
        insertCount += 1;

        return {
          rows: [
            {
              event_id: values[0],
              stream_id: values[1],
              stream_version: values[2],
              global_position: globalPosition,
              tenant_id: values[3],
              stream_context_name: values[4],
              stream_category: values[5],
              event_type: values[6],
              payload: values[7],
              metadata: values[8],
              occurred_at: values[9],
              recorded_at: values[10],
              performed_by_user_id: values[11],
              for_account_id: values[12],
              trace_id: values[13] ?? null,
              span_id: values[14] ?? null,
              parent_span_id: values[15] ?? null,
              trace_state: values[16] ?? null,
            },
          ],
          rowCount: 1,
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
