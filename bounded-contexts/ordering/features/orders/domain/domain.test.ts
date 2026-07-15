import { describe, expect, it } from "vitest";
import type { PackagePlan } from "@chase-sets/product-measures";
import { decideOrderingOrder, evolveOrderingOrder, initialOrderingOrderState } from "./domain";
import type { CreateOrderCommand } from "./domain";

const commercialTermsSnapshot = {
  marketplaceSalesFeeAmount: "1.00",
  sellerNetAmount: "19.00",
  termsScheduleId: "cts_default",
  termsAgreementId: null,
  termsResolvedAt: "2026-03-31T00:00:00.000Z",
} as const;

const orderLineFees = {
  marketplaceSalesFeeUnitAmount: "1.00",
  marketplaceSalesFeeTotalAmount: "1.00",
  sellerNetUnitAmount: "19.00",
  sellerNetTotalAmount: "19.00",
} as const;

const taxSnapshot = {
  taxableAmount: "24.99",
  salesTaxAmount: "0.00",
  jurisdictionCountry: "US",
  jurisdictionState: "IL",
  rateBps: 0,
  providerName: "local-tax-stub",
  providerQuoteReference: null,
  quotedAt: "2026-03-31T00:00:00.000Z",
} as const;

const orderTaxFields = {
  salesTaxAmount: "0.00",
  taxSnapshot,
} as const;

const orderAddressSnapshots = {
  shippingDestinationSnapshot: {
    name: "Jane Smith",
    company: null,
    line1: "100 Market Street",
    line2: null,
    city: "Chicago",
    state: "IL",
    postalCode: "60601",
    country: "US",
    phone: null,
    email: "jane@example.com",
  },
  shippingOriginSnapshot: {
    name: "Seller Shipping",
    company: "Chase Sets",
    line1: "1 Warehouse Way",
    line2: null,
    city: "Austin",
    state: "TX",
    postalCode: "78701",
    country: "US",
    phone: "5125550100",
    email: "shipping@example.com",
  },
} as const;

const shippingPlanSnapshot: PackagePlan = {
  packagePlanVersion: "test-package-plan-v1",
  packageCount: 1,
  packages: [
    {
      packageId: "pkg_1",
      mailpieceClass: "parcel",
      lengthInches: 7,
      widthInches: 5,
      heightInches: 1,
      weightOunces: 4,
      billableWeightOunces: 4,
      serviceLevel: "standard-parcel",
      productMeasureVersions: ["pmv_1"],
    },
  ],
  letterEligibility: {
    eligible: false,
    reasons: ["test-order-uses-parcel"],
  },
  missingProductIds: [],
};

