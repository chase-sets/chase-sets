import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { ZERO_GLOBAL_POSITION, type EventStoreContext } from "@chase-sets/event-core/storage";
import type { JsonObject } from "@chase-sets/primitives/json";
import type { InventoryRuntimeDeps } from "../../../support/runtime-support";
import type { InventoryItemServices } from "../../inventory-items/api/runtime";
import { createRestockDecisionRuntime } from "./runtime";

const context: EventStoreContext = {
  tenantId: "tnt_c2_synthetic",
  audit: { performedByUserId: "usr_c2_synthetic", forAccountId: "acc_c2_synthetic" },
};
const pending = {
  decisionId: "rstk_c2_synthetic",
  accountId: "acc_c2_synthetic",
  orderId: "ord_c2_synthetic",
  itemId: "inv_c2_synthetic",
  quantity: 2,
  source: "shipment-returned",
  sourceRef: { orderId: "ord_c2_synthetic", reservationRequestId: "rsv_c2_synthetic" },
  shipmentId: null,
  returnReason: null,
  pendingAt: "2026-10-14T00:00:00Z",
};
const recorded = {
  decisionId: pending.decisionId,
  accountId: pending.accountId,
  orderId: pending.orderId,
  itemId: pending.itemId,
  quantity: pending.quantity,
  outcome: "written-off",
  reason: "written-off",
  sourceRef: pending.sourceRef,
  damageNote: null,
  decidedAt: "2026-10-14T00:00:01Z",
};

async function harness(
  facts = [{ eventType: "inventory.restock-decision.pending", payload: pending as JsonObject }],
  retained = false,
  retainedFacts: { eventType: string; payload: JsonObject }[] = [],
) {
  const { eventStore, streams } = createInMemoryEventStore();
  const streamId = `inventory.restock-decision-${pending.decisionId}`;
  if (facts.length) await eventStore.appendToStream({ streamId, expectedVersion: "no_stream", context, events: facts });
  await eventStore.appendToStream({
    streamId: `inventory.item-${pending.itemId}`,
    expectedVersion: "no_stream",
    context,
    events: [
      { eventType: "inventory.item.created", payload: { itemId: pending.itemId, accountId: pending.accountId } },
      ...retainedFacts,
    ],
  });
  const adjustItem = vi.fn<InventoryItemServices["adjustItem"]>(async () => ({ itemId: pending.itemId, version: 2 }));
  const child = vi.fn();
  const deps: InventoryRuntimeDeps = {
    eventStore,
    checkpointStore: { loadCheckpoint: async () => ZERO_GLOBAL_POSITION, saveCheckpoint: async () => undefined },
    mutationChild: async (name, family, target, params, childContext, work) => {
      child(name, family, target, params, childContext, work);
      return work(childContext);
    },
    db: {
      query: async <Row>(sql: string, values: readonly unknown[] = []) => ({
        rows: (sql.includes("SELECT event_id FROM event_store_events")
          ? values[1] === context.tenantId && values[2] === pending.accountId
            ? [{ event_id: "synthetic-owner" }]
            : []
          : sql.includes("event_store_streams")
            ? [
                {
                  total: String(streams.get(String(values[0]))?.length ?? 0),
                  current_version: String(streams.get(String(values[0]))?.length ?? 0),
                },
              ]
            : retained
              ? [{ idempotency_key: `restock-decision:${pending.decisionId}:restocked` }]
              : []) as Row[],
      }),
    },
  };
  const params = {
    accountId: pending.accountId,
    decisionId: pending.decisionId,
    expectedVersion: 1,
    outcome: "restocked" as const,
  };
  return {
    services: createRestockDecisionRuntime(deps, { adjustItem }),
    deps,
    adjustItem,
    child,
    streams,
    params,
    streamId,
  };
}

