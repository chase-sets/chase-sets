import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTransportEvent, createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { createTransientProjectionError } from "@chase-sets/event-core/projector";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { toTransportEvent, type TransportEvent } from "@chase-sets/event-core/transport";
import { createId } from "@chase-sets/primitives/typed-ids";
import { orderGroupContractVersion, parseAdmissionIdentity } from "@chase-sets/order-groups";
import { createFulfillmentShipmentRuntime } from "../../api/runtime";

const now = "2026-10-04T00:00:00.000Z";
const context = {
  tenantId: "tnt_admission" as never,
  audit: { performedByUserId: "usr_buyer" as never, forAccountId: "acc_buyer" as never },
};
const identity = parseAdmissionIdentity({
  requestId: "request",
  sourceGeneration: 1,
  draftKey: "draft",
  anchorShipmentId: createId("shp"),
  anchorOrderId: createId("ord"),
  proposedMemberOrderId: createId("ord"),
  groupId: createId("ogr"),
  quoteFingerprint: "quote",
});
const address = {
  name: "Test",
  company: null,
  line1: "1 Main St",
  line2: null,
  city: "Austin",
  state: "TX",
  postalCode: "78701",
  country: "US",
  phone: null,
  email: null,
};

async function fixture(wrap: (store: EventStore) => EventStore = (store) => store) {
  const { eventStore: store } = createInMemoryEventStore();
  const runtime = createFulfillmentShipmentRuntime({
    eventStore: wrap(store),
    db: { query: async () => ({ rows: [] }) },
    checkpointStore: { loadCheckpoint: async () => ZERO_GLOBAL_POSITION, saveCheckpoint: async () => undefined },
  });
  await runtime.commandHandler({
    streamId: `fulfillment.shipment-${identity.anchorShipmentId}`,
    context,
    command: {
      type: "CreateShipment",
      shipmentId: identity.anchorShipmentId,
      orderId: identity.anchorOrderId,
      buyerAccountId: "acc_buyer" as never,
      sellerAccountId: "acc_seller" as never,
      shippingOption: "standard",
      shippingDestinationSnapshot: address,
      shippingOriginSnapshot: address,
      createdAt: now,
      lines: [
        {
          lineId: "spl_test" as never,
          orderLineId: "line",
          catalogItemId: "cat_test" as never,
          productId: "cat_test::",
          itemTitle: "Card",
          itemSubtitle: null,
          productSummary: null,
          quantity: 1,
        },
      ],
    },
  });
  const read = () => readCompleteStream(store, { streamId: `fulfillment.shipment-${identity.anchorShipmentId}` });
  return { store, runtime, read };
}

function facts() {
  const source = (type: string, data: Record<string, unknown>, version: number) =>
    buildTransportEvent(type, data as never, {
      id: `evt_${version}`,
      streamId: `ordering.order-${identity.anchorOrderId}`,
      streamVersion: version,
      tenantId: context.tenantId,
      audit: context.audit,
      timing: { occurredAt: now, recordedAt: now },
    });
  const base = { contractVersion: orderGroupContractVersion, ...identity };
  const removal = {
    contractVersion: orderGroupContractVersion,
    requestId: identity.requestId,
    groupId: identity.groupId,
    anchorOrderId: identity.anchorOrderId,
    anchorShipmentId: identity.anchorShipmentId,
    memberOrderIds: [identity.anchorOrderId, identity.proposedMemberOrderId],
    removedOrderId: identity.proposedMemberOrderId,
    reason: "buyer-cancelled",
  };
  const request = source(
    "ordering.order-group.admission-requested",
    { ...base, requestedAt: now, anchorOrderVersion: 1 },
    1,
  );
  const form = source(
    "ordering.order-group.formed",
    {
      ...base,
      memberOrderIds: removal.memberOrderIds,
      formedAt: now,
      anchorOrderVersion: 2,
      stagedMemberOrderVersion: 1,
    },
    2,
  );
  const abort = source(
    "ordering.order-group.admission-aborted",
    { ...base, reason: "cancelled", abortedAt: now, anchorOrderVersion: 2 },
    2,
  );
  const removed = source(
    "ordering.order-group.member-removed",
    { ...removal, removedAt: now, anchorOrderVersion: 3 },
    3,
  );
  const dissolved = source(
    "ordering.order-group.dissolved",
    { ...removal, dissolvedAt: now, anchorOrderVersion: 4 },
    4,
  );
  return { request, form, abort, removed, dissolved };
}

