import { describe, expect, it } from "vitest";
import type { ProductSchema } from "../support/client-support/contracts";
import {
  createDiscoveryProductDescriptor,
  getOrderedDimensionOptions,
  getOrderedActiveDimensions,
  isProductSelectionComplete,
  normalizeProductSearchOptionsForSchema,
} from "../features/item-detail/domain/product-resolution";

const schema: ProductSchema = {
  canonicalDimensionOrder: [
    { dimensionId: "form", dimensionName: "Form" },
    { dimensionId: "condition", dimensionName: "Condition" },
  ],
  dimensions: [
    {
      dimensionId: "form",
      dimensionName: "Form",
      valueKind: "unordered",
      required: true,
      appliesWhen: [],
      allowedOptions: [
        { optionId: "raw", code: "raw", label: "Raw", displayOrder: 0, numericValue: null },
        { optionId: "graded", code: "graded", label: "Graded", displayOrder: 1, numericValue: null },
      ],
    },
    {
      dimensionId: "condition",
      dimensionName: "Condition",
      valueKind: "ordered",
      required: true,
      appliesWhen: [{ dimensionId: "form", optionIds: ["raw"] }],
      allowedOptions: [
        { optionId: "near_mint", code: "near-mint", label: "Near Mint", displayOrder: 0, numericValue: 5 },
        { optionId: "excellent", code: "excellent", label: "Excellent", displayOrder: 1, numericValue: 4 },
      ],
    },
  ],
};

describe("item detail product search options", () => {
  it("keeps the default item page unfiltered", () => {
    const selections = normalizeProductSearchOptionsForSchema(schema, {});

    expect(selections).toEqual({});
    expect(isProductSelectionComplete(schema, selections)).toBe(false);
  });

  it("uses selected options as filters before a complete product is chosen", () => {
    const selections = normalizeProductSearchOptionsForSchema(schema, { form: "raw" });

    expect(selections).toEqual({ form: "raw" });
    expect(isProductSelectionComplete(schema, selections)).toBe(false);
    expect(() =>
      createDiscoveryProductDescriptor({
        catalogItemId: "cat_charizard",
        productSchema: schema,
        selection: [{ dimensionId: "form", optionId: "raw" }],
      }),
    ).toThrow("Selection must include Condition.");
  });

  it("creates a product descriptor after required active options are chosen", () => {
    const descriptor = createDiscoveryProductDescriptor({
      catalogItemId: "cat_charizard",
      productSchema: schema,
      selection: [
        { dimensionId: "form", optionId: "raw" },
        { dimensionId: "condition", optionId: "near_mint" },
      ],
    });

    expect(descriptor).toEqual({
      productId: "cat_charizard::form:raw|condition:near_mint",
      selection: [
        { dimensionId: "form", optionId: "raw" },
        { dimensionId: "condition", optionId: "near_mint" },
      ],
    });
  });

  it("keeps ordered dimension options in schema order with values", () => {
    const condition = getOrderedActiveDimensions(schema, { form: "raw" }).find(
      (dimension) => dimension.dimensionId === "condition",
    );

    expect(condition?.valueKind).toBe("ordered");
    expect(condition?.allowedOptions.map((option) => [option.optionId, option.numericValue])).toEqual([
      ["near_mint", 5],
      ["excellent", 4],
    ]);
  });

  it("orders ordered dimension options by Catalog display order", () => {
    const condition = {
      ...schema.dimensions[1],
      allowedOptions: [
        { optionId: "damaged", code: "damaged", label: "Damaged", displayOrder: 6, numericValue: 1 },
        { optionId: "excellent", code: "excellent", label: "Excellent", displayOrder: 3, numericValue: 4 },
        { optionId: "mint", code: "mint", label: "Mint", displayOrder: 1, numericValue: 6 },
        { optionId: "near_mint", code: "near-mint", label: "Near Mint", displayOrder: 2, numericValue: 5 },
        { optionId: "pristine", code: "pristine", label: "Pristine", displayOrder: 0, numericValue: 7 },
      ],
    };

    expect(getOrderedDimensionOptions(condition).map((option) => option.label)).toEqual([
      "Pristine",
      "Mint",
      "Near Mint",
      "Excellent",
      "Damaged",
    ]);
  });

  it("orders numeric dimension options by numeric value before display order", () => {
    const grade = {
      dimensionId: "grade",
      dimensionName: "Grade",
      valueKind: "numeric" as const,
      required: false,
      appliesWhen: [],
      allowedOptions: [
        { optionId: "grade_9", code: "9", label: "9", displayOrder: 3, numericValue: 9 },
        { optionId: "grade_10", code: "10", label: "10", displayOrder: 2, numericValue: 10 },
        { optionId: "grade_9_5", code: "9.5", label: "9.5", displayOrder: 1, numericValue: 9.5 },
      ],
    };

    expect(getOrderedDimensionOptions(grade).map((option) => option.optionId)).toEqual([
      "grade_10",
      "grade_9_5",
      "grade_9",
    ]);
  });
});
