import type { CatalogRepresentativeCatalogUsageCandidate } from "@chase-sets/catalog/server";
import { describe, expect, it } from "vitest";
import {
  reconcileRepresentativeInventoryCatalogItems,
  selectDefaultRepresentativeOptions,
} from "../support/seed-support/representative-commerce-state";

describe("inventory representative commerce state", () => {
  it("selects default required product options from current Catalog product schema", () => {
    expect(
      selectDefaultRepresentativeOptions({
        canonicalDimensionOrder: [
          { dimensionId: "dim_form", dimensionName: "Form" },
          { dimensionId: "dim_condition", dimensionName: "Condition" },
        ],
        dimensions: [
          {
            dimensionId: "dim_form",
            dimensionName: "Form",
            required: true,
            appliesWhen: [],
            allowedOptions: [
              { optionId: "opt_raw", code: "raw", label: "Raw" },
              { optionId: "opt_graded", code: "graded", label: "Graded" },
            ],
          },
          {
            dimensionId: "dim_condition",
            dimensionName: "Condition",
            required: true,
            appliesWhen: [{ dimensionId: "dim_form", optionIds: ["opt_raw"] }],
            allowedOptions: [
              { optionId: "opt_near_mint", code: "near-mint", label: "Near Mint" },
              { optionId: "opt_played", code: "played", label: "Played" },
            ],
          },
        ],
      }),
    ).toEqual([
      { dimensionId: "dim_form", optionId: "opt_raw" },
      { dimensionId: "dim_condition", optionId: "opt_near_mint" },
    ]);
  });

  it("prefers raw stock options when current Catalog product schema lists graded form first", () => {
    expect(
      selectDefaultRepresentativeOptions({
        canonicalDimensionOrder: [
          { dimensionId: "dim_form", dimensionName: "Form" },
          { dimensionId: "dim_grading_company", dimensionName: "Grading Company" },
          { dimensionId: "dim_grade", dimensionName: "Grade" },
          { dimensionId: "dim_condition", dimensionName: "Condition" },
        ],
        dimensions: [
          {
            dimensionId: "dim_form",
            dimensionName: "Form",
            required: true,
            appliesWhen: [],
            allowedOptions: [
              { optionId: "opt_graded", code: "graded", label: "Graded" },
              { optionId: "opt_raw", code: "raw", label: "Raw" },
            ],
          },
          {
            dimensionId: "dim_grading_company",
            dimensionName: "Grading Company",
            required: true,
            appliesWhen: [{ dimensionId: "dim_form", optionIds: ["opt_graded"] }],
            allowedOptions: [
              { optionId: "opt_psa", code: "psa", label: "PSA" },
              { optionId: "opt_cgc", code: "cgc", label: "CGC" },
            ],
          },
          {
            dimensionId: "dim_grade",
            dimensionName: "Grade",
            required: true,
            appliesWhen: [{ dimensionId: "dim_form", optionIds: ["opt_graded"] }],
            allowedOptions: [
              { optionId: "opt_gem_mint", code: "gem-mint", label: "Gem Mint" },
              { optionId: "opt_near_mint_grade", code: "near-mint", label: "Near Mint" },
            ],
          },
          {
            dimensionId: "dim_condition",
            dimensionName: "Condition",
            required: true,
            appliesWhen: [{ dimensionId: "dim_form", optionIds: ["opt_raw"] }],
            allowedOptions: [
              { optionId: "opt_near_mint", code: "near-mint", label: "Near Mint" },
              { optionId: "opt_played", code: "played", label: "Played" },
            ],
          },
        ],
      }),
    ).toEqual([
      { dimensionId: "dim_form", optionId: "opt_raw" },
      { dimensionId: "dim_condition", optionId: "opt_near_mint" },
    ]);
  });

  it("reconciles selected current Catalog candidates into the Inventory catalog projection", async () => {
    const queries: unknown[][] = [];
    const services = {
      db: {
        query: async <Row>(sql: string, params?: readonly unknown[]) => {
          queries.push([sql, params]);
          return { rows: [] as Row[], rowCount: 1 };
        },
      },
    };

    await expect(
      reconcileRepresentativeInventoryCatalogItems(services as never, [representativeCatalogCandidate("cat_real_1")]),
    ).resolves.toBe(1);

    expect(String(queries[0]?.[0])).toContain("INSERT INTO inventory_catalog_items");
    expect(queries[0]?.[1]).toEqual([
      "cat_real_1",
      "en",
      "Real Imported Card",
      "Provider expansion 12/123",
      "bp_card",
      "active",
      JSON.stringify({ canonicalDimensionOrder: [], dimensions: [] }),
      "2026-05-27T00:00:00.000Z",
    ]);
  });
});

function representativeCatalogCandidate(catalogItemId: string): CatalogRepresentativeCatalogUsageCandidate {
  return {
    catalogItemId,
    languageCode: "en",
    title: "Real Imported Card",
    subtitle: "Provider expansion 12/123",
    blueprintId: "bp_card",
    status: "active",
    productSchema: { canonicalDimensionOrder: [], dimensions: [] },
    productMeasureSnapshots: [{ productId: `${catalogItemId}::` } as never],
    updatedAt: "2026-05-27T00:00:00.000Z",
  };
}
