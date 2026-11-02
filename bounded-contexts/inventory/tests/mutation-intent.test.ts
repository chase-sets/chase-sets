import { describe, expect, it } from "vitest";
import {
  inventoryMutationFingerprint,
  normalizeInventoryMutationIntent,
} from "../support/runtime-support/mutation-intent";
import { inventorySeedMutationIntent } from "../support/seed-support/mutation-command";

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
  it("preserves old raw and seed fingerprints and distinguishes cert", () => {
    const fingerprint = (value: unknown) =>
      inventoryMutationFingerprint(normalizeInventoryMutationIntent("item-create", value));
    // Pinned from the origin/main normalizer before certification numbers joined the intent.
    const rawFingerprint = "34bd848d715f07876282bc99f33ded36b9acdce7b3a40e9f9dc4491860b0e578";
    expect(fingerprint(item)).toBe(rawFingerprint);
    expect(
      fingerprint({
        ...item,
        gradedCard: null,
        acquisitionCostAmount: null,
        acquisitionCostCurrencyCode: null,
        acquisitionOccurrence: { kind: "unknown" },
      }),
    ).toBe(rawFingerprint);
    for (const certificationNumber of [null, "", "   "]) {
      expect(fingerprint({ ...item, certificationNumber })).toBe(rawFingerprint);
    }

    const seed = inventorySeedMutationIntent(
      {
        type: "CreateInventoryItem",
        catalogItemId: "cat_seed",
        selectedOptions: [{ dimensionId: "form", optionId: "graded" }],
        gradedCard: {
          gradingCompany: "PSA",
          grade: "10",
          certificationNumber: "SEED-1",
          population: { populationAtGrade: 5, populationHigher: 0, source: "PSA", asOf: "2026-01-01" },
          conditionDescriptors: ["Centered"],
        },
        storageLocationId: "loc_seed",
        totalQuantity: 1,
        acquisitionCostAmount: "10.00",
        acquisitionCostCurrencyCode: "USD",
      },
      "inv_seed",
      "acc_seed",
    );
    expect(seed.family).toBe("item-create");
    expect(fingerprint(seed.params)).toBe("8de58675ee779daab0acf8d6afe1817a94631f4791fa62e1071192f3ab808fca");

    const graded = { ...item, selectedOptions: [{ dimensionId: "form", optionId: "graded" }] };
    const certified = fingerprint({ ...graded, certificationNumber: "cert-123" });
    expect(fingerprint({ ...graded, certificationNumber: "  cert-123 " })).toBe(certified);
    expect(fingerprint({ ...graded, certificationNumber: "cert-124" })).not.toBe(certified);
    expect(certified).not.toBe(fingerprint({ ...graded, certificationNumber: null }));
    const oldGradedCreate = {
      ...graded,
      gradedCard: {
        gradingCompany: "PSA",
        grade: "10",
        certificationNumber: "cert-123",
        population: null,
        conditionDescriptors: [],
      },
    };
    expect(fingerprint(oldGradedCreate)).not.toBe(certified);
    expect(() => normalizeInventoryMutationIntent("item-create", { ...item, certificationNumber: 123 })).toThrow(
      "Inventory mutation text is invalid.",
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