describe("issue-7169-ac8-atomic-restock: complete retained decision history", () => {
  it("rejects a mixed audit Account even when payload and Tenant match", async () => {
    const { deps, adjustItem, params } = await harness();
    const read = deps.eventStore.readStream.bind(deps.eventStore);
    const services = createRestockDecisionRuntime(
      {
        ...deps,
        eventStore: {
          ...deps.eventStore,
          readStream: async (input) =>
            (await read(input)).map((event) => ({ ...event, forAccountId: "acc_foreign_synthetic" })),
        },
      },
      { adjustItem },
    );
    await expect(services.recordDecision(params, context)).rejects.toThrow("reconciliation");
    expect(adjustItem).not.toHaveBeenCalled();
  });

  it.each(["tenant", "account"])("conceals a foreign %s exactly like a missing decision", async (scope) => {
    const { services, adjustItem, params, deps } = await harness();
    const foreign: EventStoreContext =
      scope === "tenant"
        ? { ...context, tenantId: "tnt_foreign_synthetic" }
        : { ...context, audit: { ...context.audit, forAccountId: "acc_foreign_synthetic" } };
    const missing = createRestockDecisionRuntime(
      {
        ...deps,
        eventStore: { ...deps.eventStore, readStream: async () => [] },
        db: { query: async () => ({ rows: [] }) },
      },
      { adjustItem },
    );
    const foreignParams = { ...params, accountId: foreign.audit.forAccountId };
    await expect(missing.recordDecision(foreignParams, foreign)).rejects.toThrow("Restock decision not found.");
    await expect(services.recordDecision(foreignParams, foreign)).rejects.toThrow("Restock decision not found.");
    expect(adjustItem).not.toHaveBeenCalled();
  });

  it("does not treat an unrelated order's retained restock as this decision's stock", async () => {
    const { services, adjustItem, params } = await harness(undefined, false, [
      {
        eventType: "inventory.item.adjusted",
        payload: {
          itemId: pending.itemId,
          quantityDelta: 2,
          reason: "return-restocked",
          sourceRef: { orderId: "ord_other_synthetic", reservationRequestId: "rsv_other_synthetic" },
        },
      },
    ]);
    expect(await services.recordDecision({ ...params, outcome: "written-off" }, context)).toEqual({
      decisionId: pending.decisionId,
      version: 2,
    });
    expect(adjustItem).not.toHaveBeenCalled();
  });
  it("finds decisive retained stock after a complete event-store page", async () => {
    const facts: { eventType: string; payload: JsonObject }[] = Array.from({ length: 500 }, () => ({
      eventType: "inventory.item.adjusted",
      payload: { itemId: pending.itemId, quantityDelta: 0, reason: "correction" },
    }));
    facts.push({
      eventType: "inventory.item.adjusted",
      payload: { itemId: pending.itemId, quantityDelta: 2, reason: "return-restocked", sourceRef: pending.sourceRef },
    });
    const { services, adjustItem, params } = await harness(undefined, false, facts);
    await expect(services.recordDecision(params, context)).rejects.toThrow("reconciliation");
    expect(adjustItem).not.toHaveBeenCalled();
  });
  it.each(["restocked", "written-off"] as const)(
    "retains legacy stock evidence after receipt cleanup before %s",
    async (outcome) => {
      const { services, adjustItem, params, streams, streamId } = await harness(undefined, false, [
        {
          eventType: "inventory.item.adjusted",
          payload: {
            itemId: pending.itemId,
            quantityDelta: 2,
            reason: "return-restocked",
            reasonCode: "return-restocked",
            sourceRef: pending.sourceRef,
          },
        },
      ]);
      await expect(services.recordDecision({ ...params, outcome }, context)).rejects.toThrow("reconciliation");
      expect(adjustItem).not.toHaveBeenCalled();
      expect(streams.get(streamId)).toHaveLength(1);
    },
  );
  it.each([
    [
      "unknown pending field",
      [{ eventType: "inventory.restock-decision.pending", payload: { ...pending, unknown: true } }],
    ],
    [
      "nested unknown",
      [
        {
          eventType: "inventory.restock-decision.pending",
          payload: { ...pending, sourceRef: { ...pending.sourceRef, unknown: true } },
        },
      ],
    ],
    [
      "mixed identity",
      [
        {
          eventType: "inventory.restock-decision.pending",
          payload: { ...pending, decisionId: "rstk_other_synthetic" },
        },
      ],
    ],
    [
      "mixed source",
      [
        {
          eventType: "inventory.restock-decision.pending",
          payload: { ...pending, sourceRef: { ...pending.sourceRef, orderId: "ord_other_synthetic" } },
        },
      ],
    ],
    [
      "malformed quantity",
      [{ eventType: "inventory.restock-decision.pending", payload: { ...pending, quantity: "2" } }],
    ],
    [
      "date-only pending",
      [{ eventType: "inventory.restock-decision.pending", payload: { ...pending, pendingAt: "2026-10-14" } }],
    ],
    [
      "timezone-free pending",
      [{ eventType: "inventory.restock-decision.pending", payload: { ...pending, pendingAt: "2026-10-14T00:00:00" } }],
    ],
    ["missing pending", [{ eventType: "inventory.restock-decision.recorded", payload: recorded }]],
    [
      "duplicate pending",
      [
        { eventType: "inventory.restock-decision.pending", payload: pending },
        { eventType: "inventory.restock-decision.pending", payload: pending },
      ],
    ],
    [
      "post-terminal",
      [
        { eventType: "inventory.restock-decision.pending", payload: pending },
        { eventType: "inventory.restock-decision.recorded", payload: recorded },
        { eventType: "inventory.restock-decision.recorded", payload: recorded },
      ],
    ],
  ])("rejects %s before any stock or decision append", async (_name, facts) => {
    const { services, adjustItem, streams, params, streamId } = await harness(facts);
    const before = structuredClone(streams.get(streamId));
    await expect(services.recordDecision(params, context)).rejects.toThrow("reconciliation");
    expect(adjustItem).not.toHaveBeenCalled();
    expect(streams.get(streamId)).toEqual(before);
  });

  it("rejects recorded choices rather than returning the recorded-version shortcut", async () => {
    const { services, adjustItem, params } = await harness([
      { eventType: "inventory.restock-decision.pending", payload: pending },
      { eventType: "inventory.restock-decision.recorded", payload: recorded },
    ]);
    await expect(services.recordDecision(params, context)).rejects.toThrow("conflicts");
    expect(adjustItem).not.toHaveBeenCalled();
  });

  it.each(["restocked", "written-off"] as const)(
    "requires reconciliation for retained split stock before %s",
    async (outcome) => {
      const { services, adjustItem, params, streams, streamId } = await harness(undefined, true);
      await expect(services.recordDecision({ ...params, outcome }, context)).rejects.toThrow("reconciliation");
      expect(adjustItem).not.toHaveBeenCalled();
      expect(streams.get(streamId)).toHaveLength(1);
    },
  );

  it("requires a bound child receipt before stock adjustment", async () => {
    const { deps, adjustItem, params } = await harness();
    const unbound = createRestockDecisionRuntime({ ...deps, mutationChild: undefined }, { adjustItem });
    await expect(unbound.recordDecision(params, context)).rejects.toThrow("mutation authority");
    expect(adjustItem).not.toHaveBeenCalled();
  });

  it("passes the exact stock intent to the typed C1 child receipt seam", async () => {
    const { services, child, params } = await harness();
    await services.recordDecision(params, context);
    expect(child).toHaveBeenCalledWith(
      "restock-stock",
      "item-adjust",
      pending.itemId,
      {
        accountId: pending.accountId,
        itemId: pending.itemId,
        quantityDelta: 2,
        reason: "return-restocked",
        reasonCode: "return-restocked",
        sourceRef: pending.sourceRef,
        acquisitionOccurrence: { kind: "unknown" },
      },
      context,
      expect.any(Function),
    );
  });
});