describe("Shipment Group admission source recovery", () => {
  afterEach(() => vi.useRealTimers());
  it("never cancels N+1 when a new reservation and Abort win before old dissolution cancellation", async () => {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    let gated = false;
    const f = await fixture((store) => ({
      ...store,
      appendToStream: async (input) => {
        if (!gated && input.events[0]?.eventType === "fulfillment.shipment.cancelled") {
          gated = true;
          enter();
          await resume;
        }
        return store.appendToStream(input);
      },
    }));
    const source = facts();
    const removed = { ...source.removed, data: { ...source.removed.data, removedOrderId: identity.anchorOrderId } };
    const dissolved = {
      ...source.dissolved,
      data: { ...source.dissolved.data, removedOrderId: identity.anchorOrderId },
    };
    const applying = f.runtime.shipmentGroupAdmissionHandlers[dissolved.type]!(dissolved, {
      readSourceStreamHistory: async () => [source.request, source.form, removed, dissolved],
    });
    await entered;
    const next = {
      ...identity,
      requestId: "next",
      sourceGeneration: 2,
      groupId: createId("ogr"),
      quoteFingerprint: "next",
    };
    expect((await f.runtime.shipmentGroupAdmissionAuthority.reserve(next, context)).status).toBe("accepted");
    await f.runtime.shipmentGroupAdmissionAuthority.abort({ ...next, reason: "cancelled" }, context);
    const before = await f.read();
    release();
    await applying;
    expect(await f.read()).toEqual(before);
    expect(before.some((event) => event.eventType === "fulfillment.shipment.cancelled")).toBe(false);
  });
  it.each(["form", "abort", "dissolved"] as const)(
    "recovers early %s, preserves recorded bytes next day",
    async (kind) => {
      vi.useFakeTimers();
      vi.setSystemTime(now);
      const { runtime, read } = await fixture();
      const f = facts();
      const history =
        kind === "abort"
          ? [f.request, f.abort]
          : kind === "form"
            ? [f.request, f.form]
            : [f.request, f.form, f.removed, f.dissolved];
      const event = history.at(-1)!;
      const handler = runtime.shipmentGroupAdmissionHandlers[event.type]!;
      await handler(event, { readSourceStreamHistory: async () => history });
      const recorded = await read();
      expect(recorded.slice(1).map((entry) => entry.eventType.split("admission-")[1])).toEqual(
        kind === "dissolved"
          ? ["reserved", "committed", "released"]
          : kind === "form"
            ? ["reserved", "committed"]
            : ["reserved", "released"],
      );
      vi.setSystemTime("2026-10-05T00:00:00.000Z");
      await handler(event, { readSourceStreamHistory: async () => history });
      expect(await read()).toEqual(recorded);
      if (kind !== "form") {
        const next = {
          ...identity,
          requestId: "next",
          sourceGeneration: 2,
          groupId: createId("ogr"),
          quoteFingerprint: "next",
        };
        expect((await runtime.shipmentGroupAdmissionAuthority.reserve(next, context)).status).toBe("accepted");
        const newer = await read();
        await handler(event, { readSourceStreamHistory: async () => history });
        expect(await read()).toEqual(newer);
      }
    },
  );
  it.each(["form", "abort", "rejection"] as const)(
    "has byte-identical direct and worker %s authority facts at a fixed clock",
    async (kind) => {
      vi.useFakeTimers();
      vi.setSystemTime(now);
      const direct = await fixture();
      const worker = await fixture();
      const f = facts();
      if (kind === "rejection") {
        for (const fixture of [direct, worker])
          await fixture.runtime.commandHandler({
            streamId: `fulfillment.shipment-${identity.anchorShipmentId}`,
            context,
            command: { type: "StartShipmentPacking", startedAt: now },
          });
      }
      await direct.runtime.shipmentGroupAdmissionAuthority.reserve(identity, context);
      if (kind === "form")
        await direct.runtime.shipmentGroupAdmissionAuthority.commit({ ...identity, anchorOrderVersion: 2 }, context);
      if (kind === "abort")
        await direct.runtime.shipmentGroupAdmissionAuthority.abort({ ...identity, reason: "cancelled" }, context);
      const trigger = kind === "rejection" ? f.request : kind === "form" ? f.form : f.abort;
      await worker.runtime.shipmentGroupAdmissionHandlers[trigger.type]!(trigger, {
        readSourceStreamHistory: async () => [f.request, trigger],
      });
      expect((await worker.read()).slice(1).map((event) => event.payload)).toEqual(
        (await direct.read()).slice(1).map((event) => event.payload),
      );
      expect(
        (await worker.read())
          .filter((event) => event.eventType.startsWith("fulfillment.shipment-group."))
          .every((event) => event.metadata.causationId === trigger.id),
      ).toBe(true);
    },
  );
  it.each([
    "missing request",
    "missing form",
    "wrong tenant",
    "extra field",
    "ambiguous form",
    "post-Form Abort",
    "wrong version",
  ])("poisons %s without any admission write", async (problem) => {
    const { runtime, read } = await fixture();
    const f = facts();
    let history: TransportEvent[] = [f.request, f.form, f.removed, f.dissolved];
    if (problem === "missing request") history.shift();
    if (problem === "missing form") history.splice(1, 1);
    if (problem === "wrong tenant") history[0] = { ...f.request, tenantId: "tnt_foreign" as never };
    if (problem === "extra field") history[0] = { ...f.request, data: { ...f.request.data, lease: "forbidden" } };
    if (problem === "ambiguous form") history.splice(2, 0, f.form);
    if (problem === "post-Form Abort")
      history = [f.request, f.form, { ...f.abort, streamVersion: 3, data: { ...f.abort.data, anchorOrderVersion: 3 } }];
    if (problem === "wrong version") history[1] = { ...f.form, data: { ...f.form.data, anchorOrderVersion: 9 } };
    const event = history.at(-1)!;
    await expect(
      runtime.shipmentGroupAdmissionHandlers[event.type]!(event, { readSourceStreamHistory: async () => history }),
    ).rejects.toThrow();
    expect(await read()).toHaveLength(1);
  });
  it("replays rejection on early Abort and never fabricates a release", async () => {
    const { runtime, read } = await fixture();
    const f = facts();
    await runtime.commandHandler({
      streamId: `fulfillment.shipment-${identity.anchorShipmentId}`,
      context,
      command: { type: "StartShipmentPacking", startedAt: now },
    });
    expect((await runtime.shipmentGroupAdmissionAuthority.reserve(identity, context)).status).toBe("packing-started");
    const before = await read();
    await runtime.shipmentGroupAdmissionHandlers[f.abort.type]!(f.abort, {
      readSourceStreamHistory: async () => [f.request, f.abort],
    });
    expect(await read()).toEqual(before);
  });
  it("does not write on unavailable history, missing capability, or lost lease", async () => {
    const { runtime, read } = await fixture();
    const f = facts();
    const handler = runtime.shipmentGroupAdmissionHandlers[f.form.type]!;
    const unavailable = createTransientProjectionError("source unavailable");
    await expect(
      handler(f.form, {
        readSourceStreamHistory: async () => {
          throw unavailable;
        },
      }),
    ).rejects.toBe(unavailable);
    await expect(handler(f.form)).rejects.toThrow("capability");
    await expect(
      handler(f.form, {
        throwIfLeaseLost: () => {
          throw new Error("lease lost");
        },
      }),
    ).rejects.toThrow("lease lost");
    expect(await read()).toHaveLength(1);
  });
  it("member removal validates but never releases", async () => {
    const { runtime, read } = await fixture();
    const f = facts();
    await runtime.shipmentGroupAdmissionHandlers[f.form.type]!(f.form, {
      readSourceStreamHistory: async () => [f.request, f.form],
    });
    const before = await read();
    await runtime.shipmentGroupAdmissionHandlers[f.removed.type]!(f.removed, {
      readSourceStreamHistory: async () => [f.request, f.form, f.removed],
    });
    expect(await read()).toEqual(before);
    expect(toTransportEvent(before.at(-1)!).type).toBe("fulfillment.shipment-group.admission-committed");
  });
});
