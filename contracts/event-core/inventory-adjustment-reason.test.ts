import { describe, expect, it } from "vitest";
import {
  inventoryAdjustmentReasons,
  isInventoryAdjustmentReason,
  type InventoryAdjustmentReason,
} from "@chase-sets/event-core/public-event-payloads";

const producerByReason = {
  "sold-offline": "honor-offline reduction",
  damaged: "operator adjustment",
  lost: "operator adjustment",
  found: "operator adjustment",
  correction: "operator, seed, or import correction",
  intake: "listing-stock top-up or positive additive import",
  "return-restocked": "restocked return decision",
} as const satisfies Record<InventoryAdjustmentReason, string>;

describe("inventory adjustment reason contract", () => {
  it("publishes exactly the seven producer-backed adjustment reasons", () => {
    expect(inventoryAdjustmentReasons).toEqual([
      "sold-offline",
      "damaged",
      "lost",
      "found",
      "correction",
      "intake",
      "return-restocked",
    ]);
    expect(Object.keys(producerByReason)).toEqual(inventoryAdjustmentReasons);
  });

  it.each(["written-off", "sale-consumed", "unknown"])("rejects non-adjustment reason %s", (value) => {
    expect(isInventoryAdjustmentReason(value)).toBe(false);
  });
});
