import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";
import type { PgPoolClient, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  createPostgresWorkSignalWaiter,
  createWorkSignalEnvelope,
  emitPostgresWorkSignalNotification,
  parseWorkSignalEnvelope,
  serializeWorkSignalEnvelope,
} from "./work-signal-composite";

const NOW = new Date("2026-06-10T12:00:00.000Z");

describe("work signal composite", () => {
  it("emits bounded versioned Postgres notifications through the active queryable", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] | undefined }> = [];
    const emitted: unknown[] = [];

    await emitPostgresWorkSignalNotification(
      {
        query: async (sql: string, values?: readonly unknown[]) => {
          calls.push({ sql, values });
          return { rows: [], rowCount: 1 };
        },
      },
      {
        channel: "platform_projection_operation_events",
        envelope: {
          kind: "projection-operation.event",
          source: "platform-control-plane",
          payload: { operationId: "projection-operation-1", sequence: 2 },
          correlationId: "corr_1",
        },
        now: () => NOW,
        observer: {
          notificationEmitted: (event) => emitted.push(event),
        },
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toBe("SELECT pg_notify($1, $2)");
    expect(calls[0].values?.[0]).toBe("platform_projection_operation_events");
    const envelope = parseWorkSignalEnvelope(String(calls[0].values?.[1]));
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      payloadVersion: 1,
      kind: "projection-operation.event",
      source: "platform-control-plane",
      emittedAt: NOW.toISOString(),
      correlationId: "corr_1",
      payload: {
        operationId: "projection-operation-1",
        sequence: 2,
      },
    });
    expect(emitted[0]).toMatchObject({
      channel: "platform_projection_operation_events",
      kind: "projection-operation.event",
      correlationId: "corr_1",
    });
  });

  it("rejects sensitive payload keys and oversize notification envelopes", () => {
    expect(() =>
      serializeWorkSignalEnvelope(
        createWorkSignalEnvelope(
          {
            kind: "event-store.commit",
            source: "event-store",
            payload: { sourceContextName: "checkout", guestEmail: "buyer@example.com" },
          },
          { now: () => NOW },
        ),
      ),
    ).toThrow(/sensitive payload key/);

    // Work signals are wake hints: row-level identity keys are rejected like
    // the event-store and relay denylists (issue #1235).
    expect(() =>
      serializeWorkSignalEnvelope(
        createWorkSignalEnvelope(
          {
            kind: "projection.wake-intent",
            source: "platform-control-plane",
            payload: { streamId: "checkout.checkout-session-cs_1" },
          },
          { now: () => NOW },
        ),
      ),
    ).toThrow(/sensitive payload key/);
    expect(() =>
      serializeWorkSignalEnvelope(
        createWorkSignalEnvelope(
          {
            kind: "realtime.outbox-wake",
            source: "platform-api",
            payload: { context: "marketplace", sessionId: "sess_1" },
          },
          { now: () => NOW },
        ),
      ),
    ).toThrow(/sensitive payload key/);

    expect(() =>
      serializeWorkSignalEnvelope(
        createWorkSignalEnvelope(
          {
            kind: "event-store.commit",
            source: "event-store",
            payload: { sourceContextName: "checkout", cursor: "x".repeat(200) },
          },
          { now: () => NOW },
        ),
        { maxPayloadBytes: 50 },
      ),
    ).toThrow(/exceeds the 50 byte limit/);

    expect(
      parseWorkSignalEnvelope(
        JSON.stringify({
          schemaVersion: 1,
          payloadVersion: 1,
          kind: "unknown.event",
          source: "test",
          emittedAt: NOW.toISOString(),
          payload: { id: "safe" },
        }),
      ),
    ).toBeNull();
  });

  it("waits on a dedicated listener connection and matches work-signal envelopes", async () => {
    const client = createNotificationClient();
    const pool = createPoolForClient(client);
    const received: unknown[] = [];
    const waiter = createPostgresWorkSignalWaiter(pool, {
      channel: "platform_projection_operation_events",
      observer: {
        notificationReceived: (event) => received.push(event),
      },
    });
    const wait = waiter.wait({
      timeoutMs: 1_000,
      matches: (notification) =>
        notification.envelope?.kind === "projection-operation.event" &&
        notification.envelope.payload.operationId === "projection-operation-1",
    });

    await vi.waitFor(() => {
      expect(client.queries).toContain("LISTEN platform_projection_operation_events");
    });

    client.emit("notification", {
      channel: "platform_projection_operation_events",
      payload: serializeWorkSignalEnvelope(
        createWorkSignalEnvelope(
          {
            kind: "projection-operation.event",
            source: "platform-control-plane",
            payload: { operationId: "projection-operation-1", sequence: 2 },
          },
          { now: () => NOW },
        ),
      ),
    });

    await expect(wait).resolves.toBe("notified");
    expect(received[0]).toMatchObject({
      kind: "projection-operation.event",
      matchedWaiterCount: 1,
      waiterCount: 1,
      // Adapters receive the parsed notification so they can derive
      // structural observer metadata without re-listening raw payloads.
      notification: {
        channel: "platform_projection_operation_events",
        envelope: {
          kind: "projection-operation.event",
          payload: { operationId: "projection-operation-1", sequence: 2 },
        },
      },
    });

    await waiter.stop();
    expect(client.queries).toContain("UNLISTEN platform_projection_operation_events");
    expect(client.isReleased()).toBe(true);
    expect(client.releaseErrors()).toEqual([true]);
  });

  it("falls back to a bounded timeout when LISTEN is unavailable", async () => {
    const client = createNotificationClient({
      failListen: true,
    });
    const pool = createPoolForClient(client);
    const unavailable: unknown[] = [];
    const waiter = createPostgresWorkSignalWaiter(pool, {
      channel: "platform_projection_operation_events",
      observer: {
        listenerUnavailable: (event) => unavailable.push(event),
      },
    });

    await expect(
      waiter.wait({
        timeoutMs: 100,
        matches: () => true,
      }),
    ).resolves.toBe("listener-unavailable");
    expect(unavailable[0]).toMatchObject({ channel: "platform_projection_operation_events" });
    expect(client.isReleased()).toBe(true);
    expect(client.releaseErrors()[0]).toBeInstanceOf(Error);
  });

  it("circuit-breaks listener reconnect attempts during the retry cooldown", async () => {
    const client = createNotificationClient({ failListen: true });
    let connectCount = 0;
    const pool = {
      connect: async () => {
        connectCount += 1;
        return client;
      },
      query: async () => ({ rows: [], rowCount: 0 }),
    } as unknown as PgTransactionalPool;
    const unavailable: unknown[] = [];
    const waiter = createPostgresWorkSignalWaiter(pool, {
      channel: "durable_job_events",
      listenRetryCooldownMs: 60_000,
      observer: {
        listenerUnavailable: (event) => unavailable.push(event),
      },
    });

    await expect(waiter.wait({ timeoutMs: 100, matches: () => true })).resolves.toBe("listener-unavailable");
    await expect(waiter.wait({ timeoutMs: 100, matches: () => true })).resolves.toBe("listener-unavailable");

    // Cooled-down waits fall back to their bounded timeout without
    // re-attempting LISTEN or re-reporting the failure.
    expect(connectCount).toBe(1);
    expect(unavailable).toHaveLength(1);
  });

  it("recovers the listener after a transient connect failure", async () => {
    const client = createNotificationClient();
    let connectCount = 0;
    const pool = {
      connect: async () => {
        connectCount += 1;
        if (connectCount === 1) {
          throw new Error("connection refused");
        }
        return client;
      },
      query: async () => ({ rows: [], rowCount: 0 }),
    } as unknown as PgTransactionalPool;
    const waiter = createPostgresWorkSignalWaiter(pool, {
      channel: "durable_job_events",
    });

    await expect(waiter.wait({ timeoutMs: 100, matches: () => true })).resolves.toBe("listener-unavailable");

    const wait = waiter.wait({ timeoutMs: 1_000, matches: () => true });
    await vi.waitFor(() => {
      expect(client.queries).toContain("LISTEN durable_job_events");
    });
    client.emit("notification", {
      channel: "durable_job_events",
      payload: serializeWorkSignalEnvelope(
        createWorkSignalEnvelope(
          {
            kind: "durable-job.event",
            source: "durable-job-store",
            payload: { jobId: "job_1", sequence: 1 },
          },
          { now: () => NOW },
        ),
      ),
    });

    await expect(wait).resolves.toBe("notified");
    expect(connectCount).toBe(2);
    await waiter.stop();
  });

  it("keeps the listener error handler attached until stop releases the client", async () => {
    const client = createNotificationClient({ recordErrorListenerDuringUnlisten: true });
    const waiter = createPostgresWorkSignalWaiter(createPoolForClient(client), {
      channel: "durable_job_events",
    });
    const wait = waiter.wait({ timeoutMs: 100, matches: () => true });

    await vi.waitFor(() => {
      expect(client.queries).toContain("LISTEN durable_job_events");
    });

    await waiter.stop();
    await expect(wait).resolves.toBe("aborted");
    expect(client.hadErrorListenerDuringUnlisten()).toBe(true);
    expect(client.listenerCount("error")).toBe(0);
    expect(client.releaseErrors()).toEqual([true]);
  });

  it("destroys the listener client when the listener emits an error", async () => {
    const client = createNotificationClient();
    const waiter = createPostgresWorkSignalWaiter(createPoolForClient(client), {
      channel: "durable_job_events",
    });

    const wait = waiter.wait({ timeoutMs: 100, matches: () => true });

    await vi.waitFor(() => {
      expect(client.queries).toContain("LISTEN durable_job_events");
    });

    const error = new Error("connection terminated unexpectedly");
    client.emit("error", error);

    await expect(wait).resolves.toBe("timeout");
    expect(client.isReleased()).toBe(true);
    expect(client.releaseErrors()).toEqual([error]);
  });
});

