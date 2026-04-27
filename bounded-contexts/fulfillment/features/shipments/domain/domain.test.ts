import { describe, expect, it } from "vitest";
import {
  decideFulfillmentShipment,
  evolveFulfillmentShipment,
  initialFulfillmentShipmentState,
} from "./domain";

describe("fulfillment shipment domain", () => {
  it("moves a shipment through packing, labeling, dispatch, and delivery", () => {
    const createdState = decideFulfillmentShipment(initialFulfillmentShipmentState, {
      type: "CreateShipment",
      shipmentId: "shp_1" as never,
      orderId: "ord_1" as never,
      buyerAccountId: "acc_buyer" as never,
      sellerAccountId: "acc_seller" as never,
      shippingOption: "standard",
      lines: [
        {
          lineId: "spl_1" as never,
          orderLineId: "oli_1",
          catalogItemId: "cat_1",
          productId: "cat_1::",
          itemTitle: "Charizard",
          itemSubtitle: null,
          productSummary: null,
          quantity: 1,
        },
      ],
      createdAt: "2026-04-02T00:00:00.000Z",
    }).reduce(evolveFulfillmentShipment, initialFulfillmentShipmentState);

    const packedState = decideFulfillmentShipment(createdState, {
      type: "PrepareShipmentPackage",
      packageCount: 1,
      preparedAt: "2026-04-02T00:05:00.000Z",
    }).reduce(evolveFulfillmentShipment, createdState);

    const labeledState = decideFulfillmentShipment(packedState, {
      type: "AttachShipmentLabel",
      shippingMethod: "priority",
      carrierName: "USPS",
      labelReference: "lbl_123",
      trackingIdentifier: "trk_123",
      attachedAt: "2026-04-02T00:10:00.000Z",
    }).reduce(evolveFulfillmentShipment, packedState);

    const dispatchedState = decideFulfillmentShipment(labeledState, {
      type: "DispatchShipment",
      dispatchedAt: "2026-04-02T00:20:00.000Z",
    }).reduce(evolveFulfillmentShipment, labeledState);

    const deliveredState = decideFulfillmentShipment(dispatchedState, {
      type: "RecordShipmentDelivery",
      deliveredAt: "2026-04-03T12:00:00.000Z",
    }).reduce(evolveFulfillmentShipment, dispatchedState);

    expect(deliveredState.status).toBe("delivered");
    expect(deliveredState.packageStatus).toBe("packed");
    expect(deliveredState.shippingMethod).toBe("priority");
    expect(deliveredState.trackingIdentifier).toBe("trk_123");
    expect(deliveredState.deliveredAt).toBe("2026-04-03T12:00:00.000Z");
  });

  it("rejects attaching a label before the package is prepared", () => {
    const createdState = decideFulfillmentShipment(initialFulfillmentShipmentState, {
      type: "CreateShipment",
      shipmentId: "shp_1" as never,
      orderId: "ord_1" as never,
      buyerAccountId: "acc_buyer" as never,
      sellerAccountId: "acc_seller" as never,
      shippingOption: "standard",
      lines: [
        {
          lineId: "spl_1" as never,
          orderLineId: "oli_1",
          catalogItemId: "cat_1",
          productId: "cat_1::",
          itemTitle: "Charizard",
          itemSubtitle: null,
          productSummary: null,
          quantity: 1,
        },
      ],
      createdAt: "2026-04-02T00:00:00.000Z",
    }).reduce(evolveFulfillmentShipment, initialFulfillmentShipmentState);

    expect(() =>
      decideFulfillmentShipment(createdState, {
        type: "AttachShipmentLabel",
        shippingMethod: "standard",
        carrierName: "USPS",
        labelReference: "lbl_123",
        trackingIdentifier: "trk_123",
        attachedAt: "2026-04-02T00:10:00.000Z",
      }),
    ).toThrow("Shipments must be packed before a label can be attached.");
  });
});
