import { describe, expect, it } from "vitest";
import {
  decideInventoryRecord,
  evolveInventoryRecord,
  initialInventoryRecordState,
} from "./domain";

describe("inventory record domain", () => {
  it("creates and adjusts an inventory record", async () => {
    const created = await decideInventoryRecord(initialInventoryRecordState, {
      type: "CreateInventoryRecord",
      recordId: "inv_1" as never,
      accountId: "acc_1" as never,
      catalogItemId: "cat_1",
      condition: "NM",
      storageLocationId: "loc_1",
      totalQuantity: 12,
      acquisitionCostAmount: "4.25",
    });
    const createdState = created.reduce(evolveInventoryRecord, initialInventoryRecordState);
    const adjusted = await decideInventoryRecord(createdState, {
      type: "AdjustInventoryRecordQuantity",
      quantityDelta: -4,
      reason: "Cycle count",
    });
    const adjustedState = adjusted.reduce(evolveInventoryRecord, createdState);

    expect(createdState.totalQuantity).toBe(12);
    expect(adjustedState.totalQuantity).toBe(8);
  });
});
