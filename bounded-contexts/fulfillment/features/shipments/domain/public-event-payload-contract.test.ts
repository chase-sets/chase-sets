import { describe, expect, it } from "vitest";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type {
  FulfillmentShipmentCancelledPayload,
  FulfillmentShipmentCreatedPayload,
  FulfillmentShipmentDeliveredPayload,
  FulfillmentShipmentDispatchedPayload,
  FulfillmentShipmentLabelAttachedPayload,
  FulfillmentShipmentLabelRefundStatusRecordedPayload,
  FulfillmentShipmentPackagePreparedPayload,
  FulfillmentShipmentPackingStartedPayload,
} from "@chase-sets/event-core/public-event-payloads";
import type {
  ShipmentCancelledEvent,
  ShipmentCreatedEvent,
  ShipmentDeliveredEvent,
  ShipmentDispatchedEvent,
  ShipmentLabelAttachedEvent,
  ShipmentLabelRefundStatusRecordedEvent,
  ShipmentPackagePreparedEvent,
  ShipmentPackingStartedEvent,
} from "./domain";

type EventData<TEvent extends Readonly<{ data: unknown }>> = TEvent["data"];
type IsAssignable<Source, Target> = [Source] extends [Target] ? true : false;
type HasSameKeys<Left, Right> = [Exclude<keyof Left, keyof Right>, Exclude<keyof Right, keyof Left>] extends [
  never,
  never,
]
  ? true
  : false;

const publisherToPublicPayloadType = {
  "fulfillment.shipment.created": {
    publisherAssignable: true satisfies IsAssignable<
      EventData<ShipmentCreatedEvent>,
      FulfillmentShipmentCreatedPayload
    >,
    sameKeys: true satisfies HasSameKeys<EventData<ShipmentCreatedEvent>, FulfillmentShipmentCreatedPayload>,
  },
  "fulfillment.shipment.packing-started": {
    publisherAssignable: true satisfies IsAssignable<
      EventData<ShipmentPackingStartedEvent>,
      FulfillmentShipmentPackingStartedPayload
    >,
    sameKeys: true satisfies HasSameKeys<
      EventData<ShipmentPackingStartedEvent>,
      FulfillmentShipmentPackingStartedPayload
    >,
  },
  "fulfillment.shipment.package-prepared": {
    publisherAssignable: true satisfies IsAssignable<
      EventData<ShipmentPackagePreparedEvent>,
      FulfillmentShipmentPackagePreparedPayload
    >,
    sameKeys: true satisfies HasSameKeys<
      EventData<ShipmentPackagePreparedEvent>,
      FulfillmentShipmentPackagePreparedPayload
    >,
  },
  "fulfillment.shipment.label-attached": {
    publisherAssignable: true satisfies IsAssignable<
      EventData<ShipmentLabelAttachedEvent>,
      FulfillmentShipmentLabelAttachedPayload
    >,
    sameKeys: true satisfies HasSameKeys<
      EventData<ShipmentLabelAttachedEvent>,
      FulfillmentShipmentLabelAttachedPayload
    >,
  },
  "fulfillment.shipment.label-refund-status-recorded": {
    publisherAssignable: true satisfies IsAssignable<
      EventData<ShipmentLabelRefundStatusRecordedEvent>,
      FulfillmentShipmentLabelRefundStatusRecordedPayload
    >,
    sameKeys: true satisfies HasSameKeys<
      EventData<ShipmentLabelRefundStatusRecordedEvent>,
      FulfillmentShipmentLabelRefundStatusRecordedPayload
    >,
  },
  "fulfillment.shipment.dispatched": {
    publisherAssignable: true satisfies IsAssignable<
      EventData<ShipmentDispatchedEvent>,
      FulfillmentShipmentDispatchedPayload
    >,
    sameKeys: true satisfies HasSameKeys<EventData<ShipmentDispatchedEvent>, FulfillmentShipmentDispatchedPayload>,
  },
  "fulfillment.shipment.delivered": {
    publisherAssignable: true satisfies IsAssignable<
      EventData<ShipmentDeliveredEvent>,
      FulfillmentShipmentDeliveredPayload
    >,
    sameKeys: true satisfies HasSameKeys<EventData<ShipmentDeliveredEvent>, FulfillmentShipmentDeliveredPayload>,
  },
  "fulfillment.shipment.cancelled": {
    publisherAssignable: true satisfies IsAssignable<
      EventData<ShipmentCancelledEvent>,
      FulfillmentShipmentCancelledPayload
    >,
    sameKeys: true satisfies HasSameKeys<EventData<ShipmentCancelledEvent>, FulfillmentShipmentCancelledPayload>,
  },
} as const;

describe("fulfillment public event payload contract", () => {
  it("keeps every covered publisher shape assignable with the same field names", () => {
    expect(Object.values(publisherToPublicPayloadType).every((mapping) => mapping.publisherAssignable)).toBe(true);
    expect(Object.values(publisherToPublicPayloadType).every((mapping) => mapping.sameKeys)).toBe(true);
  });
});

describe("shipment-label-refund-public-contract", () => {
  it("decodes retained payloads without an original label identity", () => {
    const codec = createPassthroughDomainEventCodec<ShipmentLabelRefundStatusRecordedEvent>();
    const retained = codec.decode({
      eventType: "fulfillment.shipment.label-refund-status-recorded",
      payload: {
        shipmentId: "shp_retained",
        refundStatus: "refunded",
        refundReference: "refund_retained",
        resolvedAt: "2026-09-09T00:00:00.000Z",
      },
    });

    expect(retained.data).toEqual({
      shipmentId: "shp_retained",
      refundStatus: "refunded",
      refundReference: "refund_retained",
      resolvedAt: "2026-09-09T00:00:00.000Z",
    });
    expect("postageProviderLabelId" in retained.data).toBe(false);
  });
});
