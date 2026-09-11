import { describe, expect, it } from "vitest";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  decideFulfillmentShipment,
  evolveFulfillmentShipment,
  initialFulfillmentShipmentState,
  type FulfillmentShipmentEvent,
} from "./domain";
import {
  assertCanonicalFulfillmentMutationId,
  executeFulfillmentMutationAttempt,
  fulfillmentMutationAttemptStreamId,
  fulfillmentMutationRequestHash,
  FulfillmentMutationConflictError,
  readFulfillmentMutationAttempt,
} from "./mutation-attempt";

const context = {
  tenantId: "tnt_1",
  audit: { performedByUserId: "usr_1", forAccountId: "acc_seller" },
} as EventStoreContext;
const key = "018f47d2-9d2a-4d68-8f33-6fb718c3f001";

async function harness() {
  const store = createInMemoryEventStore();
  const aggregate = createAggregateCommandHandler({
    eventStore: store.eventStore,
    codec: createPassthroughDomainEventCodec<FulfillmentShipmentEvent>(),
    initialState: () => initialFulfillmentShipmentState,
    evolve: evolveFulfillmentShipment,
    decide: decideFulfillmentShipment,
  });
  await aggregate.commandHandler({
    streamId: "fulfillment.shipment-shp_1",
    context,
    command: {
      type: "CreateShipment",
      shipmentId: "shp_1" as never,
      orderId: "ord_1" as never,
      buyerAccountId: "acc_buyer" as never,
      sellerAccountId: "acc_seller" as never,
      shippingOption: "standard",
      shippingDestinationSnapshot: {
        name: "Buyer",
        line1: "2 Main",
        city: "Chicago",
        state: "IL",
        postalCode: "60601",
        country: "US",
      },
      shippingOriginSnapshot: {
        name: "Seller",
        line1: "1 Main",
        city: "Austin",
        state: "TX",
        postalCode: "78701",
        country: "US",
      },
      lines: [
        {
          lineId: "spl_1" as never,
          orderLineId: "oln_1",
          catalogItemId: "cat_1" as never,
          productId: "prd_1" as never,
          itemTitle: "Card",
          itemSubtitle: null,
          productSummary: null,
          quantity: 1,
        },
      ],
      createdAt: "2026-08-23T00:00:00.000Z",
    },
  });
  return { ...store, ...aggregate };
}

describe("issue-7171-key-hash-and-mcp-boundary", () => {
  it("accepts only canonical lower-case UUIDv4 identities", () => {
    expect(() => assertCanonicalFulfillmentMutationId(key)).not.toThrow();
    for (const invalid of ["a", "", key.toUpperCase(), "018f47d2-9d2a-1d68-8f33-6fb718c3f001", `${key}x`]) {
      expect(() => assertCanonicalFulfillmentMutationId(invalid)).toThrow("canonical UUIDv4");
    }
  });

  it("keeps canonical request ordering codepoint-stable without locale collation", () => {
    const original = String.prototype.localeCompare;
    String.prototype.localeCompare = () => {
      throw new Error("persisted hashes must not use locale collation");
    };
    try {
      expect(fulfillmentMutationRequestHash({ z: 1, a: 2, ä: 3 })).toBe(
        fulfillmentMutationRequestHash({ ä: 3, a: 2, z: 1 }),
      );
      expect(fulfillmentMutationRequestHash({ "😀": 1, "\uE000": 2 })).toBe(
        "8f8e9ebe2fb50531573f8fa2ed4e6df97cedc7452f67bf0260b2c2a101ff7264",
      );
    } finally {
      String.prototype.localeCompare = original;
    }
  });
});

