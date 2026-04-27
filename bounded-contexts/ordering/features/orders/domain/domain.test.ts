import { describe, expect, it } from "vitest";
import {
  decideOrderingOrder,
  evolveOrderingOrder,
  initialOrderingOrderState,
} from "./domain";

const commercialTermsSnapshot = {
  marketplaceFeeAmount: "1.00",
  paymentFeeAmount: "0.50",
  sellerNetAmount: "18.50",
  termsScheduleId: "cts_default",
  termsAgreementId: null,
  termsResolvedAt: "2026-03-31T00:00:00.000Z",
} as const;

describe("ordering order domain", () => {
  it("creates and cancels a pending order", () => {
    const created = decideOrderingOrder(initialOrderingOrderState, {
      type: "CreateOrder",
      orderId: "ord_1" as never,
      sourceType: "cart-checkout",
      sourceReferenceId: null,
      buyerAccountId: "acc_buyer" as never,
      sellerAccountId: "acc_seller" as never,
      shippingOption: "standard",
      itemSubtotalAmount: "20.00",
      shippingBaseAmount: "4.99",
      shippingDiscountAmount: "0.00",
      shippingChargeAmount: "4.99",
      totalAmount: "24.99",
      commercialTermsSnapshot,
      lines: [
        {
          lineId: "oli_1" as never,
          listingId: "lst_1",
          inventoryRecordId: "inv_1",
          catalogItemId: "cat_1",
          productId: "cat_1::" as never,
          itemTitle: "Charizard",
          itemSubtitle: null,
          selectedOptions: [],
          productSummary: null,
          unitPriceAmount: "20.00",
          quantity: 1,
          lineTotalAmount: "20.00",
        },
      ],
      reservationRequests: [
        {
          reservationRequestId: "rsv_1",
          inventoryRecordId: "inv_1",
          sellerAccountId: "acc_seller",
          quantity: 1,
        },
      ],
    });
    const createdState = created.reduce(evolveOrderingOrder, initialOrderingOrderState);
    const cancelled = decideOrderingOrder(createdState, {
      type: "CancelOrder",
      cancelledAt: "2026-03-31T00:00:00.000Z",
      reason: "buyer-cancelled",
    }).reduce(evolveOrderingOrder, createdState);

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelledAt).toBe("2026-03-31T00:00:00.000Z");
  });

  it("marks a pending order ready for fulfillment after payment capture", () => {
    const createdState = decideOrderingOrder(initialOrderingOrderState, {
      type: "CreateOrder",
      orderId: "ord_1" as never,
      sourceType: "cart-checkout",
      sourceReferenceId: null,
      buyerAccountId: "acc_buyer" as never,
      sellerAccountId: "acc_seller" as never,
      shippingOption: "standard",
      itemSubtotalAmount: "20.00",
      shippingBaseAmount: "4.99",
      shippingDiscountAmount: "0.00",
      shippingChargeAmount: "4.99",
      totalAmount: "24.99",
      commercialTermsSnapshot,
      lines: [
        {
          lineId: "oli_1" as never,
          listingId: "lst_1",
          inventoryRecordId: "inv_1",
          catalogItemId: "cat_1",
          productId: "cat_1::" as never,
          itemTitle: "Charizard",
          itemSubtitle: null,
          selectedOptions: [],
          productSummary: null,
          unitPriceAmount: "20.00",
          quantity: 1,
          lineTotalAmount: "20.00",
        },
      ],
      reservationRequests: [
        {
          reservationRequestId: "rsv_1",
          inventoryRecordId: "inv_1",
          sellerAccountId: "acc_seller",
          quantity: 1,
        },
      ],
    }).reduce(evolveOrderingOrder, initialOrderingOrderState);

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

  it("rejects invalid order creation", () => {
    expect(() =>
      decideOrderingOrder(initialOrderingOrderState, {
        type: "CreateOrder",
        orderId: "ord_1" as never,
        sourceType: "cart-checkout",
        sourceReferenceId: null,
        buyerAccountId: "acc_buyer" as never,
        sellerAccountId: "acc_seller" as never,
        shippingOption: "standard",
        itemSubtotalAmount: "0.00",
        shippingBaseAmount: "4.99",
        shippingDiscountAmount: "0.00",
        shippingChargeAmount: "4.99",
        totalAmount: "4.99",
        commercialTermsSnapshot,
        lines: [],
        reservationRequests: [],
      }),
    ).toThrow("Orders must include at least one line.");
  });
});