function createNotificationClient(options: { failListen?: boolean; recordErrorListenerDuringUnlisten?: boolean } = {}) {
  const emitter = new EventEmitter();
  const queries: string[] = [];
  const releaseErrors: unknown[] = [];
  let released = false;
  let hadErrorListenerDuringUnlisten = false;

  return Object.assign(emitter, {
    queries,
    isReleased: () => released,
    releaseErrors: () => releaseErrors,
    hadErrorListenerDuringUnlisten: () => hadErrorListenerDuringUnlisten,
    query: async (sql: string) => {
      queries.push(sql);
      if (options.recordErrorListenerDuringUnlisten && sql.includes("UNLISTEN")) {
        hadErrorListenerDuringUnlisten = emitter.listenerCount("error") > 0;
      }
      if (options.failListen && sql.includes("LISTEN")) {
        throw new Error("LISTEN is unavailable on this connection.");
      }
      return { rows: [], rowCount: 0 };
    },
    release: (error?: unknown) => {
      releaseErrors.push(error);
      released = true;
    },
  }) as unknown as PgPoolClient &
    EventEmitter & {
      readonly queries: string[];
      isReleased: () => boolean;
      releaseErrors: () => unknown[];
      hadErrorListenerDuringUnlisten: () => boolean;
    };
}

function createPoolForClient(client: PgPoolClient): PgTransactionalPool {
  return {
    connect: async () => client,
    query: async () => ({ rows: [], rowCount: 0 }),
  };
}
