import { describe, expect, it } from "vitest";
import { buildPackagePlan, type ProductMeasureSnapshot } from "./index";

const rawCardMeasure: ProductMeasureSnapshot = {
  catalogItemId: "cat_card",
  productId: "cat_card::raw",
  selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
  measureVersion: "pokemon-raw-card:v1",
  unitLengthInches: 3.5,
  unitWidthInches: 2.5,
  unitHeightInches: 0.012,
  unitWeightOunces: 0.064,
  physicalFlags: ["raw-card", "bendable"],
  stackBehavior: "stackable-thickness",
  source: "profile",
  confidence: "conservative-estimate",
};

const slabMeasure: ProductMeasureSnapshot = {
  ...rawCardMeasure,
  productId: "cat_card::graded",
  measureVersion: "psa-slab:v1",
  unitLengthInches: 5.375,
  unitWidthInches: 3.25,
  unitHeightInches: 0.375,
  unitWeightOunces: 2.4,
  physicalFlags: ["slab", "rigid"],
};

describe("measured package planning", () => {
  it("selects letter mail for low-value raw singles within limits", () => {
    const plan = buildPackagePlan({
      shippingOption: "standard",
      itemSubtotalAmount: "12.00",
      lines: [{ productId: rawCardMeasure.productId, quantity: 4, measure: rawCardMeasure }],
    });

    expect(plan.packageCount).toBe(1);
    expect(plan.packages[0]?.mailpieceClass).toBe("letter");
    expect(plan.letterEligibility.eligible).toBe(true);
  });

  it("moves raw singles to parcel when value exceeds the letter cap", () => {
    const plan = buildPackagePlan({
      shippingOption: "standard",
      itemSubtotalAmount: "125.00",
      lines: [{ productId: rawCardMeasure.productId, quantity: 1, measure: rawCardMeasure }],
    });

    expect(plan.packages[0]?.mailpieceClass).toBe("parcel");
    expect(plan.letterEligibility.reasons).toContain("declared-value-requires-parcel");
  });

  it("moves slabs to parcel even when quantity and value are small", () => {
    const plan = buildPackagePlan({
      shippingOption: "standard",
      itemSubtotalAmount: "20.00",
      lines: [{ productId: slabMeasure.productId, quantity: 1, measure: slabMeasure }],
    });

    expect(plan.packages[0]?.mailpieceClass).toBe("parcel");
    expect(plan.letterEligibility.reasons).toContain("product-type-requires-parcel");
  });

  it("reports missing product measurements explicitly", () => {
    const plan = buildPackagePlan({
      shippingOption: "standard",
      itemSubtotalAmount: "20.00",
      lines: [{ productId: "cat_missing::raw", quantity: 1, measure: null }],
    });

    expect(plan.packageCount).toBe(0);
    expect(plan.missingProductIds).toEqual(["cat_missing::raw"]);
    expect(plan.letterEligibility.reasons).toContain("missing-product-measures");
  });
});
