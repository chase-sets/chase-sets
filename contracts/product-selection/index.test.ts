import { describe, expect, it } from "vitest";
import {
  getOrderedActiveProductSelectionDimensions,
  getOrderedProductSelectionDimensions,
  getProductSelectionOptionLabel,
  isProductSelectionDimensionActive,
  normalizeProductSelection,
  productSelectionEntriesToRecord,
  recordToProductSelectionEntries,
  toProductSelectionFields,
  type ProductSelectionSchema,
} from "./index";

const cardSchema: ProductSelectionSchema = {
  canonicalDimensionOrder: [
    { dimensionId: "form" },
    { dimensionId: "condition" },
    { dimensionId: "grading_company" },
    { dimensionId: "grade" },
  ],
  dimensions: [
    {
      dimensionId: "form",
      dimensionName: "Form",
      required: true,
      appliesWhen: [],
      allowedOptions: [
        { optionId: "graded", code: "graded", label: "Graded" },
        { optionId: "raw", code: "raw", label: "Raw" },
      ],
    },
    {
      dimensionId: "condition",
      dimensionName: "Condition",
      required: true,
      appliesWhen: [{ dimensionId: "form", optionIds: ["raw"] }],
      allowedOptions: [
        { optionId: "damaged", code: "damaged", label: "Damaged" },
        { optionId: "near_mint", code: "near_mint", label: "Near Mint" },
      ],
    },
    {
      dimensionId: "grading_company",
      dimensionName: "Grading Company",
      required: true,
      appliesWhen: [{ dimensionId: "form", optionIds: ["graded"] }],
      allowedOptions: [{ optionId: "psa", code: "psa", label: "PSA" }],
    },
    {
      dimensionId: "grade",
      dimensionName: "Grade",
      required: true,
      appliesWhen: [{ dimensionId: "form", optionIds: ["graded"] }],
      allowedOptions: [{ optionId: "gem_mint_10", code: "gem_mint_10", label: "Gem Mint 10" }],
    },
  ],
};

const noSchemaDimensionsSchema: ProductSelectionSchema = {
  canonicalDimensionOrder: [],
  dimensions: [],
};

describe("getOrderedProductSelectionDimensions", () => {
  it("orders dimensions by the canonical order", () => {
    const ordered = getOrderedProductSelectionDimensions(cardSchema);
    expect(ordered.map((dimension) => dimension.dimensionId)).toEqual([
      "form",
      "condition",
      "grading_company",
      "grade",
    ]);
  });

  it("drops canonical order entries with no matching dimension", () => {
    const schema: ProductSelectionSchema = {
      canonicalDimensionOrder: [{ dimensionId: "form" }, { dimensionId: "missing" }],
      dimensions: cardSchema.dimensions.filter((dimension) => dimension.dimensionId === "form"),
    };

    expect(getOrderedProductSelectionDimensions(schema).map((dimension) => dimension.dimensionId)).toEqual(["form"]);
  });
});

describe("isProductSelectionDimensionActive", () => {
  it("is active with no appliesWhen guard", () => {
    const form = cardSchema.dimensions.find((dimension) => dimension.dimensionId === "form")!;
    expect(isProductSelectionDimensionActive(form, {})).toBe(true);
  });

  it("is inactive when the guard clause is unmet", () => {
    const condition = cardSchema.dimensions.find((dimension) => dimension.dimensionId === "condition")!;
    expect(isProductSelectionDimensionActive(condition, { form: "graded" })).toBe(false);
  });

  it("is active when every guard clause is satisfied", () => {
    const condition = cardSchema.dimensions.find((dimension) => dimension.dimensionId === "condition")!;
    expect(isProductSelectionDimensionActive(condition, { form: "raw" })).toBe(true);
  });
});

describe("getOrderedActiveProductSelectionDimensions", () => {
  it("returns only the active dimensions for the raw branch", () => {
    const active = getOrderedActiveProductSelectionDimensions(cardSchema, { form: "raw" });
    expect(active.map((dimension) => dimension.dimensionId)).toEqual(["form", "condition"]);
  });

  it("returns only the active dimensions for the graded branch", () => {
    const active = getOrderedActiveProductSelectionDimensions(cardSchema, { form: "graded" });
    expect(active.map((dimension) => dimension.dimensionId)).toEqual(["form", "grading_company", "grade"]);
  });
});

