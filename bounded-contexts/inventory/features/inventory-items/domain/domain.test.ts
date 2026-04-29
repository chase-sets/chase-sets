import { describe, expect, it } from "vitest";
import {
  decideInventoryItem,
  evolveInventoryItem,
  initialInventoryItemState,
} from "./domain";

describe("inventory item domain", () => {
  it("creates and adjusts an inventory item", async () => {
    const created = await decideInventoryItem(initialInventoryItemState, {
      type: "CreateInventoryItem",
      itemId: "inv_1" as never,
      accountId: "acc_1" as never,
      catalogItemId: "cat_1",
      productId: "cat_1::" as never,
      selectedOptions: [],
      storageLocationId: "loc_1",
      totalQuantity: 12,
      acquisitionCostAmount: "4.25",
    });
    const createdState = created.reduce(evolveInventoryItem, initialInventoryItemState);
    const adjusted = await decideInventoryItem(createdState, {
      type: "AdjustInventoryItemQuantity",
      quantityDelta: -4,
      reason: "Cycle count",
    });
    const adjustedState = adjusted.reduce(evolveInventoryItem, createdState);

    expect(createdState.totalQuantity).toBe(12);
    expect(adjustedState.totalQuantity).toBe(8);
  });
});
