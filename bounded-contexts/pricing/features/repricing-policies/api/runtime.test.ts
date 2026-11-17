import { describe, expect, it } from "vitest";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { AppendToStreamInput, EventStoreContext, StoredEvent } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createRepricingPolicyRuntime, PolicyControlValidationError } from "./runtime";
import { RepricingPolicyValidationError, type ReviseRepricingPolicyCommand } from "../domain/domain";
import {
  createMemoryRepricingConfigurationWriter,
  createConfigurationPoolFixture,
} from "../tests/configuration-fixture";
import { createRepricingConfigurationWriter } from "./configuration";

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
  return {
    services: createRepricingPolicyRuntime({
      eventStore: eventStore.store,
      db,
      configuration: createMemoryRepricingConfigurationWriter(eventStore.store),
      goalAdoptions: async () => [],
    }),
    events: eventStore.allEvents,
  };
}

const rule = {
  conditions: [],
  directive: {
    currencyCode: "USD",
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
  it("keeps pending lifecycle and revision requests out of installed policy and replays only their own outcome", async () => {
    const memory = createMemoryEventStore();
    const fixture = createConfigurationPoolFixture();
    const runtime = () =>
      createRepricingPolicyRuntime({
        eventStore: memory.store,
        db: queryStub(),
        goalAdoptions: async () => [],
        configuration: createRepricingConfigurationWriter({
          ...fixture,
          eventStore: {
            appendToStreamInTransaction: async (_: unknown, input: AppendToStreamInput) =>
              memory.store.appendToStream(input),
          },
        }),
      });
    await runtime().commandHandler({
      streamId: runtime().streamIdForPolicy("rpp_pending"),
      context,
      command: {
        type: "CreateRepricingPolicy",
        policyId: "rpp_pending",
        accountId: "acc_seller",
        name: "Installed",
        scope: { kind: "all-listings" },
        rules: [rule],
        maxChangesPerDay: 25,
        createdAt: "2026-11-17T00:00:00Z",
      },
    });
    fixture.control.pending = true;
    const pause = () =>
      runtime().executeOwnedRepricingPolicy({
        policyId: "rpp_pending",
        accountId: "acc_seller",
        context,
        requestKey: "synthetic-pause",
        command: { type: "PauseRepricingPolicy", pausedAt: "2026-11-17T00:01:00Z" },
      });
    expect(await pause()).toMatchObject({ status: "accepted-pending", requestedRevision: 2 });
    expect((await runtime().loadOwnedRepricingPolicy("rpp_pending", "acc_seller"))!.state).toMatchObject({
      name: "Installed",
      status: "active",
    });
    const revise = () =>
      runtime().executeOwnedRepricingPolicy({
        policyId: "rpp_pending",
        accountId: "acc_seller",
        context,
        requestKey: "synthetic-revise",
        command: {
          type: "ReviseRepricingPolicy",
          name: "Replacement",
          scope: { kind: "all-listings" },
          rules: [rule],
          maxChangesPerDay: 25,
          revisedAt: "2026-11-17T00:02:00Z",
        },
      });
    expect(await revise()).toMatchObject({ status: "accepted-pending", requestedRevision: 3 });
    expect(await pause()).toMatchObject({
      status: "superseded-by-revision",
      requestedRevision: 2,
      replacingRevision: 3,
    });
    expect(await runtime().listConfigurationRequests("acc_seller")).toEqual([
      { status: "accepted-pending", requestKey: "synthetic-revise", requestedRevision: 3 },
    ]);
    fixture.control.pending = false;
    const applied = await revise();
    expect(applied).toMatchObject({
      status: "applied",
      installedRevision: 3,
      state: { name: "Replacement", status: "active" },
    });
    expect(await revise()).toEqual(applied);
    expect((await runtime().loadOwnedRepricingPolicy("rpp_pending", "acc_seller"))!.state).toMatchObject({
      name: "Replacement",
      status: "active",
    });
    expect(memory.allEvents.map((event) => event.eventType)).toEqual([
      "pricing.repricing-policy.created",
      "pricing.repricing-policy.revised",
    ]);
  });
  it("keeps an installed halt engaged through pending release, restart, supersession and original-key replay", async () => {
    const memory = createMemoryEventStore();
    const fixture = createConfigurationPoolFixture();
    const store = {
      appendToStreamInTransaction: async (_: unknown, input: AppendToStreamInput) => memory.store.appendToStream(input),
    };
    const runtime = () =>
      createRepricingPolicyRuntime({
        eventStore: memory.store,
        db: queryStub(),
        goalAdoptions: async () => [],
        configuration: createRepricingConfigurationWriter({ ...fixture, eventStore: store }),
      });
    const engaged = await runtime().setHalt("acc_seller", true, context, "engage");
    expect(engaged).toMatchObject({ status: "applied", installedRevision: 1, state: { engaged: true } });
    fixture.control.pending = true;
    const released = await runtime().setHalt("acc_seller", false, context, "release");
    expect(released).toEqual({ status: "accepted-pending", requestedRevision: 2, requestKey: "release" });
    expect(await runtime().getHalt("acc_seller")).toMatchObject({ engaged: true });
    expect(await runtime().getHaltConfigurationStatus("acc_seller")).toEqual({
      installedRevision: 1,
      installedState: expect.objectContaining({ engaged: true }),
      requestedRevision: 2,
      request: released,
    });
    expect(await runtime().setHalt("acc_seller", false, context, "release")).toEqual(released);
    await expect(runtime().setHalt("acc_seller", true, context, "release")).rejects.toMatchObject({
      code: "concurrency_conflict",
    });
    const replacement = await runtime().setHalt("acc_seller", true, context, "replacement");
    expect(replacement).toMatchObject({ status: "accepted-pending", requestedRevision: 3 });
    const superseded = await runtime().setHalt("acc_seller", false, context, "release");
    expect(superseded).toEqual({
      status: "superseded-by-revision",
      requestKey: "release",
      requestedRevision: 2,
      replacingRevision: 3,
    });
    fixture.control.pending = false;
    expect(await runtime().setHalt("acc_seller", true, context, "replacement")).toMatchObject({
      status: "applied",
      installedRevision: 3,
      state: { engaged: true },
    });
    expect(await runtime().setHalt("acc_seller", true, context, "engage")).toEqual(engaged);
    expect(await runtime().setHalt("acc_seller", false, context, "release")).toEqual(superseded);
    expect(await runtime().getHalt("acc_seller")).toMatchObject({ engaged: true });
    expect(memory.allEvents.map((event) => event.eventType)).toEqual(["pricing.repricing-halt.engaged"]);
  });
  it("rejects partial or corrupt durable receipts rather than reporting installation", async () => {
    const memory = createMemoryEventStore();
    const fixture = createConfigurationPoolFixture();
    const configuration = createRepricingConfigurationWriter({
      ...fixture,
      eventStore: {
        appendToStreamInTransaction: async (_: unknown, input: AppendToStreamInput) =>
          memory.store.appendToStream(input),
      },
    });
    const services = createRepricingPolicyRuntime({
      eventStore: memory.store,
      db: queryStub(),
      goalAdoptions: async () => [],
      configuration,
    });
    await services.setHalt("acc_seller", true, context, "synthetic-corrupt");
    const row = [...fixture.rows.values()][0]!;
    const original = row.receipt;
    for (const receipt of [
      { requestKey: "synthetic-corrupt", requestedRevision: Number.MAX_SAFE_INTEGER, status: "accepted-pending" },
      {
        requestKey: "synthetic-corrupt",
        requestedRevision: 1,
        installedRevision: 1,
        status: "applied",
        state: { engaged: "false" },
      },
      {
        requestKey: "synthetic-corrupt",
        requestedRevision: 1,
        installedRevision: 1,
        status: "applied",
        state: { engaged: false, engagedAt: null, releasedAt: null },
      },
    ]) {
      row.receipt = receipt;
      await expect(services.setHalt("acc_seller", true, context, "synthetic-corrupt")).rejects.toThrow();
      expect(await services.getHalt("acc_seller")).toMatchObject({ engaged: true });
    }
    row.receipt = original;
    row.prepared += " ";
    await expect(services.setHalt("acc_seller", true, context, "synthetic-corrupt")).rejects.toThrow(
      "Corrupt Pricing configuration request",
    );
    fixture.rows.clear();
    await expect(services.getHaltConfigurationStatus("acc_seller")).rejects.toThrow(
      "Partial Pricing configuration history",
    );
  });
  it("domain validation details keep the intentional tag as cause without rewrapping raw messages", async () => {
    const { services } = createRuntime();
    await services.commandHandler({
      streamId: services.streamIdForPolicy("rpp_validation"),
      context,
      command: {
        type: "CreateRepricingPolicy",
        policyId: "rpp_validation",
        accountId: "acc_seller",
        name: "Synthetic",
        scope: { kind: "all-listings" },
        rules: [rule],
        maxChangesPerDay: 25,
        createdAt: "2026-09-27T00:00:00Z",
      },
    });
    const command: ReviseRepricingPolicyCommand = {
      type: "ReviseRepricingPolicy",
      name: "Synthetic",
      scope: { kind: "all-listings" },
      rules: [],
      maxChangesPerDay: 25,
      revisedAt: "2026-09-27T00:00:01Z",
    };
    await expect(
      services.executeOwnedRepricingPolicy({ policyId: "rpp_validation", accountId: "acc_seller", context, command }),
    ).rejects.toMatchObject({
      message: "Invalid policy command.",
      cause: expect.any(RepricingPolicyValidationError),
    });
    const malformed = {
      ...command,
      scope: { kind: "synthetic-internal-sentinel" },
    } as unknown as ReviseRepricingPolicyCommand;
    let caught: unknown;
    try {
      await services.executeOwnedRepricingPolicy({
        policyId: "rpp_validation",
        accountId: "acc_seller",
        context,
        command: malformed,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PolicyControlValidationError);
    expect((caught as PolicyControlValidationError).message).toBe("Invalid policy command.");
    expect((caught as PolicyControlValidationError).cause).not.toBeInstanceOf(RepricingPolicyValidationError);
  });
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

  it("exposes policy and halt projectors", () => {
    const { services } = createRuntime();
    expect(services.projectors).toHaveLength(2);
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
        authoringIntent: null,
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
