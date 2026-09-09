import { describe, expect, it } from "vitest";
import { createEventStoreError, type EventStore } from "@chase-sets/event-core/event-store";
import type { AppendToStreamInput, EventStoreContext, StoredEvent } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createEconomicsOverrideRuntime } from "./override-runtime";

const context: EventStoreContext = {
  tenantId: "synthetic-tenant" as never,
  audit: {
    performedByUserId: "synthetic-user" as never,
    forAccountId: "synthetic-owner-account" as never,
  },
};

const key = {
  accountId: "synthetic-owner-account",
  scopeKey: "synthetic-connection-1",
  currency: "usd",
} as const;

function memoryEventStore(): EventStore {
  const streams = new Map<string, StoredEvent[]>();
  let globalPosition = 0;
  return {
    appendToStream: async (input: AppendToStreamInput) => {
      const existing = streams.get(input.streamId) ?? [];
      const actualVersion = existing.at(-1)?.streamVersion ?? 0;
      if (input.expectedVersion !== "any") {
        const expected = input.expectedVersion === "no_stream" ? 0 : input.expectedVersion;
        if (expected !== actualVersion) throw new Error("synthetic optimistic concurrency conflict");
      }
      const stored = input.events.map((event, index) => {
        globalPosition += 1;
        return {
          eventId: `synthetic-event-${globalPosition}` as never,
          streamId: input.streamId,
          streamVersion: actualVersion + index + 1,
          globalPosition: String(globalPosition) as never,
          tenantId: input.context.tenantId,
          eventType: event.eventType,
          payload: event.payload,
          metadata: event.metadata ?? {},
          occurredAt: event.payload.occurredAt as string as never,
          recordedAt: `2026-09-07T07:${String(globalPosition).padStart(2, "0")}:00Z` as never,
          performedByUserId: input.context.audit.performedByUserId,
          forAccountId: input.context.audit.forAccountId,
        } satisfies StoredEvent;
      });
      streams.set(input.streamId, [...existing, ...stored]);
      return stored;
    },
    readStream: async ({ streamId, fromVersion = 1, limit }) =>
      (streams.get(streamId) ?? []).filter((event) => event.streamVersion >= fromVersion).slice(0, limit),
    readAll: async () => [...streams.values()].flat(),
  };
}

describe("Economics override runtime", () => {
  it("uses one account/scope/currency stream and replays overrides at effective time", async () => {
    const runtime = createEconomicsOverrideRuntime({
      eventStore: memoryEventStore(),
      db: { query: async () => ({ rows: [] }) } as PgQueryable,
    });
    const active = await runtime.execute({
      key,
      command: {
        type: "SetEconomicsFactOverride",
        expectedVersion: 0,
        factName: "dailyReturnHurdle",
        value: 0.01,
        setAt: "2026-09-07T06:01:00Z",
      },
      context,
    });
    expect(active.version).toBe(1);
    expect(active.entries.dailyReturnHurdle).toMatchObject({ kind: "active", value: 0.01, revision: 1 });
    expect(runtime.streamIdForKey(key)).not.toBe(
      runtime.streamIdForKey({ ...key, scopeKey: "synthetic-connection-2" }),
    );
    expect(runtime.streamIdForKey(key)).not.toBe(runtime.streamIdForKey({ ...key, scopeKey: "native-marketplace" }));

    const cleared = await runtime.execute({
      key,
      command: {
        type: "ClearEconomicsFactOverride",
        expectedVersion: 1,
        factName: "dailyReturnHurdle",
        clearedAt: "2026-09-07T06:03:00Z",
      },
      context,
    });
    expect(cleared.version).toBe(2);
    expect(cleared.entries.dailyReturnHurdle?.kind).toBe("cleared");

    const beforeClear = await runtime.loadAt(key, "2026-09-07T06:02:00Z");
    expect(beforeClear.version).toBe(1);
    expect(beforeClear.entries.dailyReturnHurdle?.kind).toBe("active");
    const afterClear = await runtime.loadAt(key, "2026-09-07T06:04:00Z");
    expect(afterClear.version).toBe(2);
    expect(afterClear.entries.dailyReturnHurdle?.kind).toBe("cleared");
  });

  it("requires the command expected version at both decision and append fences", async () => {
    const runtime = createEconomicsOverrideRuntime({
      eventStore: memoryEventStore(),
      db: { query: async () => ({ rows: [] }) } as PgQueryable,
    });
    await runtime.execute({
      key,
      command: {
        type: "SetEconomicsFactOverride",
        expectedVersion: 0,
        factName: "turnaroundDays",
        value: 12,
        setAt: "2026-09-07T06:01:00Z",
      },
      context,
    });
    await expect(
      runtime.execute({
        key,
        command: {
          type: "ClearEconomicsFactOverride",
          expectedVersion: 0,
          factName: "turnaroundDays",
          clearedAt: "2026-09-07T06:02:00Z",
        },
        context,
      }),
    ).rejects.toThrow(/version conflict/);
  });

  it("maps an append race to the bounded Economics version conflict", async () => {
    const base = memoryEventStore();
    let raced = false;
    const eventStore: EventStore = {
      ...base,
      appendToStream: async (input) => {
        if (raced) return base.appendToStream(input);
        raced = true;
        await base.appendToStream(input);
        throw createEventStoreError("concurrency_conflict", "synthetic append race", {
          expectedVersion: input.expectedVersion,
          currentVersion: 1,
        });
      },
    };
    const runtime = createEconomicsOverrideRuntime({
      eventStore,
      db: { query: async () => ({ rows: [] }) } as PgQueryable,
    });

    await expect(
      runtime.execute({
        key,
        command: {
          type: "SetEconomicsFactOverride",
          expectedVersion: 0,
          factName: "turnaroundDays",
          value: 12,
          setAt: "2026-09-07T06:01:00Z",
        },
        context,
      }),
    ).rejects.toMatchObject({ name: "EconomicsOverrideConflictError" });
  });

  it("publishes one same-context projector for tombstone persistence", () => {
    const runtime = createEconomicsOverrideRuntime({
      eventStore: memoryEventStore(),
      db: { query: async () => ({ rows: [] }) } as PgQueryable,
    });
    expect(runtime.projectors.map((projector) => projector.projectionName)).toEqual([
      "pricing-economics-overrides-projection",
    ]);
  });
});
