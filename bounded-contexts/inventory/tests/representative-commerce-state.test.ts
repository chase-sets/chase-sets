import { describe, expect, it } from "vitest";
import { selectDefaultRepresentativeOptions } from "../support/seed-support/representative-commerce-state";

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
});
