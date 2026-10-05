import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  bootstrapContextDatabase,
  createSubscriptionRunner,
  drainContextRuntime,
  loadSubscriptionCheckpoint,
} from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  eventCorePostgresSchemaSql,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { createTransientProjectionError } from "@chase-sets/event-core/projector";
import type { EventRecordToStore, GlobalPosition } from "@chase-sets/event-core/storage";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import { createId } from "@chase-sets/primitives/typed-ids";
import { orderGroupContractVersion, parseAdmissionIdentity } from "@chase-sets/order-groups";
import { module as fulfillmentModule } from "../../../index";
import { buildFulfillmentShipmentProjectionHandlers } from "../read-model/projection";
import { createFulfillmentShipmentRuntime } from "./runtime";

const now = "2026-10-04T00:00:00.000Z";
const context = {
  tenantId: "tnt_admission" as never,
  audit: { performedByUserId: "usr_buyer" as never, forAccountId: "acc_buyer" as never },
};
const admissionKey = "fulfillment-order-group-admission-subscription:ordering:v1";
const orderKey = "fulfillment-order-source-projection:ordering:v1";

describe("Shipment Group admission real-store recovery", () => {
  let pools: Record<"ordering" | "fulfillment", PgTransactionalPool>;
  beforeAll(async () => {
    const adminUrl = process.env.TEST_DATABASE_URL;
    if (!adminUrl) throw new Error("TEST_DATABASE_URL is required for Shipment Group admission DB proof.");
    const urls = createMultiContextTestDatabaseUrls(adminUrl, ["ordering", "fulfillment"], "admission_7198");
    await ensureMultiContextTestDatabases(adminUrl, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.ordering.query(eventCorePostgresSchemaSql);
    await bootstrapContextDatabase(fulfillmentModule, pools.fulfillment);
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  async function fixture(crashAfter?: string) {
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
    const source = createPostgresEventStore({ pool: pools.ordering });
    const target = createPostgresEventStore({ pool: pools.fulfillment });
    const appendToStreams = target.appendToStreams;
    if (!appendToStreams) throw new Error("Admission recovery requires atomic multi-stream append.");
    const checkpointStore = createPostgresProjectionStore({ db: pools.fulfillment });
    let crashed = false;
    let outage = false;
    let outageReads = 0;
    const throwIfOutage = () => {
      if (outage) {
        throw createTransientProjectionError("Synthetic crash after durable admission append, before acknowledgement.");
      }
    };
    const eventStore: EventStore = {
      ...target,
      readStream: async (input) => {
        // Replay may need no append, so the outage must also fence authoritative reads.
        if (outage) outageReads += 1;
        throwIfOutage();
        return target.readStream(input);
      },
      appendToStream: async (input) => {
        throwIfOutage();
        const result = await target.appendToStream(input);
        if (!crashed && input.events.some((event) => event.eventType === crashAfter)) {
          crashed = true;
          outage = true;
          throwIfOutage();
        }
        return result;
      },
      appendToStreams: async (input) => {
        throwIfOutage();
        const result = await appendToStreams(input);
        if (!crashed && input.some((append) => append.events.some((event) => event.eventType === crashAfter))) {
          crashed = true;
          outage = true;
          throwIfOutage();
        }
        return result;
      },
    };
    const runtime = createFulfillmentShipmentRuntime({ eventStore, db: pools.fulfillment, checkpointStore });
    const streamId = `fulfillment.shipment-${identity.anchorShipmentId}`;
    const sourceStream = `ordering.order-${identity.anchorOrderId}`;
    await runtime.commandHandler({
      streamId,
      context,
      command: {
        type: "CreateShipment",
        shipmentId: identity.anchorShipmentId,
        orderId: identity.anchorOrderId,
        buyerAccountId: "acc_buyer" as never,
        sellerAccountId: "acc_seller" as never,
        shippingOption: "standard",
        createdAt: now,
        shippingDestinationSnapshot: {
          name: "Buyer",
          line1: "1 Main",
          city: "Austin",
          state: "TX",
          postalCode: "78701",
          country: "US",
        },
        shippingOriginSnapshot: {
          name: "Seller",
          line1: "2 Main",
          city: "Austin",
          state: "TX",
          postalCode: "78701",
          country: "US",
        },
        lines: [
          {
            lineId: createId("spl"),
            orderLineId: "line",
            catalogItemId: createId("cat"),
            productId: "cat_test::",
            itemTitle: "Card",
            itemSubtitle: null,
            productSummary: null,
            quantity: 1,
          },
        ],
      },
    });
    const read = () => readCompleteStream(target, { streamId });
    const created = (await read())[0]!;
    const projectors = buildFulfillmentShipmentProjectionHandlers(pools.fulfillment);
    await projectors[created.eventType]!(toTransportEvent(created));
    const services = { ...fulfillmentModule.createServices(pools.fulfillment, {}), shipments: runtime };
    if (!fulfillmentModule.buildSubscriptions) throw new Error("Fulfillment subscriptions must be mounted.");
    const subscriptions = fulfillmentModule.buildSubscriptions(services);
    const runner = (projectionName = "fulfillment-order-group-admission-subscription") => {
      const subscription = subscriptions.find((entry) => entry.projectionName === projectionName);
      if (!subscription) throw new Error(`Missing subscription ${projectionName}`);
      return createSubscriptionRunner("fulfillment", pools.fulfillment, pools.ordering, subscription);
    };
    let version = 0;
    const append = async (eventType: string, payload: EventRecordToStore["payload"]) => {
      const events = await source.appendToStream({
        streamId: sourceStream,
        expectedVersion: version,
        context,
        events: [{ eventType, payload }],
      });
      version += 1;
      return events[0]!;
    };
    const pad = async (count: number) => {
      await source.appendToStream({
        streamId: sourceStream,
        expectedVersion: version,
        context,
        events: Array.from({ length: count }, (_, index) => ({
          eventType: "ordering.synthetic-private",
          payload: { index },
        })),
      });
      version += count;
    };
    const base = { contractVersion: orderGroupContractVersion, ...identity };
    const request = () =>
      append("ordering.order-group.admission-requested", {
        ...base,
        requestedAt: now,
        anchorOrderVersion: version + 1,
      });
    const form = () =>
      append("ordering.order-group.formed", {
        ...base,
        formedAt: now,
        anchorOrderVersion: version + 1,
        stagedMemberOrderVersion: 1,
        memberOrderIds: [identity.anchorOrderId, identity.proposedMemberOrderId],
      });
    const abort = () =>
      append("ordering.order-group.admission-aborted", {
        ...base,
        abortedAt: now,
        reason: "cancelled",
        anchorOrderVersion: version + 1,
      });
    const removal = (removedOrderId: string) => ({
      contractVersion: orderGroupContractVersion,
      requestId: identity.requestId,
      groupId: identity.groupId,
      anchorOrderId: identity.anchorOrderId,
      anchorShipmentId: identity.anchorShipmentId,
      memberOrderIds: [identity.anchorOrderId, identity.proposedMemberOrderId],
      removedOrderId,
      reason: "buyer-cancelled",
    });
    const remove = (id = identity.proposedMemberOrderId) =>
      append("ordering.order-group.member-removed", {
        ...removal(id),
        removedAt: now,
        anchorOrderVersion: version + 1,
      });
    const dissolve = (id = identity.proposedMemberOrderId) =>
      append("ordering.order-group.dissolved", { ...removal(id), dissolvedAt: now, anchorOrderVersion: version + 1 });
    const cancel = () =>
      append("ordering.order.cancelled", {
        orderId: identity.anchorOrderId,
        cancelledAt: now,
        reason: "buyer-cancelled",
      });
    const expectClean = async () => {
      expect(await checkpointStore.listPoisonEvents!(admissionKey)).toEqual([]);
      expect(await checkpointStore.listPoisonEvents!(orderKey)).toEqual([]);
      expect(await checkpointStore.listBlockedStreams!(admissionKey)).toEqual([]);
    };
    const startAfter = async (position: GlobalPosition) => {
      // Synthetic delivery checkpoint: earlier source facts are durable, but their Shipment effects are absent.
      await pools.fulfillment.query(
        `INSERT INTO event_subscription_checkpoints
        (checkpoint_key, projection_name, source_context_name, subscription_version, last_global_position, updated_at)
        VALUES ($1, 'fulfillment-order-group-admission-subscription', 'ordering', 1, $2, now())
        ON CONFLICT (checkpoint_key) DO UPDATE SET last_global_position = EXCLUDED.last_global_position`,
        [admissionKey, position],
      );
      await pools.fulfillment.query(
        `INSERT INTO event_projection_recovery_markers
        (projection_kind, projection_key, last_global_position, updated_at) VALUES ('subscription', $1, $2, now())
        ON CONFLICT (projection_kind, projection_key) DO UPDATE SET last_global_position = EXCLUDED.last_global_position`,
        [admissionKey, position],
      );
    };
    return {
      identity,
      source,
      target,
      streamId,
      sourceStream,
      runtime,
      read,
      runner,
      request,
      form,
      abort,
      remove,
      dissolve,
      cancel,
      append,
      pad,
      checkpointStore,
      subscriptions,
      expectClean,
      startAfter,
      crashed: () => crashed,
      outageReads: () => outageReads,
      recover: () => {
        outage = false;
      },
    };
  }

  it.each(["request", "form", "abort", "dissolve"] as const)(
    "recovers durable %s with missing admission receipts and no direct host port",
    async (phase) => {
      const f = await fixture();
      const request = await f.request();
      if (phase !== "request") {
        await f.startAfter(request.globalPosition);
        if (phase === "abort") await f.abort();
        else {
          const form = await f.form();
          if (phase === "dissolve") {
            await f.remove();
            await f.startAfter(form.globalPosition);
            await f.dissolve();
          }
        }
      }
      await f.runner().runOnce();
      const events = await f.read();
      const expected =
        phase === "request"
          ? ["reserved"]
          : phase === "form"
            ? ["reserved", "committed"]
            : phase === "abort"
              ? ["reserved", "released"]
              : ["reserved", "committed", "released"];
      expect(events.slice(1).map((event) => event.eventType.split("admission-")[1])).toEqual(expected);
      await f.runner().runOnce();
      expect(await f.read()).toEqual(events);
      expect(await readCompleteStream(f.source, { streamId: f.streamId })).toEqual([]);
      expect(await readCompleteStream(f.target, { streamId: f.sourceStream })).toEqual([]);
      await f.expectClean();
    },
  );
  it.each(["reserved", "committed", "released"])(
    "converges after %s append crashes before handler acknowledgement",
    async (phase) => {
      const f = await fixture(`fulfillment.shipment-group.admission-${phase}`);
      await f.request();
      await f.form();
      const removed = await f.remove();
      const dissolved = await f.dissolve();
      await f.startAfter(removed.globalPosition);
      await expect(f.runner().runOnce()).rejects.toThrow("Synthetic crash");
      expect(f.crashed()).toBe(true);
      expect(f.outageReads()).toBeGreaterThan(0);
      const durable = await f.read();
      const phases = ["reserved", "committed", "released"];
      expect(durable.slice(1).map((event) => event.eventType.split("admission-")[1])).toEqual(
        phases.slice(0, phases.indexOf(phase) + 1),
      );
      expect(await loadSubscriptionCheckpoint(pools.fulfillment, admissionKey)).toBe(removed.globalPosition);
      await f.expectClean();
      f.recover();
      const recovered = await f.runner().runOnce();
      expect(recovered.processed).toBe(1);
      expect(await loadSubscriptionCheckpoint(pools.fulfillment, admissionKey)).toBe(dissolved.globalPosition);
      expect((await f.read()).slice(1).map((event) => event.eventType.split("admission-")[1])).toEqual([
        "reserved",
        "committed",
        "released",
      ]);
      const original = await f.read();
      expect(original.slice(0, durable.length)).toEqual(durable);
      await f.runner().runOnce();
      expect(await f.read()).toEqual(original);
      await f.expectClean();
    },
  );
  it("finds the decisive request beyond event 500 and isolates old I from N+1", async () => {
    const f = await fixture();
    await f.pad(500);
    const request = await f.request();
    expect(request.streamVersion).toBe(501);
    await f.form();
    const removed = await f.remove();
    await f.dissolve();
    await f.startAfter(removed.globalPosition);
    await f.runner().runOnce();
    const next = {
      ...f.identity,
      requestId: "next",
      sourceGeneration: 2,
      groupId: createId("ogr"),
      quoteFingerprint: "next",
    };
    expect((await f.runtime.shipmentGroupAdmissionAuthority.reserve(next, context)).status).toBe("accepted");
    const before = await f.read();
    // Replay the same durable trigger under a fresh application identity, not just an already-applied row.
    const subscription = f.subscriptions.find(
      (entry) => entry.projectionName === "fulfillment-order-group-admission-subscription",
    )!;
    const replay = createSubscriptionRunner("fulfillment", pools.fulfillment, pools.ordering, {
      ...subscription,
      projectionName: "synthetic-admission-replay",
      subscriptionName: "synthetic-admission-replay",
    });
    await replay.runOnce();
    expect(await f.read()).toEqual(before);
    await f.expectClean();
  });
  it.each(["missing request", "wrong identity", "post-Form Abort"])(
    "quarantines %s with no admission write",
    async (problem) => {
      const f = await fixture();
      if (problem !== "missing request") await f.request();
      if (problem === "wrong identity") {
        await f.append("ordering.order-group.formed", {
          contractVersion: orderGroupContractVersion,
          ...f.identity,
          quoteFingerprint: "foreign",
          formedAt: now,
          anchorOrderVersion: 2,
          stagedMemberOrderVersion: 1,
          memberOrderIds: [f.identity.anchorOrderId, f.identity.proposedMemberOrderId],
        });
      } else await f.form();
      if (problem === "post-Form Abort") {
        await f.abort();
      }
      const source = await readCompleteStream(f.source, { streamId: f.sourceStream });
      if (source.length > 1) await f.startAfter(source.at(-2)!.globalPosition);
      await f.runner().runOnce();
      expect(await f.read()).toHaveLength(1);
      expect(await f.checkpointStore.listPoisonEvents!(admissionKey)).toHaveLength(1);
      expect(await f.checkpointStore.listBlockedStreams!(admissionKey)).toHaveLength(1);
    },
  );
  it("release/cancellation reordering: cancel-before-Abort retries without poison, then resumes", async () => {
    const f = await fixture();
    await f.request();
    await f.runner().runOnce();
    await f.cancel();
    const orderRunner = f.runner("fulfillment-order-source-projection");
    await expect(orderRunner.runOnce()).rejects.toMatchObject({ projectionFailureKind: "transient" });
    expect((await f.read()).map((event) => event.eventType)).not.toContain("fulfillment.shipment.cancelled");
    await f.abort();
    // Deliberately reversed: the production context drain must apply manifest order15 before order20.
    await drainContextRuntime({ subscriptionRunners: [f.runner("fulfillment-order-source-projection"), f.runner()] });
    expect((await f.read()).slice(-2).map((event) => event.eventType)).toEqual([
      "fulfillment.shipment-group.admission-released",
      "fulfillment.shipment.cancelled",
    ]);
    await f.expectClean();
  });
  it.each(["anchor", "proposed"] as const)(
    "release/cancellation reordering: dissolved before raw cancel releases once and preserves the %s survivor rule",
    async (removedMember) => {
      const f = await fixture();
      await f.request();
      await f.form();
      const removedId = removedMember === "anchor" ? f.identity.anchorOrderId : f.identity.proposedMemberOrderId;
      const removed = await f.remove(removedId);
      await f.dissolve(removedId);
      await f.startAfter(removed.globalPosition);
      await f.runner().runOnce();
      if (removedMember === "anchor") {
        await f.cancel();
        await f.runner("fulfillment-order-source-projection").runOnce();
      }
      const events = await f.read();
      const releases = events.filter((event) => event.eventType === "fulfillment.shipment-group.admission-released");
      expect(releases).toHaveLength(1);
      expect(releases[0]!.payload.reason).toBe("group-dissolved");
      expect(events.filter((event) => event.eventType === "fulfillment.shipment.cancelled")).toHaveLength(
        removedMember === "anchor" ? 1 : 0,
      );
      await f.runner().runOnce();
      expect(await f.read()).toEqual(events);
      await f.expectClean();
    },
  );
});
