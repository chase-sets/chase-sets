import { describe, expect, it } from "vitest";
import type {
  CatalogProviderExternalReferenceRule,
  CatalogProviderVariantRule,
} from "../provider-integration-profiles";
import {
  dropRepeatedCatalogItemReferencesAcrossVariants,
  extractCatalogProviderExternalReferences,
} from "./provider-external-reference-extractor";

describe("provider external reference extractor", () => {
  it("extracts exact Catalog Item references with configured prefixes", () => {
    const result = extractCatalogProviderExternalReferences({
      rules: [tcgplayerProductRule()],
      payload: {
        productId: 610001,
      },
    });

    expect(result.externalCatalogItemReferences).toEqual([{ providerKey: "tcgplayer", externalKey: "product:610001" }]);
    expect(result.externalProductReferences).toEqual([]);
  });

  it("reports missing values without emitting a reference", () => {
    const result = extractCatalogProviderExternalReferences({
      rules: [tcgplayerProductRule()],
      payload: {
        productName: "No provider id",
      },
    });

    expect(result.externalCatalogItemReferences).toEqual([]);
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "missing-reference-value" })]);
  });

  it("drops repeated Catalog Item references across variants for skip-reference ambiguity policy", () => {
    const filtered = dropRepeatedCatalogItemReferencesAcrossVariants(
      new Map([
        ["standard", [{ providerKey: "tcgplayer", externalKey: "product:490001" }]],
        ["reverse-holo", [{ providerKey: "tcgplayer", externalKey: "product:490001" }]],
        ["holofoil", [{ providerKey: "tcgplayer", externalKey: "product:490777" }]],
      ]),
    );

    expect(filtered.get("standard")).toEqual([]);
    expect(filtered.get("reverse-holo")).toEqual([]);
    expect(filtered.get("holofoil")).toEqual([{ providerKey: "tcgplayer", externalKey: "product:490777" }]);
  });

  it("keeps Product IDs and SKU IDs on their configured target levels", () => {
    const result = extractCatalogProviderExternalReferences({
      rules: [tcgplayerProductRule(), tcgplayerSkuRule()],
      payload: {
        productId: 610001,
        skus: [
          {
            sku: 7001001,
            selectedOptions: [{ dimensionId: "dim_condition", optionId: "opt_near_mint" }],
            reviewEvidence: { condition: "Near Mint" },
          },
        ],
      },
    });

    expect(result.externalCatalogItemReferences).toEqual([{ providerKey: "tcgplayer", externalKey: "product:610001" }]);
    expect(result.externalProductReferences).toEqual([
      {
        providerKey: "tcgplayer",
        externalKey: "sku:7001001",
        selectedOptions: [{ dimensionId: "dim_condition", optionId: "opt_near_mint" }],
        reviewEvidence: { condition: "Near Mint" },
      },
    ]);
  });

  it("leaves SKU identifiers as review evidence until selected options validate", () => {
    const result = extractCatalogProviderExternalReferences({
      rules: [tcgplayerSkuRule()],
      payload: {
        skus: [{ sku: 7001001, reviewEvidence: { condition: "Near Mint" } }],
      },
    });

    expect(result.externalProductReferences).toEqual([]);
    expect(result.reviewEvidence).toEqual([
      expect.objectContaining({
        target: "product-reference",
        providerKey: "tcgplayer",
        externalKey: "sku:7001001",
        reason: "missing-selected-options",
      }),
    ]);
  });

  it("extracts future-provider TCGplayer ID evidence without provider-specific branches", () => {
    const result = extractCatalogProviderExternalReferences({
      rules: [
        {
          providerKey: "tcgplayer",
          target: "catalog-item-reference",
          externalKeyPrefix: "product:",
          containerKeys: [],
          valueKeys: ["tcgplayer_id"],
          recordIdKeys: [],
          pricingRootKeys: [],
          pricingScope: "card",
        },
      ],
      payload: {
        id: "sv1-001",
        name: "Sprigatito",
        tcgplayer_id: "490001",
      },
    });

    expect(result.externalCatalogItemReferences).toEqual([{ providerKey: "tcgplayer", externalKey: "product:490001" }]);
  });

  it("uses variant pricing keys for TCGdex marketplace references", () => {
    const result = extractCatalogProviderExternalReferences({
      rules: [tcgdexMarketplaceRule()],
      variant: reverseHoloVariant(),
      payload: {
        pricing: {
          tcgplayer: {
            reverse: {
              productId: 490002,
            },
          },
        },
      },
    });

    expect(result.externalCatalogItemReferences).toEqual([{ providerKey: "tcgplayer", externalKey: "product:490002" }]);
  });
});

function tcgplayerProductRule(): CatalogProviderExternalReferenceRule {
  return {
    providerKey: "tcgplayer",
    target: "catalog-item-reference",
    externalKeyPrefix: "product:",
    containerKeys: [],
    valueKeys: ["productId"],
    recordIdKeys: ["productId"],
    pricingRootKeys: [],
    pricingScope: "card",
  };
}

function tcgplayerSkuRule(): CatalogProviderExternalReferenceRule {
  return {
    providerKey: "tcgplayer",
    target: "product-reference",
    externalKeyPrefix: "sku:",
    containerKeys: ["skus"],
    valueKeys: ["sku"],
    recordIdKeys: ["sku"],
    pricingRootKeys: [],
    pricingScope: "card",
  };
}

function tcgdexMarketplaceRule(): CatalogProviderExternalReferenceRule {
  return {
    providerKey: "tcgplayer",
    target: "catalog-item-reference",
    externalKeyPrefix: "product:",
    containerKeys: [],
    valueKeys: ["tcgplayer", "tcgPlayer", "productId"],
    recordIdKeys: ["productId", "id"],
    pricingRootKeys: ["pricing", "tcgplayer", "tcgPlayer"],
    pricingScope: "by-variant",
  };
}

function reverseHoloVariant(): Pick<CatalogProviderVariantRule, "variantKey" | "sourceKeys" | "pricingKeys"> {
  return {
    variantKey: "reverse-holo",
    sourceKeys: ["reverse"],
    pricingKeys: ["reverse-holofoil", "reverse"],
  };
}