describe("ordering order domain", () => {
  const createOrderCommand = (sourceType: "cart-checkout" | "buy-now" | "offer-acceptance"): CreateOrderCommand => ({
    type: "CreateOrder",
    orderId: `ord_${sourceType}`,
    sourceType,
    sourceReferenceId: null,
    buyerAccountId: "acc_buyer",
    sellerAccountId: "acc_seller",
    shippingOption: "standard",
    itemSubtotalAmount: "20.00",
    shippingBaseAmount: "4.99",
    shippingDiscountAmount: "0.00",
    shippingChargeAmount: "4.99",
    shippingPlanSnapshot,
    ...orderTaxFields,
    totalAmount: "24.99",
    ...orderAddressSnapshots,
    commercialTermsSnapshot,
    lines: [
      {
        lineId: "oli_1",
        listingId: "lst_1",
        inventoryItemId: "inv_1",
        catalogItemId: "cat_1",
        productId: "cat_1::",
        itemTitle: "Charizard",
        itemSubtitle: null,
        selectedOptions: [],
        productSummary: null,
        gradedCard: null,
        unitPriceAmount: "20.00",
        quantity: 1,
        lineTotalAmount: "20.00",
        ...orderLineFees,
      },
    ],
    reservationRequests: [
      {
        reservationRequestId: "rsv_1",
        inventoryItemId: "inv_1",
        sellerAccountId: "acc_seller",
        quantity: 1,
      },
    ],
  });

  it("creates and cancels a pending order", () => {
    const created = decideOrderingOrder(initialOrderingOrderState, createOrderCommand("cart-checkout"));
    const createdState = created.reduce(evolveOrderingOrder, initialOrderingOrderState);
    const cancelled = decideOrderingOrder(createdState, {
      type: "CancelOrder",
      cancelledAt: "2026-03-31T00:00:00.000Z",
      reason: "buyer-cancelled",
    }).reduce(evolveOrderingOrder, createdState);

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelledAt).toBe("2026-03-31T00:00:00.000Z");
    expect(
      decideOrderingOrder(cancelled, {
        type: "MarkReadyForFulfillment",
        readyForFulfillmentAt: "2026-04-01T00:00:00.000Z",
      }),
    ).toEqual([]);
  });

  it("publishes line-item amounts in an additive event without changing order-created", () => {
    const events = decideOrderingOrder(initialOrderingOrderState, createOrderCommand("cart-checkout"));

    expect(events.map((event) => event.type)).toEqual([
      "ordering.order.created",
      "ordering.order.line-item-amounts-published",
    ]);
    expect(events[1]).toMatchObject({
      data: { orderId: "ord_cart-checkout", lineItems: [{ lineId: "oli_1", amount: "20.00" }] },
    });
  });

  it("snapshots one buyer Shipping amount from shipping and protection overflow", () => {
    const command: CreateOrderCommand = {
      ...createOrderCommand("cart-checkout"),
      shippingAllowanceAmount: "0.80",
      shippingOverageAmount: "4.19",
      protectionAmount: "0.20",
      protectionAllowanceAmount: "0.20",
      protectionOverageAmount: "0.00",
      shippingChargeAmount: "4.19",
      totalAmount: "24.19",
      commercialTermsSnapshot: {
        ...commercialTermsSnapshot,
        shippingAllowanceAmount: "0.80",
        sellerShippingPayoutAmount: "4.19",
        protectionAmount: "0.20",
        protectionAllowanceAmount: "0.20",
        protectionOverageAmount: "0.00",
        sellerPayoutAmount: "22.99",
      },
    };

    expect(decideOrderingOrder(initialOrderingOrderState, command)[0]).toMatchObject({
      type: "ordering.order.created",
      data: {
        shippingOverageAmount: "4.19",
        protectionAmount: "0.20",
        protectionAllowanceAmount: "0.20",
        protectionOverageAmount: "0.00",
        shippingChargeAmount: "4.19",
      },
    });
  });

  it("creates an order with no authenticity plan when the buyer did not opt in", () => {
    const createdState = decideOrderingOrder(initialOrderingOrderState, createOrderCommand("cart-checkout")).reduce(
      evolveOrderingOrder,
      initialOrderingOrderState,
    );

    expect(createdState.authenticityPlanSnapshot).toBeNull();
  });

  it("freezes the authenticity plan onto the order when the buyer opted in at checkout", () => {
    const command: CreateOrderCommand = {
      ...createOrderCommand("cart-checkout"),
      totalAmount: "34.99",
      authenticityPlanSnapshot: {
        feeAmount: "10.00",
        payer: "buyer",
        policyVersion: "authenticity-check-fee-v1",
        category: "any",
        thresholdAmount: "100.00",
        orderValueAmount: "150.00",
        quotedAt: "2026-03-31T00:00:00.000Z",
      },
    };
    const createdState = decideOrderingOrder(initialOrderingOrderState, command).reduce(
      evolveOrderingOrder,
      initialOrderingOrderState,
    );

    expect(createdState.authenticityPlanSnapshot).toEqual({
      feeAmount: "10.00",
      payer: "buyer",
      policyVersion: "authenticity-check-fee-v1",
      category: "any",
      thresholdAmount: "100.00",
      orderValueAmount: "150.00",
      quotedAt: "2026-03-31T00:00:00.000Z",
    });
  });

  it("rejects a line total that does not equal unit price times quantity", () => {
    const command = createOrderCommand("cart-checkout");

    expect(() =>
      decideOrderingOrder(initialOrderingOrderState, {
        ...command,
        itemSubtotalAmount: "39.99",
        totalAmount: "44.98",
        lines: [{ ...command.lines[0]!, quantity: 2, lineTotalAmount: "39.99" }],
      }),
    ).toThrow("Order line total must equal unit price times quantity.");
  });

  it("rejects an item subtotal that does not equal the sum of line totals", () => {
    expect(() =>
      decideOrderingOrder(initialOrderingOrderState, {
        ...createOrderCommand("cart-checkout"),
        itemSubtotalAmount: "19.99",
        totalAmount: "24.98",
      }),
    ).toThrow("Order item subtotal must equal the sum of line totals.");
  });

  it("rejects an order total that does not equal every buyer charge component", () => {
    expect(() =>
      decideOrderingOrder(initialOrderingOrderState, {
        ...createOrderCommand("cart-checkout"),
        totalAmount: "25.00",
      }),
    ).toThrow("Order total must equal item subtotal, Shipping, sales tax, and authenticity check fee.");
  });

  it("rejects a line whose marketplace fee and seller net do not equal its line total", () => {
    const command = createOrderCommand("cart-checkout");

    expect(() =>
      decideOrderingOrder(initialOrderingOrderState, {
        ...command,
        commercialTermsSnapshot: {
          ...command.commercialTermsSnapshot,
          marketplaceSalesFeeAmount: "1.01",
          sellerNetAmount: "19.00",
        },
        lines: [
          {
            ...command.lines[0]!,
            marketplaceSalesFeeUnitAmount: "1.01",
            marketplaceSalesFeeTotalAmount: "1.01",
            sellerNetUnitAmount: "19.00",
            sellerNetTotalAmount: "19.00",
          },
        ],
      }),
    ).toThrow("Order line marketplace fee plus seller net must equal the line total.");
  });

  it("marks a pending order ready for fulfillment after payment capture", () => {
    const createdState = decideOrderingOrder(initialOrderingOrderState, createOrderCommand("cart-checkout")).reduce(
      evolveOrderingOrder,
      initialOrderingOrderState,
    );

    const pendingPaymentState = decideOrderingOrder(createdState, {
      type: "RecordReservationConfirmed",
      reservationRequestId: "rsv_1",
      holdId: "hld_1",
      confirmedAt: "2026-03-31T00:00:00.000Z",
    }).reduce(evolveOrderingOrder, createdState);

    const ready = decideOrderingOrder(pendingPaymentState, {
      type: "MarkReadyForFulfillment",
      readyForFulfillmentAt: "2026-04-01T00:00:00.000Z",
    }).reduce(evolveOrderingOrder, pendingPaymentState);

    expect(ready.status).toBe("ready-for-fulfillment");
    expect(ready.readyForFulfillmentAt).toBe("2026-04-01T00:00:00.000Z");
  });

  it("stamps a policy-tokenized payment deadline when reservations are confirmed", () => {
    const createdState = decideOrderingOrder(initialOrderingOrderState, createOrderCommand("cart-checkout")).reduce(
      evolveOrderingOrder,
      initialOrderingOrderState,
    );

    const events = decideOrderingOrder(createdState, {
      type: "RecordReservationConfirmed",
      reservationRequestId: "rsv_1",
      holdId: "hld_1",
      confirmedAt: "2026-03-31T00:00:00.000Z",
    });

    expect(events).toContainEqual({
      type: "ordering.order.pending-payment-recorded",
      data: {
        orderId: "ord_cart-checkout",
        pendingPaymentAt: "2026-03-31T00:00:00.000Z",
        paymentDeadlineAt: "2026-03-31T01:00:00.000Z",
        paymentDeadlinePolicy: "ordering-payment-deadline-card-v1",
      },
    });
  });

  it("rejects a reservation confirmation for an unknown request", () => {
    const createdState = decideOrderingOrder(initialOrderingOrderState, createOrderCommand("cart-checkout")).reduce(
      evolveOrderingOrder,
      initialOrderingOrderState,
    );

    expect(() =>
      decideOrderingOrder(createdState, {
        type: "RecordReservationConfirmed",
        reservationRequestId: "rsv_missing",
        holdId: "hld_1",
        confirmedAt: "2026-03-31T00:00:00.000Z",
      }),
    ).toThrow("Reservation confirmation must reference an existing reservation request.");
  });

  it("rejects payment-deadline cancellation after payment capture wins the race", () => {
    const createdState = decideOrderingOrder(initialOrderingOrderState, createOrderCommand("cart-checkout")).reduce(
      evolveOrderingOrder,
      initialOrderingOrderState,
    );
    const pendingPaymentState = decideOrderingOrder(createdState, {
      type: "RecordReservationConfirmed",
      reservationRequestId: "rsv_1",
      holdId: "hld_1",
      confirmedAt: "2026-03-31T00:00:00.000Z",
    }).reduce(evolveOrderingOrder, createdState);
    const readyState = decideOrderingOrder(pendingPaymentState, {
      type: "MarkReadyForFulfillment",
      readyForFulfillmentAt: "2026-03-31T00:59:59.000Z",
    }).reduce(evolveOrderingOrder, pendingPaymentState);

    expect(() =>
      decideOrderingOrder(readyState, {
        type: "CancelOrder",
        cancelledAt: "2026-03-31T01:00:00.000Z",
        reason: "payment-deadline",
      }),
    ).toThrow("Payment-deadline cancellation requires a pending-payment order.");
  });

  it("rejects invalid order creation", () => {
    expect(() =>
      decideOrderingOrder(initialOrderingOrderState, {
        type: "CreateOrder",
        orderId: "ord_1",
        sourceType: "cart-checkout",
        sourceReferenceId: null,
        buyerAccountId: "acc_buyer",
        sellerAccountId: "acc_seller",
        shippingOption: "standard",
        itemSubtotalAmount: "0.00",
        shippingBaseAmount: "4.99",
        shippingDiscountAmount: "0.00",
        shippingChargeAmount: "4.99",
        shippingPlanSnapshot,
        ...orderTaxFields,
        totalAmount: "4.99",
        ...orderAddressSnapshots,
        commercialTermsSnapshot,
        lines: [],
        reservationRequests: [],
      }),
    ).toThrow("Orders must include at least one line.");
  });

  it.each(["cart-checkout", "buy-now", "offer-acceptance"] as const)(
    "rejects same-account self-dealing order creation from %s",
    (sourceType) => {
      expect(() =>
        decideOrderingOrder(initialOrderingOrderState, {
          ...createOrderCommand(sourceType),
          buyerAccountId: "acc_same",
          sellerAccountId: "acc_same",
          reservationRequests: [
            {
              reservationRequestId: "rsv_1",
              inventoryItemId: "inv_1",
              sellerAccountId: "acc_same",
              quantity: 1,
            },
          ],
        }),
      ).toThrow("Buyer and seller accounts must be different for an order.");
    },
  );
});
