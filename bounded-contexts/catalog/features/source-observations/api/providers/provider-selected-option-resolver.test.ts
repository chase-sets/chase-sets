import { describe, expect, it } from "vitest";
import { tcgplayerAutomationClientProviderProfile } from "../provider-integration-profiles";
import {
  resolveCatalogProviderSelectedOptions,
  type CatalogProviderProductReferenceSchema,
} from "./provider-selected-option-resolver";

describe("resolveCatalogProviderSelectedOptions", () => {
  it("resolves provider evidence through config and active schema options", () => {
    const result = resolveCatalogProviderSelectedOptions({
      mapping: tcgplayerAutomationClientProviderProfile.selectedOptionMapping,
      payload: { sealed: false },
      record: { sku: 7001001, condition: "Near-Mint", variant: "Holofoil", language: "English" },
      productReferenceSchema: pokemonProductReferenceSchema(),
    });

    expect(result).toMatchObject({
      resolved: true,
      diagnostics: [],
      reviewEvidence: [],
    });
    expect(result.selectedOptions).toEqual([
      { dimensionId: "dim_language", optionId: "opt_english" },
      { dimensionId: "dim_condition", optionId: "opt_near_mint" },
      { dimensionId: "dim_form", optionId: "opt_raw" },
      { dimensionId: "dim_printing", optionId: "opt_holofoil" },
    ]);
  });

  it("keeps unknown provider values as review evidence without selected options", () => {
    const result = resolveCatalogProviderSelectedOptions({
      mapping: tcgplayerAutomationClientProviderProfile.selectedOptionMapping,
      payload: { sealed: false },
      record: { sku: 7001001, condition: "Gem Mint", variant: "Galaxy Foil", language: "English" },
      productReferenceSchema: pokemonProductReferenceSchema(),
    });

    expect(result.resolved).toBe(false);
    expect(result.selectedOptions).toEqual([
      { dimensionId: "dim_language", optionId: "opt_english" },
      { dimensionId: "dim_form", optionId: "opt_raw" },
    ]);
    expect(result.reviewEvidence).toEqual([
      { dimensionKey: "condition", providerValue: "Gem Mint", reason: "unknown-provider-option" },
      { dimensionKey: "printing", providerValue: "Galaxy Foil", reason: "unknown-provider-option" },
    ]);
  });

  it("blocks inactive schema options", () => {
    const result = resolveCatalogProviderSelectedOptions({
      mapping: tcgplayerAutomationClientProviderProfile.selectedOptionMapping,
      payload: { sealed: false },
      record: { sku: 7001001, condition: "Near Mint", variant: "Holofoil", language: "English" },
      productReferenceSchema: {
        dimensions: pokemonProductReferenceSchema().dimensions.map((dimension) =>
          dimension.dimensionKey === "condition"
            ? {
                ...dimension,
                options: dimension.options.map((option) =>
                  option.optionId === "opt_near_mint" ? { ...option, status: "inactive" } : option,
                ),
              }
            : dimension,
        ),
      },
    });

    expect(result.resolved).toBe(false);
    expect(result.reviewEvidence).toContainEqual({
      dimensionKey: "condition",
      providerValue: "Near Mint",
      reason: "inactive-schema-option",
    });
  });

  it("blocks missing required schema dimensions", () => {
    const result = resolveCatalogProviderSelectedOptions({
      mapping: tcgplayerAutomationClientProviderProfile.selectedOptionMapping,
      payload: { sealed: false },
      record: { sku: 7001001, condition: "Near Mint", variant: "Holofoil", language: "English" },
      productReferenceSchema: {
        dimensions: pokemonProductReferenceSchema().dimensions.filter(
          (dimension) => dimension.dimensionKey !== "product-form",
        ),
      },
    });

    expect(result.resolved).toBe(false);
    expect(result.reviewEvidence).toContainEqual({
      dimensionKey: "product-form",
      providerValue: "single",
      reason: "missing-schema-dimension",
    });
  });
});

function pokemonProductReferenceSchema(): CatalogProviderProductReferenceSchema {
  return {
    dimensions: [
      {
        dimensionKey: "language",
        dimensionId: "dim_language",
        options: [{ optionId: "opt_english", optionKey: "english" }],
      },
      {
        dimensionKey: "condition",
        dimensionId: "dim_condition",
        required: true,
        options: [{ optionId: "opt_near_mint", optionKey: "near-mint", aliases: ["Near Mint"] }],
      },
      {
        dimensionKey: "product-form",
        dimensionId: "dim_form",
        required: true,
        options: [
          { optionId: "opt_raw", optionKey: "raw" },
          { optionId: "opt_unopened", optionKey: "unopened" },
        ],
      },
      {
        dimensionKey: "printing",
        dimensionId: "dim_printing",
        options: [{ optionId: "opt_holofoil", optionKey: "holofoil" }],
      },
    ],
  };
}
