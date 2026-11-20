import { describe, expect, it } from "vitest";
import { classifyInventoryGradedSelection, inventoryGradedSelections } from "./graded-selection";
import type { InventoryProductDimension, InventoryProductSchema } from "./versioning";

function dimension(
  dimensionId: string,
  dimensionName: string,
  options: ReadonlyArray<readonly [optionId: string, label: string, code?: string]>,
  appliesWhen: InventoryProductDimension["appliesWhen"] = [],
  required = false,
): InventoryProductDimension {
  return {
    dimensionId,
    dimensionName,
    required,
    appliesWhen,
    allowedOptions: options.map(([optionId, label, code]) => ({ optionId, label, code: code ?? optionId })),
  };
}

function schema(...dimensions: InventoryProductDimension[]): InventoryProductSchema {
  return {
    canonicalDimensionOrder: dimensions.map(({ dimensionId, dimensionName }) => ({ dimensionId, dimensionName })),
    dimensions,
  };
}

const graded = [{ dimensionId: "dim_form", optionIds: ["opt_graded"] }];
const cardSchema = schema(
  dimension("dim_form", "Form", [
    ["opt_raw", "Raw"],
    ["opt_graded", "Graded"],
  ]),
  dimension("dim_company", "Grading Company", [["opt_psa", "PSA"]], graded),
  dimension("dim_grade", "Grade", [["opt_ten", "10"]], graded),
  dimension(
    "dim_condition",
    "Condition",
    [["opt_nm", "Near Mint"]],
    [{ dimensionId: "dim_form", optionIds: ["opt_raw"] }],
  ),
);

describe("server graded option identities", () => {
  it("names exact Form/Graded option IDs from the server schema, never labels", () => {
    expect(inventoryGradedSelections(cardSchema)).toEqual([{ dimensionId: "dim_form", optionId: "opt_graded" }]);
  });

  it("returns none for a null schema and for legacy or non-exact names and labels", () => {
    expect(inventoryGradedSelections(null)).toEqual([]);
    expect(
      inventoryGradedSelections(
        schema(
          dimension("dim_card_form", "Card Form", [["opt_graded", "Graded"]]),
          dimension("dim_form", "Form", [
            ["opt_slab", "Graded (Slab)"],
            ["opt_lower", "graded"],
          ]),
        ),
      ),
    ).toEqual([]);
  });

  it("uses the option code when the label is empty, matching the shared label rule", () => {
    expect(inventoryGradedSelections(schema(dimension("dim_form", "Form", [["opt_slabbed", "", "Graded"]])))).toEqual([
      { dimensionId: "dim_form", optionId: "opt_slabbed" },
    ]);
  });

  it("classifies the exact active Form/Graded selection with its selected company and grade", () => {
    expect(
      classifyInventoryGradedSelection(cardSchema, [
        { dimensionId: "dim_form", optionId: "opt_graded" },
        { dimensionId: "dim_company", optionId: "opt_psa" },
        { dimensionId: "dim_grade", optionId: "opt_ten" },
      ]),
    ).toEqual({ kind: "graded", gradingCompany: "PSA", grade: "10" });
  });

  it("reports an absent or blank company and grade as null", () => {
    const blank = schema(
      dimension("dim_form", "Form", [["opt_graded", "Graded"]]),
      dimension("dim_company", "Grading Company", [["opt_blank", " "]]),
    );
    expect(classifyInventoryGradedSelection(blank, [{ dimensionId: "dim_form", optionId: "opt_graded" }])).toEqual({
      kind: "graded",
      gradingCompany: null,
      grade: null,
    });
    expect(
      classifyInventoryGradedSelection(blank, [
        { dimensionId: "dim_form", optionId: "opt_graded" },
        { dimensionId: "dim_company", optionId: "opt_blank" },
      ]),
    ).toEqual({ kind: "graded", gradingCompany: null, grade: null });
  });

  it("classifies raw, null schema and unknown options as raw", () => {
    expect(classifyInventoryGradedSelection(cardSchema, [{ dimensionId: "dim_form", optionId: "opt_raw" }])).toEqual({
      kind: "raw",
    });
    expect(classifyInventoryGradedSelection(null, [])).toEqual({ kind: "raw" });
    expect(
      classifyInventoryGradedSelection(cardSchema, [{ dimensionId: "dim_form", optionId: "opt_unknown" }]),
    ).toEqual({ kind: "raw" });
  });

  it("never classifies an inactive Form/Graded selection as graded or raw", () => {
    const inactive = schema(
      dimension("dim_kind", "Kind", [
        ["opt_card", "Card"],
        ["opt_sealed", "Sealed"],
      ]),
      dimension("dim_form", "Form", [["opt_graded", "Graded"]], [{ dimensionId: "dim_kind", optionIds: ["opt_card"] }]),
    );
    expect(
      classifyInventoryGradedSelection(inactive, [
        { dimensionId: "dim_kind", optionId: "opt_sealed" },
        { dimensionId: "dim_form", optionId: "opt_graded" },
      ]),
    ).toEqual({ kind: "unsupported" });
  });

  it.each([
    ["Graded (Slab)", schema(dimension("dim_form", "Form", [["opt_slab", "Graded (Slab)"]])), "opt_slab"],
    ["Card Form", schema(dimension("dim_form", "Card Form", [["opt_graded", "Graded"]])), "opt_graded"],
  ])("refuses to downgrade the legacy %s selection to raw", (_name, legacy, optionId) => {
    expect(classifyInventoryGradedSelection(legacy, [{ dimensionId: "dim_form", optionId }])).toEqual({
      kind: "unsupported",
    });
  });
});
