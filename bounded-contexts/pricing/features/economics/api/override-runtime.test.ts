import { describe, expect, it } from "vitest";
import { createEventStoreError, type EventStore } from "@chase-sets/event-core/event-store";
import type { AppendToStreamInput, EventStoreContext, StoredEvent } from "@chase-sets/event-core/storage";
import type { PgQueryable, PgQueryFunction } from "@chase-sets/event-core-postgres";
import { applyEconomicsOverrideToFact } from "../domain/overrides";
import type { EconomicsFact } from "../domain/contracts";
import {
  parseAuthenticatedClearEconomicsOverrideRequest,
  parseAuthenticatedSetEconomicsOverrideRequest,
} from "./contracts";
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
  scopeKey: "channel-connection:synthetic-connection-1",
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

type ProjectedOverrideRow = Readonly<{
  accountId: string;
  scopeKey: string;
  currency: string;
  fact_name: string;
  override_state: string;
  override_value: unknown;
  set_at: string | null;
  cleared_at: string | null;
  last_stream_version: number;
}>;

function projectedOverrideDb() {
  const rows = new Map<string, ProjectedOverrideRow>();
  const query: PgQueryFunction = async <Row>(text: string, values?: readonly unknown[]) => {
    const params = values ?? [];
    if (text.includes("INSERT INTO pricing_economics_overrides")) {
      const [accountId, scopeKey, currency, factName, state, value, setAt, clearedAt, streamVersion] = params;
      const rowKey = [accountId, scopeKey, currency, factName].join("\u0000");
      const existing = rows.get(rowKey);
      if (existing === undefined || existing.last_stream_version < Number(streamVersion)) {
        rows.set(rowKey, {
          accountId: String(accountId),
          scopeKey: String(scopeKey),
          currency: String(currency),
          fact_name: String(factName),
          override_state: String(state),
          override_value: value === null ? null : JSON.parse(String(value)),
          set_at: setAt === null ? null : String(setAt),
          cleared_at: clearedAt === null ? null : String(clearedAt),
          last_stream_version: Number(streamVersion),
        });
      }
      return { rows: [] as Row[] };
    }
    if (text.includes("FROM pricing_economics_overrides")) {
      const [accountId, scopeKey, currency] = params;
      const selected = [...rows.values()]
        .filter((row) => row.accountId === accountId && row.scopeKey === scopeKey && row.currency === currency)
        .sort((left, right) => left.last_stream_version - right.last_stream_version);
      return { rows: selected as unknown as Row[] };
    }
    throw new Error("Unexpected synthetic projection query.");
  };
  return { value: { query } satisfies PgQueryable, rows };
}

async function projectStoredEvents(
  runtime: ReturnType<typeof createEconomicsOverrideRuntime>,
  eventStore: EventStore,
  projectedEventIds: Set<string>,
): Promise<void> {
  const handlers = runtime.projectors[0]!.handlers;
  for (const stored of await eventStore.readAll()) {
    if (projectedEventIds.has(stored.eventId)) continue;
    const handler = handlers[stored.eventType];
    if (handler === undefined) throw new Error(`Missing synthetic projector for ${stored.eventType}.`);
    await handler({
      id: stored.eventId,
      type: stored.eventType,
      streamId: stored.streamId,
      streamVersion: stored.streamVersion,
      globalPosition: stored.globalPosition,
      tenantId: stored.tenantId,
      data: stored.payload,
      metadata: stored.metadata,
      audit: { performedByUserId: stored.performedByUserId, forAccountId: stored.forAccountId },
      trace: {},
      timing: { occurredAt: stored.occurredAt, recordedAt: stored.recordedAt },
    } as never);
    projectedEventIds.add(stored.eventId);
  }
}

describe("Economics override runtime", () => {
  it("isolates native and same-literal Channel scopes across API, streams, projection, clears, and reads", async () => {
    const eventStore = memoryEventStore();
    const projection = projectedOverrideDb();
    const runtime = createEconomicsOverrideRuntime({ eventStore, db: projection.value });
    const common = {
      currency: "usd",
      expectedVersion: 0,
      factName: "turnaroundDays",
      setAt: "2026-09-07T06:01:00Z",
    } as const;
    const native = parseAuthenticatedSetEconomicsOverrideRequest(
      { ...common, scope: { kind: "native-marketplace" }, value: 11 },
      "synthetic-owner-account",
    );
    const channel = parseAuthenticatedSetEconomicsOverrideRequest(
      {
        ...common,
        scope: { kind: "channel-connection", connectionId: "native-marketplace" },
        value: 22,
      },
      "synthetic-owner-account",
    );

    expect(native.key.scopeKey).toBe("native-marketplace");
    expect(channel.key.scopeKey).toBe("channel-connection:native-marketplace");
    expect(runtime.streamIdForKey(native.key)).not.toBe(runtime.streamIdForKey(channel.key));

    const [nativeSet, channelSet] = await Promise.all([
      runtime.execute({ ...native, context }),
      runtime.execute({ ...channel, context }),
    ]);
    expect(nativeSet.version).toBe(1);
    expect(channelSet.version).toBe(1);

    const projectedEventIds = new Set<string>();
    await projectStoredEvents(runtime, eventStore, projectedEventIds);
    expect(projection.rows.size).toBe(2);

    const nativeClear = parseAuthenticatedClearEconomicsOverrideRequest(
      {
        scope: { kind: "native-marketplace" },
        currency: "usd",
        expectedVersion: 1,
        factName: "turnaroundDays",
        clearedAt: "2026-09-07T06:02:00Z",
      },
      "synthetic-owner-account",
    );
    const nativeCleared = await runtime.execute({ ...nativeClear, context });
    await projectStoredEvents(runtime, eventStore, projectedEventIds);

    const [nativeProjection, channelProjection] = await Promise.all([
      runtime.readCurrentProjection(native.key),
      runtime.readCurrentProjection(channel.key),
    ]);
    expect(nativeCleared.version).toBe(2);
    expect(nativeProjection).toMatchObject({
      version: 2,
      entries: { turnaroundDays: { kind: "cleared", revision: 2 } },
    });
    expect(channelProjection).toMatchObject({
      version: 1,
      entries: { turnaroundDays: { kind: "active", value: 22, revision: 1 } },
    });
    expect([...projection.rows.values()].map((row) => [row.scopeKey, row.override_state])).toEqual(
      expect.arrayContaining([
        ["native-marketplace", "cleared"],
        ["channel-connection:native-marketplace", "active"],
      ]),
    );

    const sourceFact: EconomicsFact<number> = {
      sourceValue: 30,
      source: {
        kind: "policy-default",
        policyRevision: "sha256:synthetic-policy",
        reason: "insufficient-observed-history",
      },
      effectiveValue: 30,
      override: null,
      observedAt: "2026-09-07T06:00:00Z",
    };
    expect(applyEconomicsOverrideToFact("turnaroundDays", sourceFact, nativeProjection)).toMatchObject({
      effectiveValue: 30,
      override: null,
    });
    expect(applyEconomicsOverrideToFact("turnaroundDays", sourceFact, channelProjection)).toMatchObject({
      effectiveValue: 22,
      override: { revision: 1 },
    });
  });

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
      runtime.streamIdForKey({ ...key, scopeKey: "channel-connection:synthetic-connection-2" }),
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
