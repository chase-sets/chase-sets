import { describe, expect, it } from "vitest";
import { decideInventoryHold, evolveInventoryHold, initialInventoryHoldState } from "./domain";

describe("inventory holds", () => {
  it("places and releases active holds", () => {
    const [placed] = decideInventoryHold(initialInventoryHoldState, {
      type: "PlaceInventoryHold",
      holdId: "hold_1" as never,
      accountId: "acc_1" as never,
      itemId: " inv_1 ",
      quantity: 2,
      reason: " checkout ",
      notes: " Buyer order ",
    });
    const placedState = evolveInventoryHold(initialInventoryHoldState, placed!);
    const [released] = decideInventoryHold(placedState, {
      type: "ReleaseInventoryHold",
      releasedAt: "2026-04-30T00:00:00.000Z",
    });

    expect(placedState).toMatchObject({
      itemId: "inv_1",
      reason: "checkout",
      notes: "Buyer order",
      status: "active",
    });
    expect(evolveInventoryHold(placedState, released!)).toMatchObject({
      status: "released",
      releasedAt: "2026-04-30T00:00:00.000Z",
    });
  });

  it("rejects invalid release transitions", () => {
    expect(() =>
      decideInventoryHold(initialInventoryHoldState, {
        type: "ReleaseInventoryHold",
        releasedAt: "2026-04-30T00:00:00.000Z",
      }),
    ).toThrow("Inventory hold must be created first.");
  });
});
