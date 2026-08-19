import { describe, expect, it } from "vitest";
import { decideInventoryItem, evolveInventoryItem, initialInventoryItemState } from "./domain";

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
      heldQuantity: 0,
      reason: "Cycle count",
    });
    const adjustedState = adjusted.reduce(evolveInventoryItem, createdState);

    expect(createdState.totalQuantity).toBe(12);
    expect(adjustedState.totalQuantity).toBe(8);
  });

  it("emits the optional typed reason and normalizes a supplied blank note", async () => {
    const [created] = decideInventoryItem(initialInventoryItemState, {
      type: "CreateInventoryItem",
      itemId: "inv_1" as never,
      accountId: "acc_1" as never,
      catalogItemId: "cat_1",
      productId: "cat_1::" as never,
      selectedOptions: [],
      storageLocationId: "loc_1",
      totalQuantity: 12,
    });
    const createdState = evolveInventoryItem(initialInventoryItemState, created!);

    const [adjusted] = decideInventoryItem(createdState, {
      type: "AdjustInventoryItemQuantity",
      quantityDelta: -1,
      heldQuantity: 0,
      reason: "  Damaged during handling  ",
      reasonCode: "damaged",
      note: "   ",
    });

    expect(adjusted?.data).toMatchObject({
      reason: "Damaged during handling",
      reasonCode: "damaged",
      note: null,
    });
  });

  it("leaves optional adjustment fields absent for legacy commands", () => {
    const [created] = decideInventoryItem(initialInventoryItemState, {
      type: "CreateInventoryItem",
      itemId: "inv_1" as never,
      accountId: "acc_1" as never,
      catalogItemId: "cat_1",
      productId: "cat_1::" as never,
      selectedOptions: [],
      storageLocationId: "loc_1",
      totalQuantity: 12,
    });
    const createdState = evolveInventoryItem(initialInventoryItemState, created!);

    const [adjusted] = decideInventoryItem(createdState, {
      type: "AdjustInventoryItemQuantity",
      quantityDelta: 1,
      heldQuantity: 0,
      reason: "Legacy correction",
    });

    expect(adjusted?.data).not.toHaveProperty("reasonCode");
    expect(adjusted?.data).not.toHaveProperty("note");
  });

  it("rejects adjustments below committed held quantity", async () => {
    const created = await decideInventoryItem(initialInventoryItemState, {
      type: "CreateInventoryItem",
      itemId: "inv_1" as never,
      accountId: "acc_1" as never,
      catalogItemId: "cat_1",
      productId: "cat_1::" as never,
      selectedOptions: [],
      storageLocationId: "loc_1",
      totalQuantity: 5,
    });
    const createdState = created.reduce(evolveInventoryItem, initialInventoryItemState);

    expect(
      decideInventoryItem(createdState, {
        type: "AdjustInventoryItemQuantity",
        quantityDelta: -2,
        heldQuantity: 3,
        reason: "Cycle count",
      }),
    ).toHaveLength(1);
    expect(() =>
      decideInventoryItem(createdState, {
        type: "AdjustInventoryItemQuantity",
        quantityDelta: -3,
        heldQuantity: 3,
        reason: "Cycle count",
      }),
    ).toThrow("3 units are committed to open orders.");
    expect(() =>
      decideInventoryItem(createdState, {
        type: "AdjustInventoryItemQuantity",
        quantityDelta: -4,
        heldQuantity: 4,
        reason: "Cycle count",
      }),
    ).toThrow("4 units are committed to open orders.");
  });

  it("keeps graded card details on the inventory item", async () => {
    const created = await decideInventoryItem(initialInventoryItemState, {
      type: "CreateInventoryItem",
      itemId: "inv_graded" as never,
      accountId: "acc_1" as never,
      catalogItemId: "cat_1",
      productId: "cat_1::form:graded|grading-company:psa|grade:gem-mint-10" as never,
      selectedOptions: [],
      gradedCard: {
        gradingCompany: "PSA",
        grade: "Gem Mint 10",
        certificationNumber: " 12345678 ",
        population: {
          populationAtGrade: 24,
          populationHigher: 0,
          source: "PSA population report",
          asOf: "2026-04-01",
        },
        conditionDescriptors: ["Encapsulated", "Encapsulated", "Clean slab"],
      },
      storageLocationId: "loc_1",
      totalQuantity: 1,
      acquisitionCostAmount: "40.00",
    });
    const createdState = created.reduce(evolveInventoryItem, initialInventoryItemState);

    expect(createdState.gradedCard).toEqual({
      gradingCompany: "PSA",
      grade: "Gem Mint 10",
      certificationNumber: "12345678",
      population: {
        populationAtGrade: 24,
        populationHigher: 0,
        source: "PSA population report",
        asOf: "2026-04-01",
      },
      conditionDescriptors: ["Encapsulated", "Clean slab"],
    });
  });
});
