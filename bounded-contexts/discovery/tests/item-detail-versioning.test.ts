import { describe, expect, it } from "vitest";
import type { VersionSchema } from "../support/client-support/contracts";
import {
  createDiscoveryProductDescriptor,
  isProductSelectionComplete,
  normalizeProductSearchOptionsForSchema,
} from "../features/item-detail/domain/versioning";

const schema: VersionSchema = {
  canonicalDimensionOrder: [
    { dimensionId: "form", dimensionName: "Form" },
    { dimensionId: "condition", dimensionName: "Condition" },
  ],
  dimensions: [
    {
      dimensionId: "form",
      dimensionName: "Form",
      required: true,
      appliesWhen: [],
      allowedOptions: [
        { optionId: "raw", code: "raw", labels: [{ locale: "en", value: "Raw" }] },
        { optionId: "graded", code: "graded", labels: [{ locale: "en", value: "Graded" }] },
      ],
    },
    {
      dimensionId: "condition",
      dimensionName: "Condition",
      required: true,
      appliesWhen: [{ dimensionId: "form", optionIds: ["raw"] }],
      allowedOptions: [
        { optionId: "near_mint", code: "near-mint", labels: [{ locale: "en", value: "Near Mint" }] },
        { optionId: "excellent", code: "excellent", labels: [{ locale: "en", value: "Excellent" }] },
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
});
