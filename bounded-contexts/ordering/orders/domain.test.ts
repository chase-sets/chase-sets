import { describe, expect, it } from "vitest";
import {
  decideOrderingOrder,
  evolveOrderingOrder,
  initialOrderingOrderState,
} from "./domain";

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
      lines: [
        {
          lineId: "oli_1" as never,
          listingId: "lst_1",
          inventoryRecordId: "inv_1",
          catalogItemId: "cat_1",
          itemTitle: "Charizard",
          itemSubtitle: null,
          versionSelection: [],
          versionSummary: null,
          condition: "NM",
          unitPriceAmount: "20.00",
          quantity: 1,
          lineTotalAmount: "20.00",
        },
      ],
      inventoryReservations: [
        {
          holdId: "hld_1",
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
    }).reduce(evolveOrderingOrder, createdState);

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelledAt).toBe("2026-03-31T00:00:00.000Z");
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
        lines: [],
        inventoryReservations: [],
      }),
    ).toThrow("Orders must include at least one line.");
  });
});
