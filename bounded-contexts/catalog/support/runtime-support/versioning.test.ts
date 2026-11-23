import { describe, expect, it } from "vitest";
import type { CatalogItemId, OptionId, DimensionId } from "../../ids";
import { resolveProduct, toProductSchema, type ProductDefiningBlueprint } from "./versioning";

const catalogItemId = "cat_charizard" as CatalogItemId;
const formDimensionId = "dim_form" as DimensionId;
const conditionDimensionId = "dim_condition" as DimensionId;
const gradingCompanyDimensionId = "dim_grading_company" as DimensionId;
const gradeDimensionId = "dim_grade" as DimensionId;

const rawOptionId = "chc_form_raw" as OptionId;
const gradedOptionId = "chc_form_graded" as OptionId;
const nearMintOptionId = "chc_condition_nm" as OptionId;
const psaOptionId = "chc_company_psa" as OptionId;
const gemMintOptionId = "chc_grade_10" as OptionId;

const blueprint: ProductDefiningBlueprint = {
  canonicalDimensionOrder: [formDimensionId, conditionDimensionId, gradingCompanyDimensionId, gradeDimensionId],
  dimensionRules: [
    {
      dimensionId: formDimensionId,
      required: true,
      allowedOptionIds: [rawOptionId, gradedOptionId],
    },
    {
      dimensionId: conditionDimensionId,
      required: true,
      allowedOptionIds: [nearMintOptionId],
      appliesWhen: [{ dimensionId: formDimensionId, optionIds: [rawOptionId] }],
    },
    {
      dimensionId: gradingCompanyDimensionId,
      required: true,
      allowedOptionIds: [psaOptionId],
      appliesWhen: [{ dimensionId: formDimensionId, optionIds: [gradedOptionId] }],
    },
    {
      dimensionId: gradeDimensionId,
      required: true,
      allowedOptionIds: [gemMintOptionId],
      appliesWhen: [{ dimensionId: formDimensionId, optionIds: [gradedOptionId] }],
    },
  ],
};

describe("catalog product resolution", () => {
  it("resolves a raw card product", () => {
    const result = resolveProduct({
      catalogItemId,
      blueprint,
      selectedOptions: [
        { dimensionId: formDimensionId, optionId: rawOptionId },
        { dimensionId: conditionDimensionId, optionId: nearMintOptionId },
      ],
    });

    expect(result.selectedOptions).toEqual([
      { dimensionId: String(formDimensionId), optionId: String(rawOptionId) },
      {
        dimensionId: String(conditionDimensionId),
        optionId: String(nearMintOptionId),
      },
    ]);
    expect(result.productId).toContain(`${String(gradingCompanyDimensionId)}:-`);
    expect(result.productId).toContain(`${String(gradeDimensionId)}:-`);
  });

  it("resolves a graded card product", () => {
    const result = resolveProduct({
      catalogItemId,
      blueprint,
      selectedOptions: [
        { dimensionId: formDimensionId, optionId: gradedOptionId },
        { dimensionId: gradingCompanyDimensionId, optionId: psaOptionId },
        { dimensionId: gradeDimensionId, optionId: gemMintOptionId },
      ],
    });

    expect(result.selectedOptions).toEqual([
      { dimensionId: String(formDimensionId), optionId: String(gradedOptionId) },
      {
        dimensionId: String(gradingCompanyDimensionId),
        optionId: String(psaOptionId),
      },
      { dimensionId: String(gradeDimensionId), optionId: String(gemMintOptionId) },
    ]);
    expect(result.productId).toContain(`${String(conditionDimensionId)}:-`);
  });

  it("rejects missing required dimensions for the active product form", () => {
    expect(() =>
      resolveProduct({
        catalogItemId,
        blueprint,
        selectedOptions: [{ dimensionId: formDimensionId, optionId: gradedOptionId }],
      }),
    ).toThrowError("Selections must include every required dimension.");
  });

  it("rejects inactive dimensions in a product selection", () => {
    expect(() =>
      resolveProduct({
        catalogItemId,
        blueprint,
        selectedOptions: [
          { dimensionId: formDimensionId, optionId: rawOptionId },
          { dimensionId: conditionDimensionId, optionId: nearMintOptionId },
          { dimensionId: gradeDimensionId, optionId: gemMintOptionId },
        ],
      }),
    ).toThrowError("Selections cannot include inactive dimensions.");
  });

  describe("option applicability", () => {
    const gradedSelection = [
      { dimensionId: formDimensionId, optionId: gradedOptionId },
      { dimensionId: gradingCompanyDimensionId, optionId: psaOptionId },
      { dimensionId: gradeDimensionId, optionId: gemMintOptionId },
    ];
    const gradeAppliesTo = (companyOptionIds: OptionId[], optionId = gemMintOptionId) => [
      {
        dimensionId: gradeDimensionId,
        optionId,
        appliesWhen: [{ dimensionId: gradingCompanyDimensionId, optionIds: companyOptionIds }],
      },
    ];

    it("resolves a selected option whose applicability the selection satisfies", () => {
      const scoped = resolveProduct({
        catalogItemId,
        blueprint,
        selectedOptions: gradedSelection,
        optionApplicability: gradeAppliesTo([psaOptionId]),
      });

      expect(scoped).toEqual(resolveProduct({ catalogItemId, blueprint, selectedOptions: gradedSelection }));
    });

    it("rejects a selected option that does not apply to the other selected options", () => {
      expect(() =>
        resolveProduct({
          catalogItemId,
          blueprint,
          selectedOptions: gradedSelection,
          optionApplicability: gradeAppliesTo(["chc_company_bgs" as OptionId]),
        }),
      ).toThrowError("Selections must use only options that apply to the other selected options.");
    });

    it("ignores the applicability of an option that is not selected", () => {
      expect(() =>
        resolveProduct({
          catalogItemId,
          blueprint,
          selectedOptions: gradedSelection,
          optionApplicability: gradeAppliesTo(["chc_company_bgs" as OptionId], "chc_grade_black_label" as OptionId),
        }),
      ).not.toThrow();
    });
  });

  it("includes appliesWhen in the exported schema", () => {
    const schema = toProductSchema(blueprint);
    expect(schema.dimensions.find((dimension) => dimension.dimensionId === String(conditionDimensionId))).toMatchObject(
      {
        appliesWhen: [
          {
            dimensionId: String(formDimensionId),
            optionIds: [String(rawOptionId)],
          },
        ],
      },
    );
  });
});
