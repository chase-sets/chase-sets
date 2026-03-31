import { describe, expect, it } from "vitest";
import type { CatalogItemId, ChoiceId, DimensionId } from "./ids";
import {
  resolveCatalogVersion,
  toCatalogVersionSchema,
  type VersionableBlueprint,
} from "./versioning";

const itemId = "cat_charizard" as CatalogItemId;
const formDimensionId = "dim_form" as DimensionId;
const conditionDimensionId = "dim_condition" as DimensionId;
const gradingCompanyDimensionId = "dim_grading_company" as DimensionId;
const gradeDimensionId = "dim_grade" as DimensionId;

const rawChoiceId = "chc_form_raw" as ChoiceId;
const gradedChoiceId = "chc_form_graded" as ChoiceId;
const nearMintChoiceId = "chc_condition_nm" as ChoiceId;
const psaChoiceId = "chc_company_psa" as ChoiceId;
const gemMintChoiceId = "chc_grade_10" as ChoiceId;

const blueprint: VersionableBlueprint = {
  canonicalDimensionOrder: [
    formDimensionId,
    conditionDimensionId,
    gradingCompanyDimensionId,
    gradeDimensionId,
  ],
  dimensionRules: [
    {
      dimensionId: formDimensionId,
      required: true,
      allowedChoiceIds: [rawChoiceId, gradedChoiceId],
    },
    {
      dimensionId: conditionDimensionId,
      required: true,
      allowedChoiceIds: [nearMintChoiceId],
      appliesWhen: [
        { dimensionId: formDimensionId, choiceIds: [rawChoiceId] },
      ],
    },
    {
      dimensionId: gradingCompanyDimensionId,
      required: true,
      allowedChoiceIds: [psaChoiceId],
      appliesWhen: [
        { dimensionId: formDimensionId, choiceIds: [gradedChoiceId] },
      ],
    },
    {
      dimensionId: gradeDimensionId,
      required: true,
      allowedChoiceIds: [gemMintChoiceId],
      appliesWhen: [
        { dimensionId: formDimensionId, choiceIds: [gradedChoiceId] },
      ],
    },
  ],
};

describe("catalog versioning", () => {
  it("resolves a raw card selection", () => {
    const result = resolveCatalogVersion({
      itemId,
      blueprint,
      selection: [
        { dimensionId: formDimensionId, choiceId: rawChoiceId },
        { dimensionId: conditionDimensionId, choiceId: nearMintChoiceId },
      ],
    });

    expect(result.selection).toEqual([
      { dimensionId: String(formDimensionId), choiceId: String(rawChoiceId) },
      {
        dimensionId: String(conditionDimensionId),
        choiceId: String(nearMintChoiceId),
      },
    ]);
    expect(result.versionKey).toContain(`${String(gradingCompanyDimensionId)}:-`);
    expect(result.versionKey).toContain(`${String(gradeDimensionId)}:-`);
  });

  it("resolves a graded card selection", () => {
    const result = resolveCatalogVersion({
      itemId,
      blueprint,
      selection: [
        { dimensionId: formDimensionId, choiceId: gradedChoiceId },
        { dimensionId: gradingCompanyDimensionId, choiceId: psaChoiceId },
        { dimensionId: gradeDimensionId, choiceId: gemMintChoiceId },
      ],
    });

    expect(result.selection).toEqual([
      { dimensionId: String(formDimensionId), choiceId: String(gradedChoiceId) },
      {
        dimensionId: String(gradingCompanyDimensionId),
        choiceId: String(psaChoiceId),
      },
      { dimensionId: String(gradeDimensionId), choiceId: String(gemMintChoiceId) },
    ]);
    expect(result.versionKey).toContain(`${String(conditionDimensionId)}:-`);
  });

  it("rejects missing required dimensions for the active form", () => {
    expect(() =>
      resolveCatalogVersion({
        itemId,
        blueprint,
        selection: [{ dimensionId: formDimensionId, choiceId: gradedChoiceId }],
      }),
    ).toThrowError("Selections must include every required dimension.");
  });

  it("rejects inactive dimensions in a selection", () => {
    expect(() =>
      resolveCatalogVersion({
        itemId,
        blueprint,
        selection: [
          { dimensionId: formDimensionId, choiceId: rawChoiceId },
          { dimensionId: conditionDimensionId, choiceId: nearMintChoiceId },
          { dimensionId: gradeDimensionId, choiceId: gemMintChoiceId },
        ],
      }),
    ).toThrowError("Selections cannot include inactive dimensions.");
  });

  it("includes appliesWhen in the exported schema", () => {
    const schema = toCatalogVersionSchema(blueprint);
    expect(schema.dimensions.find((dimension) => dimension.dimensionId === String(conditionDimensionId)))
      .toMatchObject({
        appliesWhen: [
          {
            dimensionId: String(formDimensionId),
            choiceIds: [String(rawChoiceId)],
          },
        ],
      });
  });
});
