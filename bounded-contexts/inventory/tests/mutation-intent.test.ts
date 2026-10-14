import { describe, expect, it } from "vitest";
import { normalizeInventoryMutationIntent } from "../support/runtime-support/mutation-intent";

describe("issue-7169-ac2-single-target-replay: normalized intent", () => {
  it("normalizes timezone and trailing precision without losing sub-millisecond intent", () => {
    const hold = {
      accountId: "acc_synthetic",
      itemId: "inv_synthetic",
      quantity: 1,
      reason: "Synthetic",
      purpose: "checkout",
      sourceRef: { checkoutSessionId: "chk_synthetic", lineKey: "line_synthetic" },
    };
    const normalized = normalizeInventoryMutationIntent("hold-create", {
      ...hold,
      expiresAt: "2026-10-12T12:00:00.123000001Z",
    });
    expect(normalized).toEqual(
      normalizeInventoryMutationIntent("hold-create", { ...hold, expiresAt: "2026-10-12T07:00:00.123000001-05:00" }),
    );
    expect(normalized).not.toEqual(
      normalizeInventoryMutationIntent("hold-create", { ...hold, expiresAt: "2026-10-12T12:00:00.123000002Z" }),
    );
    expect(() => normalizeInventoryMutationIntent("hold-create", { ...hold, expiresAt: "2026-10-12" })).toThrow(
      "timezone-bearing",
    );
  });
  const item = {
    accountId: "acc_synthetic",
    catalogItemId: "cat_synthetic",
    storageLocationId: "loc_synthetic",
    totalQuantity: 2,
    selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
  };
  it("normalizes absent and explicit create defaults", () => {
    expect(normalizeInventoryMutationIntent("item-create", item)).toEqual(
      normalizeInventoryMutationIntent("item-create", {
        ...item,
        gradedCard: null,
        acquisitionCostAmount: null,
        acquisitionCostCurrencyCode: null,
        acquisitionOccurrence: { kind: "unknown" },
      }),
    );
  });
  it("normalizes semantic option order while preserving changed choices", () => {
    const options = [
      { dimensionId: "form", optionId: "raw" },
      { dimensionId: "condition", optionId: "nm" },
    ];
    const normalized = normalizeInventoryMutationIntent("item-create", { ...item, selectedOptions: options });
    expect(normalized).toEqual(
      normalizeInventoryMutationIntent("item-create", { ...item, selectedOptions: [...options].reverse() }),
    );
    expect(normalized).not.toEqual(
      normalizeInventoryMutationIntent("item-create", { ...item, selectedOptions: options.slice(0, 1) }),
    );
  });
  it("preserves adjustment note presence while normalizing whitespace and default source", () => {
    const adjust = { accountId: "acc_synthetic", itemId: "inv_synthetic", quantityDelta: -1, reason: " Correction " };
    expect(normalizeInventoryMutationIntent("item-adjust", adjust)).toEqual(
      normalizeInventoryMutationIntent("item-adjust", { ...adjust, reason: "Correction", sourceRef: null }),
    );
    expect(normalizeInventoryMutationIntent("item-adjust", adjust)).not.toEqual(
      normalizeInventoryMutationIntent("item-adjust", { ...adjust, note: null }),
    );
    expect(normalizeInventoryMutationIntent("item-adjust", { ...adjust, note: "  check  " })).toEqual(
      normalizeInventoryMutationIntent("item-adjust", { ...adjust, note: "check" }),
    );
  });
  it("rejects recursively unknown input and duplicate options", () => {
    expect(() => normalizeInventoryMutationIntent("item-create", { ...item, rawSecret: "synthetic" })).toThrow(
      "Unknown Inventory mutation field",
    );
    expect(() =>
      normalizeInventoryMutationIntent("item-create", {
        ...item,
        selectedOptions: [{ dimensionId: "form", optionId: "raw", unknown: true }],
      }),
    ).toThrow("Unknown Inventory mutation field");
    expect(() =>
      normalizeInventoryMutationIntent("item-create", {
        ...item,
        selectedOptions: [item.selectedOptions[0], item.selectedOptions[0]],
      }),
    ).toThrow("Duplicate selected option");
  });
});