describe("normalizeProductSelection", () => {
  it("defaults required active dimensions to their first allowed option", () => {
    const normalized = normalizeProductSelection(cardSchema, {});
    expect(normalized).toEqual({ form: "graded", grading_company: "psa", grade: "gem_mint_10" });
  });

  it("drops selections for dimensions that became inactive after a change", () => {
    const withGradedSelections = normalizeProductSelection(cardSchema, {});
    const switchedToRaw = normalizeProductSelection(cardSchema, { ...withGradedSelections, form: "raw" });

    expect(switchedToRaw).toEqual({ form: "raw", condition: "damaged" });
  });

  it("preserves a valid existing selection for an active dimension", () => {
    const normalized = normalizeProductSelection(cardSchema, { form: "raw", condition: "near_mint" });
    expect(normalized).toEqual({ form: "raw", condition: "near_mint" });
  });

  it("replaces a selection naming an option outside the allowed list with the first allowed option, when required", () => {
    const normalized = normalizeProductSelection(cardSchema, { form: "raw", condition: "not_an_option" });
    expect(normalized.condition).toBe("damaged");
  });

  it("drops a selection naming an option outside the allowed list, when not required", () => {
    const optionalConditionSchema: ProductSelectionSchema = {
      ...cardSchema,
      dimensions: cardSchema.dimensions.map((dimension) =>
        dimension.dimensionId === "condition" ? { ...dimension, required: false } : dimension,
      ),
    };

    const normalized = normalizeProductSelection(optionalConditionSchema, { form: "raw", condition: "not_an_option" });
    expect(normalized.condition).toBeUndefined();
  });

  it("is a no-op for a schema with no dimensions", () => {
    expect(normalizeProductSelection(noSchemaDimensionsSchema, { stray: "value" })).toEqual({ stray: "value" });
  });
});

describe("getProductSelectionOptionLabel", () => {
  it("prefers label, then code, then optionId", () => {
    expect(getProductSelectionOptionLabel({ optionId: "raw", code: "raw", label: "Raw" })).toBe("Raw");
    expect(getProductSelectionOptionLabel({ optionId: "raw", code: "raw" })).toBe("raw");
    expect(getProductSelectionOptionLabel({ optionId: "raw" })).toBe("raw");
  });
});

describe("record <-> entries", () => {
  it("round-trips through productSelectionEntriesToRecord and recordToProductSelectionEntries", () => {
    const entries = [
      { dimensionId: "form", optionId: "raw" },
      { dimensionId: "condition", optionId: "damaged" },
    ];

    const record = productSelectionEntriesToRecord(entries);
    expect(record).toEqual({ form: "raw", condition: "damaged" });
    expect(recordToProductSelectionEntries(cardSchema, record)).toEqual(entries);
  });

  it("orders entries by the canonical dimension order regardless of record key order", () => {
    const record = { condition: "damaged", form: "raw" };
    expect(recordToProductSelectionEntries(cardSchema, record)).toEqual([
      { dimensionId: "form", optionId: "raw" },
      { dimensionId: "condition", optionId: "damaged" },
    ]);
  });
});

describe("toProductSelectionFields", () => {
  it("returns an empty list for a null schema", () => {
    expect(toProductSelectionFields(null, {})).toEqual([]);
  });

  it("projects active dimensions into ready-to-render fields", () => {
    const fields = toProductSelectionFields(cardSchema, { form: "raw", condition: "near_mint" });
    expect(fields).toEqual([
      {
        dimensionId: "form",
        label: "Form",
        value: "raw",
        options: [
          { value: "graded", label: "Graded" },
          { value: "raw", label: "Raw" },
        ],
      },
      {
        dimensionId: "condition",
        label: "Condition",
        value: "near_mint",
        options: [
          { value: "damaged", label: "Damaged" },
          { value: "near_mint", label: "Near Mint" },
        ],
      },
    ]);
  });
});