describe("Fulfillment mutation attempt unit behavior", () => {
  it("atomically records one Shipment fact and one permanent receipt, then replays read-only", async () => {
    const runtime = await harness();
    const execute = () =>
      executeFulfillmentMutationAttempt({
        eventStore: runtime.eventStore,
        loadShipment: runtime.repository.load,
        context,
        mutationAttemptId: key,
        subjectKind: "shipment",
        subjectId: "shp_1",
        sellerAccountId: "acc_seller",
        commandKind: "start-packing",
        request: {},
        createCommand: () => ({ type: "StartShipmentPacking", startedAt: "2026-08-23T00:01:00.000Z" }),
        successStatus: "packing",
      });

    const first = await execute();
    const replay = await execute();
    expect(first).toMatchObject({ resultClass: "succeeded", subjectVersion: 2, replayed: false });
    expect(replay).toMatchObject({ resultClass: "succeeded", subjectVersion: 2, replayed: true });
    expect(await runtime.eventStore.readStream({ streamId: "fulfillment.shipment-shp_1" })).toHaveLength(2);
    expect(
      await runtime.eventStore.readStream({
        streamId: fulfillmentMutationAttemptStreamId({
          tenantId: "tnt_1",
          sellerAccountId: "acc_seller",
          subjectKind: "shipment",
          subjectId: "shp_1",
          key,
        }),
      }),
    ).toHaveLength(1);
  });

  it("rejects same-key changed requests without another Shipment fact", async () => {
    const runtime = await harness();
    const base = {
      eventStore: runtime.eventStore,
      loadShipment: runtime.repository.load,
      context,
      mutationAttemptId: key,
      subjectKind: "shipment" as const,
      subjectId: "shp_1",
      sellerAccountId: "acc_seller",
      commandKind: "set-packing-line-quantity",
      target: "spl_1",
      createCommand: () => ({
        type: "SetShipmentPackingLineQuantity" as const,
        lineId: "spl_1" as never,
        confirmedQuantity: 1,
        setAt: "2026-08-23T00:01:00.000Z",
      }),
      successStatus: "quantity-set",
    };
    await executeFulfillmentMutationAttempt({ ...base, request: { confirmedQuantity: 1 } });
    await expect(
      executeFulfillmentMutationAttempt({ ...base, request: { confirmedQuantity: 0 } }),
    ).rejects.toBeInstanceOf(FulfillmentMutationConflictError);
    expect(await runtime.eventStore.readStream({ streamId: "fulfillment.shipment-shp_1" })).toHaveLength(1);
  });
});

describe("fulfillment-mutation-attempt-subject", () => {
  it("replays a stored Shipment receipt without changing its historical stream identity", async () => {
    const runtime = await harness();
    const streamId = fulfillmentMutationAttemptStreamId({
      tenantId: "tnt_1",
      sellerAccountId: "acc_seller",
      subjectKind: "shipment",
      subjectId: "shp_1",
      key,
    });
    await runtime.eventStore.appendToStream({
      streamId,
      expectedVersion: "no_stream",
      context,
      events: [
        {
          eventType: "fulfillment.shipment.mutation-attempt-closed.v1",
          payload: {
            schemaVersion: 1,
            receiptKind: "shipment-attempt",
            commandKind: "start-packing",
            shipmentId: "shp_1",
            target: null,
            requestHash: fulfillmentMutationRequestHash({
              schemaVersion: 1,
              commandKind: "start-packing",
              tenantId: "tnt_1",
              sellerAccountId: "acc_seller",
              shipmentId: "shp_1",
              target: null,
            }),
            resultClass: "succeeded",
            reason: "applied",
            shipmentVersion: 2,
            response: { shipmentId: "shp_1", version: 2, status: "packing" },
          },
        },
      ],
    });

    await expect(
      executeFulfillmentMutationAttempt({
        eventStore: runtime.eventStore,
        loadShipment: runtime.repository.load,
        context,
        mutationAttemptId: key,
        subjectKind: "shipment",
        subjectId: "shp_1",
        sellerAccountId: "acc_seller",
        commandKind: "start-packing",
        request: {},
        createCommand: () => ({ type: "StartShipmentPacking", startedAt: "2026-08-23T00:01:00.000Z" }),
        successStatus: "packing",
      }),
    ).resolves.toMatchObject({ replayed: true, subjectKind: "shipment", subjectId: "shp_1" });
    expect(await runtime.eventStore.readStream({ streamId: "fulfillment.shipment-shp_1" })).toHaveLength(1);
  });

  it("rejects a receipt whose subject kind differs even when the subject id is identical", async () => {
    const runtime = await harness();
    const wrongKindKey = "418f47d2-9d2a-4d68-8f33-6fb718c3f005";
    const streamId = fulfillmentMutationAttemptStreamId({
      tenantId: "tnt_1",
      sellerAccountId: "acc_seller",
      subjectKind: "shipment",
      subjectId: "same-id",
      key: wrongKindKey,
    });
    await runtime.eventStore.appendToStream({
      streamId,
      expectedVersion: "no_stream",
      context,
      events: [
        {
          eventType: "fulfillment.mutation-attempt-closed.v1",
          payload: {
            schemaVersion: 1,
            receiptKind: "fulfillment-attempt",
            commandKind: "test",
            subjectKind: "channel-fulfillment-record",
            subjectId: "same-id",
            target: null,
            requestHash: "hash",
            resultClass: "unchanged",
            reason: "already-equivalent",
            shipmentVersion: 1,
            response: { shipmentId: "same-id", version: 1, status: "unchanged" },
          },
        },
      ],
    });

    await expect(
      readFulfillmentMutationAttempt({
        eventStore: runtime.eventStore,
        context,
        key: wrongKindKey,
        subjectKind: "shipment",
        subjectId: "same-id",
        sellerAccountId: "acc_seller",
      }),
    ).rejects.toBeInstanceOf(FulfillmentMutationConflictError);
  });
});

