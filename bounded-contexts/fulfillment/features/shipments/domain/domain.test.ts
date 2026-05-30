import { describe, expect, it } from "vitest";
import { decideFulfillmentShipment, evolveFulfillmentShipment, initialFulfillmentShipmentState } from "./domain";

const shipmentAddressSnapshots = {
  shippingDestinationSnapshot: {
    name: "Buyer",
    company: null,
    line1: "2 Market St",
    line2: null,
    city: "Chicago",
    state: "IL",
    postalCode: "60601",
    country: "US",
    phone: null,
    email: null,
  },
  shippingOriginSnapshot: {
    name: "Seller",
    company: null,
    line1: "1 Main St",
    line2: null,
    city: "Austin",
    state: "TX",
    postalCode: "78701",
    country: "US",
    phone: null,
    email: null,
  },
} as const;

describe("fulfillment shipment domain", () => {
  it("moves a shipment through packing, labeling, dispatch, and delivery", () => {
    const createdState = decideFulfillmentShipment(initialFulfillmentShipmentState, {
      type: "CreateShipment",
      shipmentId: "shp_1" as never,
      orderId: "ord_1" as never,
      buyerAccountId: "acc_buyer" as never,
      sellerAccountId: "acc_seller" as never,
      shippingOption: "standard",
      ...shipmentAddressSnapshots,
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

    const packingState = decideFulfillmentShipment(createdState, {
      type: "StartShipmentPacking",
      startedAt: "2026-04-02T00:03:00.000Z",
    }).reduce(evolveFulfillmentShipment, createdState);

    expect(packingState.status).toBe("packing");
    expect(packingState.packageStatus).toBe("packing");
    expect(packingState.packingStartedAt).toBe("2026-04-02T00:03:00.000Z");

    const packedState = decideFulfillmentShipment(packingState, {
      type: "PrepareShipmentPackage",
      packageCount: 1,
      preparedAt: "2026-04-02T00:05:00.000Z",
    }).reduce(evolveFulfillmentShipment, packingState);

    const labeledState = decideFulfillmentShipment(packedState, {
      type: "AttachShipmentLabel",
      shippingMethod: "priority",
      carrierName: "USPS",
      labelReference: "lbl_123",
      labelDocumentUrl: "https://labels.test/lbl_123.pdf",
      trackingIdentifier: "trk_123",
      postageProviderName: "sandbox-usps",
      postageProviderMode: "test",
      postageProviderShipmentId: "pshp_123",
      postageProviderLabelId: "plbl_123",
      postageRateId: "rate_123",
      postageServiceLevel: "USPS_GROUND_ADVANTAGE",
      postageAmountCents: 499,
      postageCurrency: "USD",
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
    expect(deliveredState.labelDocumentUrl).toBe("https://labels.test/lbl_123.pdf");
    expect(deliveredState.labelStatus).toBe("purchased");
    expect(deliveredState.deliveredAt).toBe("2026-04-03T12:00:00.000Z");
  });

  it("records label purchase failures without leaving the awaiting-label workflow", () => {
    const createdState = decideFulfillmentShipment(initialFulfillmentShipmentState, {
      type: "CreateShipment",
      shipmentId: "shp_1" as never,
      orderId: "ord_1" as never,
      buyerAccountId: "acc_buyer" as never,
      sellerAccountId: "acc_seller" as never,
      shippingOption: "standard",
      ...shipmentAddressSnapshots,
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

    const failedState = decideFulfillmentShipment(packedState, {
      type: "RecordShipmentLabelPurchaseFailed",
      postageProviderName: "sandbox-usps",
      postageProviderMode: "test",
      errorCode: "rate_unavailable",
      errorMessage: "No USPS rates were returned for this shipment.",
      failedAt: "2026-04-02T00:06:00.000Z",
    }).reduce(evolveFulfillmentShipment, packedState);

    expect(failedState.status).toBe("awaiting-label");
    expect(failedState.labelStatus).toBe("purchase-error");
    expect(failedState.labelErrorMessage).toBe("No USPS rates were returned for this shipment.");
  });

  it("rejects attaching a label before the package is prepared", () => {
    const createdState = decideFulfillmentShipment(initialFulfillmentShipmentState, {
      type: "CreateShipment",
      shipmentId: "shp_1" as never,
      orderId: "ord_1" as never,
      buyerAccountId: "acc_buyer" as never,
      sellerAccountId: "acc_seller" as never,
      shippingOption: "standard",
      ...shipmentAddressSnapshots,
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

  it("cancels a shipment before package preparation starts", () => {
    const createdState = decideFulfillmentShipment(initialFulfillmentShipmentState, {
      type: "CreateShipment",
      shipmentId: "shp_1" as never,
      orderId: "ord_1" as never,
      buyerAccountId: "acc_buyer" as never,
      sellerAccountId: "acc_seller" as never,
      shippingOption: "standard",
      ...shipmentAddressSnapshots,
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

    const cancelledState = decideFulfillmentShipment(createdState, {
      type: "CancelShipment",
      cancelledAt: "2026-04-02T00:03:00.000Z",
    }).reduce(evolveFulfillmentShipment, createdState);

    expect(cancelledState.status).toBe("cancelled");
    expect(cancelledState.cancelledAt).toBe("2026-04-02T00:03:00.000Z");
  });

  it("rejects cancellation after packing starts", () => {
    const createdState = decideFulfillmentShipment(initialFulfillmentShipmentState, {
      type: "CreateShipment",
      shipmentId: "shp_1" as never,
      orderId: "ord_1" as never,
      buyerAccountId: "acc_buyer" as never,
      sellerAccountId: "acc_seller" as never,
      shippingOption: "standard",
      ...shipmentAddressSnapshots,
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
    const packingState = decideFulfillmentShipment(createdState, {
      type: "StartShipmentPacking",
      startedAt: "2026-04-02T00:05:00.000Z",
    }).reduce(evolveFulfillmentShipment, createdState);

    expect(() =>
      decideFulfillmentShipment(packingState, {
        type: "CancelShipment",
        cancelledAt: "2026-04-02T00:06:00.000Z",
      }),
    ).toThrow("Only shipments awaiting package preparation can be cancelled.");
  });
});
