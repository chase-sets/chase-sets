import { describe, expect, it } from "vitest";
import { decideInventoryItem, evolveInventoryItem, initialInventoryItemState } from "./domain";

const unknownAcquisition = {
  acquisitionOccurrence: { kind: "unknown" as const },
  commandOccurredAt: "2026-09-07T06:00:00Z",
};

describe("inventory item domain", () => {
  it("creates and adjusts an inventory item", async () => {
    const created = await decideInventoryItem(initialInventoryItemState, {
      type: "CreateInventoryItem",
      ...unknownAcquisition,
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
      ...unknownAcquisition,
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
      ...unknownAcquisition,
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
      ...unknownAcquisition,
      quantityDelta: 1,
      heldQuantity: 0,
      reason: "Legacy correction",
    });

    expect(adjusted?.data).not.toHaveProperty("reasonCode");
    expect(adjusted?.data).not.toHaveProperty("note");
    expect(adjusted?.data.acquisitionOccurrence).toEqual({ kind: "unknown" });
  });

  it("captures known acquisition occurrence on create and positive adjustment without using command time", () => {
    const [created] = decideInventoryItem(initialInventoryItemState, {
      type: "CreateInventoryItem",
      itemId: "inv_1" as never,
      accountId: "acc_1" as never,
      catalogItemId: "cat_1",
      productId: "cat_1::" as never,
      selectedOptions: [],
      storageLocationId: "loc_1",
      totalQuantity: 1,
      acquisitionOccurrence: {
        kind: "occurred",
        occurredAt: "2026-09-01T05:00:00-05:00",
        source: "seller-supplied",
      },
      commandOccurredAt: "2026-09-07T06:00:00Z",
    });
    expect(created?.data.acquisitionOccurrence).toEqual({
      kind: "occurred",
      occurredAt: "2026-09-01T05:00:00-05:00",
      source: "seller-supplied",
    });

    const state = evolveInventoryItem(initialInventoryItemState, created!);
    const [adjusted] = decideInventoryItem(state, {
      type: "AdjustInventoryItemQuantity",
      quantityDelta: 2,
      heldQuantity: 0,
      reason: "Import intake",
      acquisitionOccurrence: {
        kind: "occurred",
        occurredAt: "2026-09-02T10:00:00Z",
        source: "import-supplied",
      },
      commandOccurredAt: "2026-09-07T06:00:00Z",
    });
    expect(adjusted?.data.acquisitionOccurrence).toMatchObject({
      occurredAt: "2026-09-02T10:00:00Z",
      source: "import-supplied",
    });
  });

  it("rejects missing, timezone-less, future, and reduction acquisition claims", () => {
    const create = {
      type: "CreateInventoryItem" as const,
      itemId: "inv_1" as never,
      accountId: "acc_1" as never,
      catalogItemId: "cat_1",
      productId: "cat_1::" as never,
      selectedOptions: [],
      storageLocationId: "loc_1",
      totalQuantity: 1,
      commandOccurredAt: "2026-09-07T06:00:00Z",
    };
    expect(() => decideInventoryItem(initialInventoryItemState, create as never)).toThrow(/explicit acquisition/);
    expect(() =>
      decideInventoryItem(initialInventoryItemState, {
        ...create,
        acquisitionOccurrence: {
          kind: "occurred",
          occurredAt: "2026-09-01T05:00:00",
          source: "seller-supplied",
        },
      }),
    ).toThrow(/timezone-bearing/);
    expect(() =>
      decideInventoryItem(initialInventoryItemState, {
        ...create,
        acquisitionOccurrence: {
          kind: "occurred",
          occurredAt: "2026-09-08T05:00:00Z",
          source: "seller-supplied",
        },
      }),
    ).toThrow(/cannot be later/);

    const [created] = decideInventoryItem(initialInventoryItemState, {
      ...create,
      acquisitionOccurrence: { kind: "unknown" },
    });
    const state = evolveInventoryItem(initialInventoryItemState, created!);
    expect(() =>
      decideInventoryItem(state, {
        type: "AdjustInventoryItemQuantity",
        quantityDelta: -1,
        heldQuantity: 0,
        reason: "Reduction",
        acquisitionOccurrence: { kind: "unknown" },
      }),
    ).toThrow(/reductions cannot claim/);
  });

  it("rejects adjustments below committed held quantity", async () => {
    const created = await decideInventoryItem(initialInventoryItemState, {
      type: "CreateInventoryItem",
      ...unknownAcquisition,
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

  it("records one applied offline sale as an adjustment plus a per-unit sale fact", () => {
    const [created] = decideInventoryItem(initialInventoryItemState, {
      type: "CreateInventoryItem",
      ...unknownAcquisition,
      itemId: "inv_1" as never,
      accountId: "acc_1" as never,
      catalogItemId: "cat_1",
      productId: "cat_1::" as never,
      selectedOptions: [],
      storageLocationId: "loc_1",
      totalQuantity: 5,
      acquisitionCostAmount: "75.00",
    });
    const createdState = evolveInventoryItem(initialInventoryItemState, created!);

    const events = decideInventoryItem(createdState, {
      type: "RecordOfflineSale",
      quantity: 3,
      heldQuantity: 0,
      salePriceAmount: "125.00",
      channel: "in-store",
      note: " Counter sale ",
      recordedAt: "2026-08-25T20:00:00.000Z",
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "inventory.item.adjusted",
        data: expect.objectContaining({
          itemId: "inv_1",
          quantityDelta: -3,
          reason: "Offline sale",
          reasonCode: "sold-offline",
          note: "Counter sale",
        }),
      }),
      {
        type: "inventory.item.offline-sale-recorded",
        data: {
          itemId: "inv_1",
          quantity: 3,
          salePriceAmount: "125.00",
          channel: "in-store",
          storageLocationId: "loc_1",
          acquisitionCostAmount: "75.00",
          recordedAt: "2026-08-25T20:00:00.000Z",
        },
      },
    ]);
    expect(events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ data: expect.objectContaining({ salePriceAmount: "375.00" }) }),
      ]),
    );
  });

  it("fences the external-channel reason behind its dedicated Inventory command", () => {
    const state = {
      ...initialInventoryItemState,
      id: "inv_1" as never,
      accountId: "acc_1" as never,
      storageLocationId: "loc_1",
      totalQuantity: 3,
    };
    expect(() =>
      decideInventoryItem(state, {
        type: "AdjustInventoryItemQuantity",
        quantityDelta: -1,
        heldQuantity: 0,
        reason: "Forged channel sale",
        reasonCode: "sold-external-channel",
      }),
    ).toThrow("require the Inventory-owned external sale command");
    expect(
      decideInventoryItem(state, {
        type: "RecordExternalChannelSaleAdjustment",
        quantity: 1,
        heldQuantity: 0,
      }),
    ).toEqual([
      {
        type: "inventory.item.adjusted",
        data: {
          itemId: "inv_1",
          quantityDelta: -1,
          reason: "External channel sale",
          reasonCode: "sold-external-channel",
          sourceRef: null,
        },
      },
    ]);
  });

  it("rejects invalid offline-sale quantity, price, channel, and held floors", () => {
    const state = {
      ...initialInventoryItemState,
      id: "inv_1" as never,
      accountId: "acc_1" as never,
      storageLocationId: "loc_1",
      totalQuantity: 3,
    };
    const valid = {
      type: "RecordOfflineSale" as const,
      quantity: 1,
      heldQuantity: 0,
      salePriceAmount: "1.00",
      channel: "other" as const,
      recordedAt: "2026-08-25T20:00:00.000Z",
    };

    expect(() => decideInventoryItem(state, { ...valid, quantity: 0 })).toThrow("positive whole-number");
    expect(() => decideInventoryItem(state, { ...valid, quantity: 1.5 })).toThrow("positive whole-number");
    expect(() => decideInventoryItem(state, { ...valid, salePriceAmount: "10000000000.00" })).toThrow();
    expect(() => decideInventoryItem(state, { ...valid, channel: "other-marketplace" as never })).toThrow(
      "supported channel",
    );
    expect(() => decideInventoryItem(state, { ...valid, quantity: 2, heldQuantity: 2 })).toThrow(
      "2 units are committed",
    );
  });

  it("keeps graded card details on the inventory item", async () => {
    const created = await decideInventoryItem(initialInventoryItemState, {
      type: "CreateInventoryItem",
      ...unknownAcquisition,
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