describe("issue-7171-packing-partial-recovery", () => {
  it("keeps each packing-line result independent and never replays the successful line fact", async () => {
    const runtime = await harness();
    await runtime.commandHandler({
      streamId: "fulfillment.shipment-shp_1",
      context,
      command: { type: "StartShipmentPacking", startedAt: "2026-08-23T00:01:00.000Z" },
    });
    const successful = {
      eventStore: runtime.eventStore,
      loadShipment: runtime.repository.load,
      context,
      mutationAttemptId: "128f47d2-9d2a-4d68-8f33-6fb718c3f002",
      subjectKind: "shipment" as const,
      subjectId: "shp_1",
      sellerAccountId: "acc_seller",
      commandKind: "confirm-packing-line",
      target: "spl_1",
      request: {},
      createCommand: () => ({
        type: "ConfirmShipmentPackingLine" as const,
        lineId: "spl_1" as never,
        confirmedAt: "2026-08-23T00:02:00.000Z",
      }),
      successStatus: "confirmed",
    };
    const refused = await executeFulfillmentMutationAttempt({
      ...successful,
      mutationAttemptId: "228f47d2-9d2a-4d68-8f33-6fb718c3f003",
      commandKind: "set-packing-line-quantity",
      request: { confirmedQuantity: 2 },
      createCommand: () => ({
        type: "SetShipmentPackingLineQuantity" as const,
        lineId: "spl_1" as never,
        confirmedQuantity: 2,
        setAt: "2026-08-23T00:03:00.000Z",
      }),
    });
    const first = await executeFulfillmentMutationAttempt(successful);
    const replay = await executeFulfillmentMutationAttempt(successful);

    expect(first).toMatchObject({ resultClass: "succeeded", replayed: false });
    expect(replay).toMatchObject({ resultClass: "succeeded", replayed: true });
    expect(refused).toMatchObject({ resultClass: "failed-safe", reason: "inventory-mismatch" });
    const shipmentEvents = await runtime.eventStore.readStream({ streamId: "fulfillment.shipment-shp_1" });
    expect(
      shipmentEvents.filter((event) => event.eventType === "fulfillment.shipment.packing-line-confirmed"),
    ).toHaveLength(1);
  });
});

describe("issue-7171-recovery-privacy-allowlist", () => {
  it("serializes only the closed receipt allowlist and never the raw key, digest, provider, label, tracking, address, or error", async () => {
    const runtime = await harness();
    const receipt = await executeFulfillmentMutationAttempt({
      eventStore: runtime.eventStore,
      loadShipment: runtime.repository.load,
      context,
      mutationAttemptId: key,
      subjectKind: "shipment",
      subjectId: "shp_1",
      sellerAccountId: "acc_seller",
      commandKind: "start-packing",
      request: {},
      createCommand: () => ({ type: "StartShipmentPacking", startedAt: "2026-08-23T00:01:00.000Z" }),
      successStatus: "packing",
    });
    const attemptEvents = await runtime.eventStore.readStream({
      streamId: fulfillmentMutationAttemptStreamId({
        tenantId: "tnt_1",
        sellerAccountId: "acc_seller",
        subjectKind: "shipment",
        subjectId: "shp_1",
        key,
      }),
    });
    const serialized = JSON.stringify({ receipt, event: attemptEvents[0]?.payload });

    expect(serialized).not.toContain(key);
    for (const forbidden of [
      "keyDigest",
      "providerLabelId",
      "providerShipmentId",
      "labelDocumentUrl",
      "trackingIdentifier",
      "shippingDestinationSnapshot",
      "rawError",
      "signature",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
