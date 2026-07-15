import { describe, expect, it } from "vitest";
import { buildTransportEvent, createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { createSupportHoldLifecycleRuntime } from "./support-hold-lifecycle-runtime";
import {
  buildSupportHoldLifecycleReactionHandlers,
  type SupportHoldLifecyclePort,
} from "./support-hold-lifecycle-reaction";

function event(type: string, data: Record<string, unknown>, streamVersion = 1): TransportEvent {
  return buildTransportEvent(type, data, {
    id: `evt_${type}_${streamVersion}`,
    streamId: "support.support-request-sup_01ABC",
    streamVersion,
    globalPosition: String(streamVersion),
    tenantId: "tnt_test",
    audit: { performedByUserId: "usr_test", forAccountId: "acc_buyer" },
    timing: { occurredAt: "2026-05-31T14:00:00.000Z", recordedAt: "2026-05-31T14:00:00.000Z" },
  });
}

const openedEvent = event("support.support-request.opened", {
  supportRequestId: "sup_01ABC",
  orderId: "ord_1",
  buyerAccountId: "acc_buyer",
  sellerAccountId: "acc_seller",
  flowType: "product-damaged",
  openedAt: "2026-05-31T14:00:00.000Z",
});

function runtimeWithStore() {
  const store = createInMemoryEventStore();
  const runtime = createSupportHoldLifecycleRuntime({ eventStore: store.eventStore });
  const handlers = buildSupportHoldLifecycleReactionHandlers(runtime);
  return { store, runtime, handlers };
}

function factsOf(store: ReturnType<typeof createInMemoryEventStore>) {
  return store.readAllEvents().map((stored) => ({ type: stored.eventType, data: stored.payload }));
}

describe("support hold lifecycle reaction", () => {
  it("emits a support-safe placed fact when a case opens (the notification-trigger seam)", async () => {
    const { store, handlers } = runtimeWithStore();
    await handlers["support.support-request.opened"]!(openedEvent);

    const facts = factsOf(store);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.type).toBe("settlement.support-hold.placed.v1");
    // Routing: both parties present so the matrix can address seller and buyer.
    expect(facts[0]!.data).toMatchObject({
      holdId: "hold_01ABC",
      supportRequestId: "sup_01ABC",
      orderId: "ord_1",
      buyerAccountId: "acc_buyer",
      sellerAccountId: "acc_seller",
    });
  });

  it("does not leak provider ids, money, or payout-ledger internals", async () => {
    const { store, handlers } = runtimeWithStore();
    await handlers["support.support-request.opened"]!(openedEvent);
    const serialized = JSON.stringify(factsOf(store));
    for (const forbidden of [
      "providerDisputeId",
      "earlyFraudWarningId",
      "amount",
      "ledgerEntryId",
      "payoutId",
      "last_stream_version",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("emits placed then released across the case lifecycle", async () => {
    const { store, handlers } = runtimeWithStore();
    await handlers["support.support-request.opened"]!(openedEvent);
    await handlers["support.support-request.resolved"]!(
      event(
        "support.support-request.resolved",
        {
          supportRequestId: "sup_01ABC",
          resolution: { resolutionType: "seller-not-at-fault", resolvedAt: "2026-06-02T09:00:00.000Z" },
        },
        2,
      ),
    );

    const facts = factsOf(store);
    expect(facts.map((fact) => fact.type)).toEqual([
      "settlement.support-hold.placed.v1",
      "settlement.support-hold.released.v1",
    ]);
    expect(facts[1]!.data).toMatchObject({ releaseReason: "support-resolved", sellerAccountId: "acc_seller" });
  });

  it("emits a consumed fact (never a release) for a refund resolution and stays exact-once on a trailing close", async () => {
    const { store, handlers } = runtimeWithStore();
    await handlers["support.support-request.opened"]!(openedEvent);
    await handlers["support.support-request.resolved"]!(
      event(
        "support.support-request.resolved",
        {
          supportRequestId: "sup_01ABC",
          resolution: { resolutionType: "full-refund", resolvedAt: "2026-06-02T09:00:00.000Z" },
        },
        2,
      ),
    );
    await handlers["support.support-request.closed"]!(
      event(
        "support.support-request.closed",
        { supportRequestId: "sup_01ABC", closedAt: "2026-06-03T09:00:00.000Z" },
        3,
      ),
    );

    expect(factsOf(store).map((fact) => fact.type)).toEqual([
      "settlement.support-hold.placed.v1",
      "settlement.support-hold.consumed.v1",
    ]);
  });

  it("is idempotent on replay: re-running the whole subscription emits no duplicate facts", async () => {
    const { store, handlers } = runtimeWithStore();
    const stream = [
      openedEvent,
      event(
        "support.support-request.resolved",
        {
          supportRequestId: "sup_01ABC",
          resolution: { resolutionType: "seller-not-at-fault", resolvedAt: "2026-06-02T09:00:00.000Z" },
        },
        2,
      ),
    ];
    for (const evt of stream) {
      await handlers[evt.type]!(evt);
    }
    // Full re-delivery of the same events (checkpoint reset / at-least-once redelivery).
    for (const evt of stream) {
      await handlers[evt.type]!(evt);
    }

    expect(factsOf(store).map((fact) => fact.type)).toEqual([
      "settlement.support-hold.placed.v1",
      "settlement.support-hold.released.v1",
    ]);
  });

  it("ignores escalation (neither places nor releases)", () => {
    const calls: string[] = [];
    const port: SupportHoldLifecyclePort = {
      placeHold: async () => (calls.push("place"), { outcome: "placed", holdId: "hold_01ABC" }),
      resolveHold: async () => (calls.push("resolve"), { outcome: "released", holdId: "hold_01ABC" }),
      closeHold: async () => (calls.push("close"), { outcome: "released", holdId: "hold_01ABC" }),
      cancelHold: async () => (calls.push("cancel"), { outcome: "released", holdId: "hold_01ABC" }),
    };
    const handlers = buildSupportHoldLifecycleReactionHandlers(port);
    expect(handlers["support.support-request.escalated"]).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});
