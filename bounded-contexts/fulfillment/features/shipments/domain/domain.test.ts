import { describe, expect, it } from "vitest";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import {
  decideFulfillmentShipment,
  evolveFulfillmentShipment,
  initialFulfillmentShipmentState,
  type FulfillmentShipmentEvent,
} from "./domain";

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

function createPackedShipmentState() {
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
  const confirmedState = decideFulfillmentShipment(packingState, {
    type: "ConfirmShipmentPackingLine",
    lineId: "spl_1" as never,
    confirmedAt: "2026-04-02T00:04:00.000Z",
  }).reduce(evolveFulfillmentShipment, packingState);
  return decideFulfillmentShipment(confirmedState, {
    type: "PrepareShipmentPackage",
    packageCount: 1,
    preparedAt: "2026-04-02T00:05:00.000Z",
  }).reduce(evolveFulfillmentShipment, confirmedState);
}

function attachPurchasedLabel(state: ReturnType<typeof createPackedShipmentState>) {
  return decideFulfillmentShipment(state, {
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
  }).reduce(evolveFulfillmentShipment, state);
}

describe("fulfillment shipment domain", () => {
  it("publishes the privacy-minimal shipment routing facts from aggregate state at dispatch", () => {
    const labeledState = attachPurchasedLabel(createPackedShipmentState());

    const [event] = decideFulfillmentShipment(labeledState, {
      type: "DispatchShipment",
      dispatchedAt: "2026-04-02T00:20:00.000Z",
    });

    expect(event).toEqual({
      type: "fulfillment.shipment.dispatched",
      data: {
        shipmentId: "shp_1",
        orderId: "ord_1",
        buyerAccountId: "acc_buyer",
        sellerAccountId: "acc_seller",
        trackingIdentifier: "trk_123",
        dispatchedAt: "2026-04-02T00:20:00.000Z",
      },
    });
    expect(Object.keys(event.data).sort()).toEqual([
      "buyerAccountId",
      "dispatchedAt",
      "orderId",
      "sellerAccountId",
      "shipmentId",
      "trackingIdentifier",
    ]);
  });

  it("refuses to dispatch a shipment that has not been created", () => {
    expect(() =>
      decideFulfillmentShipment(initialFulfillmentShipmentState, {
        type: "DispatchShipment",
        dispatchedAt: "2026-04-02T00:20:00.000Z",
      }),
    ).toThrow("Shipment must be created first.");
  });

  it("refuses to dispatch a labeled shipment whose authoritative order routing fact is absent", () => {
    const labeledState = attachPurchasedLabel(createPackedShipmentState());

    expect(() =>
      decideFulfillmentShipment(
        { ...labeledState, orderId: null },
        { type: "DispatchShipment", dispatchedAt: "2026-04-02T00:20:00.000Z" },
      ),
    ).toThrow("Shipment must reference an order before dispatch.");
  });

  it("keeps redispatch idempotent after folding the enriched event", () => {
    const labeledState = attachPurchasedLabel(createPackedShipmentState());
    const [dispatchedEvent] = decideFulfillmentShipment(labeledState, {
      type: "DispatchShipment",
      dispatchedAt: "2026-04-02T00:20:00.000Z",
    });
    const dispatchedState = evolveFulfillmentShipment(labeledState, dispatchedEvent);

    expect(
      decideFulfillmentShipment(dispatchedState, {
        type: "DispatchShipment",
        dispatchedAt: "2026-04-02T00:21:00.000Z",
      }),
    ).toEqual([]);
  });

  it("replays historical thin and enriched dispatched events without rewriting either payload", () => {
    const codec = createPassthroughDomainEventCodec<FulfillmentShipmentEvent>();
    const [historicalEvent, enrichedEvent] = [
      {
        eventType: "fulfillment.shipment.dispatched",
        payload: { shipmentId: "shp_historical", dispatchedAt: "2026-04-01T00:00:00.000Z" },
      },
      {
        eventType: "fulfillment.shipment.dispatched",
        payload: {
          shipmentId: "shp_enriched",
          orderId: "ord_1",
          buyerAccountId: "acc_buyer",
          sellerAccountId: "acc_seller",
          trackingIdentifier: "trk_123",
          dispatchedAt: "2026-04-02T00:20:00.000Z",
        },
      },
    ].map((storedEvent) => codec.decode(storedEvent));

    const historicalState = evolveFulfillmentShipment(initialFulfillmentShipmentState, historicalEvent);
    const enrichedState = evolveFulfillmentShipment(historicalState, enrichedEvent);

    expect(historicalState.status).toBe("dispatched");
    expect(enrichedState.status).toBe("dispatched");
    expect("orderId" in historicalEvent.data).toBe(false);
    expect(enrichedEvent.data).toEqual({
      shipmentId: "shp_enriched",
      orderId: "ord_1",
      buyerAccountId: "acc_buyer",
      sellerAccountId: "acc_seller",
      trackingIdentifier: "trk_123",
      dispatchedAt: "2026-04-02T00:20:00.000Z",
    });
  });

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

    const confirmedState = decideFulfillmentShipment(packingState, {
      type: "ConfirmShipmentPackingLine",
      lineId: "spl_1" as never,
      confirmedAt: "2026-04-02T00:04:00.000Z",
    }).reduce(evolveFulfillmentShipment, packingState);

    expect(confirmedState.lines[0]?.packingConfirmedAt).toBe("2026-04-02T00:04:00.000Z");
    expect(confirmedState.lines[0]?.packingConfirmedQuantity).toBe(1);

    const packedState = decideFulfillmentShipment(confirmedState, {
      type: "PrepareShipmentPackage",
      packageCount: 1,
      preparedAt: "2026-04-02T00:05:00.000Z",
    }).reduce(evolveFulfillmentShipment, confirmedState);

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

  it("emits delivery proof fields used for payment dispute evidence", () => {
    const labeledState = attachPurchasedLabel(createPackedShipmentState());
    const dispatchedState = decideFulfillmentShipment(labeledState, {
      type: "DispatchShipment",
      dispatchedAt: "2026-04-02T00:20:00.000Z",
    }).reduce(evolveFulfillmentShipment, labeledState);

    const [event] = decideFulfillmentShipment(dispatchedState, {
      type: "RecordShipmentDelivery",
      deliveredAt: "2026-04-03T12:00:00.000Z",
    });

    expect(event).toMatchObject({
      type: "fulfillment.shipment.delivered",
      data: {
        shipmentId: "shp_1",
        orderId: "ord_1",
        buyerAccountId: "acc_buyer",
        trackingIdentifier: "trk_123",
        deliveredAt: "2026-04-03T12:00:00.000Z",
        shippingDestinationSnapshot: shipmentAddressSnapshots.shippingDestinationSnapshot,
      },
    });
  });

  it("requires every unit of multi-quantity lines before package preparation", () => {
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
          quantity: 2,
        },
      ],
      createdAt: "2026-04-02T00:00:00.000Z",
    }).reduce(evolveFulfillmentShipment, initialFulfillmentShipmentState);
    const packingState = decideFulfillmentShipment(createdState, {
      type: "StartShipmentPacking",
      startedAt: "2026-04-02T00:03:00.000Z",
    }).reduce(evolveFulfillmentShipment, createdState);

    const partialState = decideFulfillmentShipment(packingState, {
      type: "SetShipmentPackingLineQuantity",
      lineId: "spl_1" as never,
      confirmedQuantity: 1,
      setAt: "2026-04-02T00:04:00.000Z",
    }).reduce(evolveFulfillmentShipment, packingState);

    expect(partialState.lines[0]?.packingConfirmedQuantity).toBe(1);
    expect(partialState.lines[0]?.packingConfirmedAt).toBeNull();
    expect(() =>
      decideFulfillmentShipment(partialState, {
        type: "PrepareShipmentPackage",
        packageCount: 1,
        preparedAt: "2026-04-02T00:05:00.000Z",
      }),
    ).toThrow("Every shipment line must be confirmed before the package can be packed.");

    const fullState = decideFulfillmentShipment(partialState, {
      type: "SetShipmentPackingLineQuantity",
      lineId: "spl_1" as never,
      confirmedQuantity: 2,
      setAt: "2026-04-02T00:06:00.000Z",
    }).reduce(evolveFulfillmentShipment, partialState);

    expect(fullState.lines[0]?.packingConfirmedQuantity).toBe(2);
    expect(fullState.lines[0]?.packingConfirmedAt).toBe("2026-04-02T00:06:00.000Z");
    expect(() =>
      decideFulfillmentShipment(fullState, {
        type: "PrepareShipmentPackage",
        packageCount: 1,
        preparedAt: "2026-04-02T00:07:00.000Z",
      }),
    ).not.toThrow();
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
    const packingState = decideFulfillmentShipment(createdState, {
      type: "StartShipmentPacking",
      startedAt: "2026-04-02T00:03:00.000Z",
    }).reduce(evolveFulfillmentShipment, createdState);
    const confirmedState = decideFulfillmentShipment(packingState, {
      type: "ConfirmShipmentPackingLine",
      lineId: "spl_1" as never,
      confirmedAt: "2026-04-02T00:04:00.000Z",
    }).reduce(evolveFulfillmentShipment, packingState);
    const packedState = decideFulfillmentShipment(confirmedState, {
      type: "PrepareShipmentPackage",
      packageCount: 1,
      preparedAt: "2026-04-02T00:05:00.000Z",
    }).reduce(evolveFulfillmentShipment, confirmedState);

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

  it("rejects purchased postage labels without a known cost", () => {
    const packedState = createPackedShipmentState();

    expect(() =>
      decideFulfillmentShipment(packedState, {
        type: "AttachShipmentLabel",
        shippingMethod: "priority",
        carrierName: "USPS",
        labelReference: "lbl_123",
        trackingIdentifier: "trk_123",
        postageAmountCents: null,
        postageCurrency: "USD",
        attachedAt: "2026-04-02T00:10:00.000Z",
      }),
    ).toThrow("Postage amount must be known before a label can be attached.");
  });

  it("records terminal refund statuses for requested label voids without resurrecting terminal states", () => {
    const labeledState = attachPurchasedLabel(createPackedShipmentState());
    const voidRequestedState = decideFulfillmentShipment(labeledState, {
      type: "VoidShipmentLabel",
      refundStatus: "submitted",
      refundReference: "rfnd_1",
      voidedAt: "2026-04-02T00:15:00.000Z",
    }).reduce(evolveFulfillmentShipment, labeledState);

    expect(voidRequestedState.status).toBe("awaiting-label");
    expect(voidRequestedState.labelStatus).toBe("void-requested");

    const voidedState = decideFulfillmentShipment(voidRequestedState, {
      type: "RecordShipmentLabelRefundStatus",
      refundStatus: "refunded",
      refundReference: "rfnd_1",
      resolvedAt: "2026-04-02T00:20:00.000Z",
    }).reduce(evolveFulfillmentShipment, voidRequestedState);

    expect(voidedState.status).toBe("awaiting-label");
    expect(voidedState.labelStatus).toBe("voided");
    expect(
      decideFulfillmentShipment(voidedState, {
        type: "RecordShipmentLabelRefundStatus",
        refundStatus: "rejected",
        refundReference: "rfnd_1",
        resolvedAt: "2026-04-02T00:21:00.000Z",
      }),
    ).toEqual([]);
  });

  it("marks rejected label refund requests without opening a replacement-label path", () => {
    const labeledState = attachPurchasedLabel(createPackedShipmentState());
    const voidRequestedState = decideFulfillmentShipment(labeledState, {
      type: "VoidShipmentLabel",
      refundStatus: "submitted",
      refundReference: "rfnd_1",
      voidedAt: "2026-04-02T00:15:00.000Z",
    }).reduce(evolveFulfillmentShipment, labeledState);

    const rejectedState = decideFulfillmentShipment(voidRequestedState, {
      type: "RecordShipmentLabelRefundStatus",
      refundStatus: "rejected",
      refundReference: "rfnd_1",
      resolvedAt: "2026-04-02T00:20:00.000Z",
    }).reduce(evolveFulfillmentShipment, voidRequestedState);

    expect(rejectedState.status).toBe("label-attached");
    expect(rejectedState.labelStatus).toBe("void-rejected");
  });

  it("supersedes the voided provider label id when a shipment is reissued a new label", () => {
    const labeledState = attachPurchasedLabel(createPackedShipmentState());
    expect(labeledState.postageProviderLabelId).toBe("plbl_123");

    const voidRequestedState = decideFulfillmentShipment(labeledState, {
      type: "VoidShipmentLabel",
      refundStatus: "submitted",
      refundReference: "rfnd_1",
      voidedAt: "2026-04-02T00:15:00.000Z",
    }).reduce(evolveFulfillmentShipment, labeledState);
    const voidedState = decideFulfillmentShipment(voidRequestedState, {
      type: "RecordShipmentLabelRefundStatus",
      refundStatus: "refunded",
      refundReference: "rfnd_1",
      resolvedAt: "2026-04-02T00:20:00.000Z",
    }).reduce(evolveFulfillmentShipment, voidRequestedState);

    // The voided label id is still visible on the read model until a new label
    // is attached: the constraint that protects against cross-shipment
    // collisions only ever sees the shipment's *current* label id, so a
    // reissue for the same shipment cannot self-collide with its own void.
    expect(voidedState.postageProviderLabelId).toBe("plbl_123");
    expect(voidedState.status).toBe("awaiting-label");
    expect(voidedState.labelStatus).toBe("voided");

    const reissuedState = decideFulfillmentShipment(voidedState, {
      type: "AttachShipmentLabel",
      shippingMethod: "priority",
      carrierName: "USPS",
      labelReference: "lbl_456",
      labelDocumentUrl: "https://labels.test/lbl_456.pdf",
      trackingIdentifier: "trk_456",
      postageProviderName: "sandbox-usps",
      postageProviderMode: "test",
      postageProviderShipmentId: "pshp_456",
      postageProviderLabelId: "plbl_456",
      postageRateId: "rate_456",
      postageServiceLevel: "USPS_GROUND_ADVANTAGE",
      postageAmountCents: 599,
      postageCurrency: "USD",
      attachedAt: "2026-04-02T00:25:00.000Z",
    }).reduce(evolveFulfillmentShipment, voidedState);

    // The reissued label id fully replaces the voided one on this shipment's
    // row, so the provider-scoped uniqueness index never sees both ids
    // persisted for the same shipment at once.
    expect(reissuedState.postageProviderLabelId).toBe("plbl_456");
    expect(reissuedState.status).toBe("label-attached");
    expect(reissuedState.labelStatus).toBe("purchased");
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
