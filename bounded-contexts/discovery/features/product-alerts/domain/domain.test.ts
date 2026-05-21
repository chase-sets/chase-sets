import { describe, expect, it } from "vitest";
import { decideProductAlert, evolveProductAlert, initialProductAlertState } from "./domain";

describe("Product Alert domain", () => {
  it("creates a normalized exact-product alert with an optional threshold", () => {
    const events = decideProductAlert(initialProductAlertState, {
      type: "CreateProductAlert",
      alertId: "pal_1",
      accountId: "acc_1",
      marketSide: "listing",
      catalogItemId: "cat_1",
      productId: "cat_1::condition:nm",
      selectedOptions: [{ dimensionId: " condition ", optionId: " nm " }],
      productSummary: "Near Mint",
      thresholdAmount: "12",
    });

    expect(events).toEqual([
      {
        type: "discovery.product-alert.created",
        data: expect.objectContaining({
          alertId: "pal_1",
          marketSide: "listing",
          selectedOptions: [{ dimensionId: "condition", optionId: "nm" }],
          thresholdAmount: "12.00",
        }),
      },
    ]);

    expect(evolveProductAlert(initialProductAlertState, events[0])).toMatchObject({
      status: "active",
      productId: "cat_1::condition:nm",
    });
  });

  it("keeps deleted alerts closed to pause and resume commands", () => {
    const created = evolveProductAlert(initialProductAlertState, {
      type: "discovery.product-alert.created",
      data: {
        alertId: "pal_1",
        accountId: "acc_1",
        marketSide: "offer",
        catalogItemId: "cat_1",
        productId: "cat_1::",
        selectedOptions: [],
        productSummary: null,
        thresholdAmount: null,
      },
    });
    const deleted = evolveProductAlert(created, {
      type: "discovery.product-alert.deleted",
      data: {},
    });

    expect(() => decideProductAlert(deleted, { type: "PauseProductAlert" })).toThrow(
      "Deleted Product Alerts cannot be changed.",
    );
  });
});
