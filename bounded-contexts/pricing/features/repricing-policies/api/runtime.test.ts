import { describe, expect, it } from "vitest";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { AppendToStreamInput, EventStoreContext, StoredEvent } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createRepricingPolicyRuntime } from "./runtime";

const context: EventStoreContext = {
  tenantId: "ten_1" as never,
  audit: {
    performedByUserId: "usr_1" as never,
    forAccountId: "acc_seller" as never,
  },
};

function createMemoryEventStore() {
  const streams = new Map<string, StoredEvent[]>();
  const allEvents: StoredEvent[] = [];

  const store: EventStore = {
    appendToStream: async (input: AppendToStreamInput) => {
      const existing = streams.get(input.streamId) ?? [];
      const stored = input.events.map((event, index) => {
        const streamVersion = existing.length + index + 1;
        return {
          eventId: `evt_${allEvents.length + index + 1}` as never,
          streamId: input.streamId,
          streamVersion,
          globalPosition: String(allEvents.length + index + 1) as never,
          tenantId: input.context.tenantId,
          eventType: event.eventType,
          payload: event.payload,
          metadata: event.metadata ?? {},
          occurredAt: new Date().toISOString() as never,
          recordedAt: new Date().toISOString() as never,
          performedByUserId: input.context.audit.performedByUserId,
          forAccountId: input.context.audit.forAccountId,
        } satisfies StoredEvent;
      });
      streams.set(input.streamId, [...existing, ...stored]);
      allEvents.push(...stored);
      return stored;
    },
    readStream: async ({ streamId }) => streams.get(streamId) ?? [],
    readAll: async () => allEvents,
  };

  return { store, allEvents };
}

function queryStub(rows: readonly Record<string, unknown>[] = []): PgQueryable {
  return { query: async <T>() => ({ rows: rows as T[] }) };
}

function createRuntime(db: PgQueryable = queryStub()) {
  const eventStore = createMemoryEventStore();
  return { services: createRepricingPolicyRuntime({ eventStore: eventStore.store, db }), events: eventStore.allEvents };
}

const rule = {
  conditions: [],
  directive: {
    anchorChain: [{ source: "market-estimate" as const }],
    offset: { mode: "percent" as const, percent: -1 },
    floor: { mode: "absolute" as const, amount: "5.00" },
    ceiling: null,
    tolerance: { mode: "percent" as const, percent: 2 },
    rounding: { mode: "none" as const },
    maxMovePercent: 10,
    terminal: { kind: "hold" as const },
  },
};

describe("createRepricingPolicyRuntime", () => {
  it("dispatches lifecycle commands through the command handler onto a per-policy stream", async () => {
    const { services, events } = createRuntime();
    const streamId = services.streamIdForPolicy("rpp_1");

    const created = await services.commandHandler({
      streamId,
      command: {
        type: "CreateRepricingPolicy",
        policyId: "rpp_1" as never,
        accountId: "acc_seller" as never,
        name: "Base policy",
        scope: { kind: "all-listings" },
        rules: [rule],
        maxChangesPerDay: 25,
        createdAt: "2026-07-11T00:00:00.000Z",
      },
      context,
    });
    expect(created.newEvents).toHaveLength(1);
    expect(created.state.status).toBe("active");

    await services.commandHandler({
      streamId,
      command: { type: "PauseRepricingPolicy", pausedAt: "2026-07-12T00:00:00.000Z" },
      context,
    });
    const resumed = await services.commandHandler({
      streamId,
      command: { type: "ResumeRepricingPolicy", resumedAt: "2026-07-13T00:00:00.000Z" },
      context,
    });
    expect(resumed.state.status).toBe("active");

    const deleted = await services.commandHandler({
      streamId,
      command: { type: "DeleteRepricingPolicy", deletedAt: "2026-07-14T00:00:00.000Z" },
      context,
    });
    expect(deleted.state.status).toBe("deleted");

    expect(events.map((event) => event.eventType)).toEqual([
      "pricing.repricing-policy.created",
      "pricing.repricing-policy.paused",
      "pricing.repricing-policy.resumed",
      "pricing.repricing-policy.deleted",
    ]);
    expect(events.every((event) => event.streamId === streamId)).toBe(true);
  });

  it("exposes exactly one projector wired to the policy pages table", () => {
    const { services } = createRuntime();
    expect(services.projectors).toHaveLength(1);
    expect(services.projectors[0]?.projectionName).toBe("pricing-repricing-policy-projection");
  });

  it("delegates read-model queries to the injected database", async () => {
    const db = queryStub([
      {
        policy_id: "rpp_1",
        seller_account_id: "acc_seller",
        name: "Base policy",
        status: "active",
        scope_kind: "all-listings",
        scope_category_ids: null,
        scope_listing_ids: null,
        excluded_listing_ids: [],
        rules: [rule],
        max_changes_per_day: 25,
        created_at: "2026-07-11T00:00:00.000Z",
        updated_at: "2026-07-11T00:00:00.000Z",
      },
    ]);
    const { services } = createRuntime(db);
    const policies = await services.listAccountRepricingPolicies({ accountId: "acc_seller" });
    expect(policies).toEqual([
      {
        policyId: "rpp_1",
        sellerAccountId: "acc_seller",
        name: "Base policy",
        status: "active",
        scope: { kind: "all-listings" },
        excludedListingIds: [],
        rules: [rule],
        maxChangesPerDay: 25,
        createdAt: "2026-07-11T00:00:00.000Z",
        updatedAt: "2026-07-11T00:00:00.000Z",
      },
    ]);
  });
});
