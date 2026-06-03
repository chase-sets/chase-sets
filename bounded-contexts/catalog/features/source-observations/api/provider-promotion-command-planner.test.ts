import { describe, expect, it } from "vitest";
import type { CatalogItemId, BlueprintId, CategoryId, FieldId, ReferenceRecordId } from "../../../ids";
import type { ProductAssetSet } from "../../../support/runtime-support/product-assets";
import type {
  SourceObservationPokemonCardNormalized,
  SourceObservationProviderProductNormalized,
} from "../domain/domain";
import {
  tcgdexPokemonTcgProviderProfile,
  tcgplayerAutomationClientProviderProfile,
} from "./provider-integration-profiles";
import {
  planCatalogProviderPromotionCommands,
  type CatalogProviderPromotionResolvedCatalogMapping,
} from "./provider-promotion-command-planner";

describe("planCatalogProviderPromotionCommands", () => {
  it("plans the TCGdex Pokemon card create command sequence from profile catalog mapping", () => {
    const result = planCatalogProviderPromotionCommands({
      profile: tcgdexPokemonTcgProviderProfile,
      providerKey: "tcgdex",
      externalKey: "swsh1-001",
      mode: "create",
      catalogItemId: "cat_001" as CatalogItemId,
      normalized: pokemonCardObservation(),
      catalog: catalogMapping(),
      expansionReferenceId: "ref_expansion_sword_shield" as ReferenceRecordId,
      metadata: { title: "Pikachu", subtitle: "" },
      productAssetSet: productAssetSet(),
      preflight: { status: "ready" },
    });

    expect(result.status).toBe("planned");
    expect(result.plan?.requiresReview).toBe(true);
    expect(result.plan?.review).toEqual({
      normalizedKind: "pokemon-card",
      commandCount: 15,
      catalogItemReferencesLinked: 1,
      sourceProductReferencesLinked: 1,
    });
    expect(result.plan?.commands.map((command) => command.type)).toEqual([
      "CreateCatalogItem",
      "AssignBlueprintToCatalogItem",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "AssignCatalogItemToCategory",
      "SetCatalogItemTags",
      "SetCatalogItemImageUrls",
      "SetCatalogItemProductAssetSets",
      "LinkExternalProductReference",
      "LinkExternalCatalogItemReference",
    ]);
    expect(result.plan?.commands[0]).toMatchObject({
      type: "CreateCatalogItem",
      itemId: "cat_001",
      languageCode: "en",
      title: { defaultLocale: "en", values: { en: "Pikachu" } },
      description: { defaultLocale: "en", values: { en: "Variant artwork uses provider image reference." } },
    });
    expect(result.plan?.commands[10]).toEqual({
      type: "SetCatalogItemTags",
      tags: [
        "pokemon",
        "tcgdex",
        "expansion:swsh1",
        "category:pokemon",
        "variant:holofoil",
        "image-note:variant-reference",
      ],
    });
    expect(result.plan?.commands[11]).toMatchObject({
      type: "SetCatalogItemImageUrls",
      imageUrls: ["https://assets.example/detail.webp"],
    });
    expect(result.plan?.commands[13]).toEqual({
      type: "LinkExternalProductReference",
      providerKey: "tcgdex",
      externalKey: "en:swsh1-001",
    });
    expect(result.plan?.commands[14]).toEqual({
      type: "LinkExternalCatalogItemReference",
      providerKey: "tcgplayer",
      externalKey: "product:12345",
    });
  });

  it("plans refresh without blueprint or category assignment and clears missing asset sets", () => {
    const result = planCatalogProviderPromotionCommands({
      profile: tcgdexPokemonTcgProviderProfile,
      providerKey: "tcgdex",
      externalKey: "swsh1-001",
      mode: "refresh",
      catalogItemId: "cat_001" as CatalogItemId,
      normalized: pokemonCardObservation({ imageBaseUrl: null, imageDisclaimer: null }),
      catalog: catalogMapping(),
      expansionReferenceId: "ref_expansion_sword_shield" as ReferenceRecordId,
      metadata: { title: "Pikachu", subtitle: "" },
      productAssetSet: null,
    });

    expect(result.status).toBe("planned");
    expect(result.plan?.commands.map((command) => command.type)).toEqual([
      "ReviseCatalogItemMetadata",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemTags",
      "SetCatalogItemImageUrls",
      "SetCatalogItemProductAssetSets",
      "LinkExternalProductReference",
      "LinkExternalCatalogItemReference",
    ]);
    expect(result.plan?.commands[10]).toEqual({
      type: "SetCatalogItemProductAssetSets",
      productAssetSets: [],
    });
  });

  it("omits optional Pokemon card field commands when normalized values are absent", () => {
    const result = planCatalogProviderPromotionCommands({
      profile: tcgdexPokemonTcgProviderProfile,
      providerKey: "tcgdex",
      externalKey: "swsh1-001",
      mode: "create",
      catalogItemId: "cat_001" as CatalogItemId,
      normalized: pokemonCardObservation({ rarity: null, illustrator: null, releaseYear: null }),
      catalog: catalogMapping(),
      expansionReferenceId: "ref_expansion_sword_shield" as ReferenceRecordId,
      metadata: { title: "Pikachu", subtitle: "" },
      productAssetSet: null,
    });

    expect(result.status).toBe("planned");
    expect(
      result.plan?.commands.filter(
        (command) =>
          command.type === "SetCatalogItemFieldValue" &&
          ["field_rarity", "field_illustrator", "field_release_year"].includes(command.fieldId),
      ),
    ).toEqual([]);
  });

  it("blocks provider-product observations until the profile declares a valid promotion plan", () => {
    const result = planCatalogProviderPromotionCommands({
      profile: tcgplayerAutomationClientProviderProfile,
      providerKey: "tcgplayer",
      externalKey: "product:12345",
      mode: "create",
      catalogItemId: "cat_001" as CatalogItemId,
      normalized: providerProductObservation(),
      catalog: catalogMapping(),
      expansionReferenceId: "ref_expansion_sword_shield" as ReferenceRecordId,
      metadata: { title: "Pikachu", subtitle: "" },
      productAssetSet: null,
    });

    expect(result).toMatchObject({
      status: "blocked",
      plan: null,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "missing-promotion-capability" }),
        expect.objectContaining({ code: "unsupported-observation-kind" }),
      ]),
    });
  });

  it("blocks ambiguous duplicate candidates before returning executable commands", () => {
    const result = planCatalogProviderPromotionCommands({
      profile: tcgdexPokemonTcgProviderProfile,
      providerKey: "tcgdex",
      externalKey: "swsh1-001",
      mode: "refresh",
      catalogItemId: "cat_001" as CatalogItemId,
      normalized: pokemonCardObservation(),
      catalog: catalogMapping(),
      expansionReferenceId: "ref_expansion_sword_shield" as ReferenceRecordId,
      metadata: { title: "Pikachu", subtitle: "" },
      productAssetSet: null,
      preflight: {
        status: "blocked",
        code: "ambiguous-duplicate-candidates",
        diagnosticText: "Multiple Catalog Items match this Source Observation's duplicate evidence.",
        candidateCatalogItemIds: ["cat_001" as CatalogItemId, "cat_002" as CatalogItemId],
      },
    });

    expect(result).toEqual({
      status: "blocked",
      plan: null,
      diagnostics: [
        {
          code: "ambiguous-duplicate-candidates",
          path: "preflight",
          diagnosticText: "Multiple Catalog Items match this Source Observation's duplicate evidence.",
        },
      ],
    });
  });
});

function catalogMapping(): CatalogProviderPromotionResolvedCatalogMapping {
  return {
    blueprintId: "bp_pokemon_card" as BlueprintId,
    categoryId: "cat_singles" as CategoryId,
    fieldIds: {
      cardNumber: "field_card_number" as FieldId,
      cardName: "field_card_name" as FieldId,
      expansion: "field_expansion" as FieldId,
      rarity: "field_rarity" as FieldId,
      cardVariant: "field_card_variant" as FieldId,
      cardIllustrator: "field_illustrator" as FieldId,
      releaseYear: "field_release_year" as FieldId,
    },
  };
}

function pokemonCardObservation(
  overrides: Partial<SourceObservationPokemonCardNormalized> = {},
): SourceObservationPokemonCardNormalized {
  return {
    kind: "pokemon-card",
    tcg: "pokemon",
    languageCode: "en",
    name: "Pikachu",
    cardNumber: "001",
    setId: "swsh1",
    setName: "Sword & Shield",
    expansionId: "swsh1",
    expansionName: "Sword & Shield",
    expansionAbbreviation: "SSH",
    expansionCardCount: 202,
    expansionParallelSetCardCount: 14,
    seriesId: "swsh",
    seriesName: "Sword & Shield",
    rarity: "Rare",
    illustrator: "Atsuko Nishida",
    releaseDate: "2020-02-07",
    releaseYear: 2020,
    category: "Pokemon",
    imageBaseUrl: "https://images.example/swsh1-001",
    imageUrls: ["https://images.example/swsh1-001/high.webp"],
    productAssetSet: null,
    parallelSet: false,
    cardVariantKey: "holofoil",
    cardVariantLabel: "Standard Set Foil",
    cardVariantSourceKey: "holo",
    cardVariantIsPrimaryImage: true,
    imageDisclaimer: "Variant artwork uses provider image reference.",
    variants: {},
    externalCatalogItemReferences: [
      { providerKey: "TCGPLAYER", externalKey: "PRODUCT:12345" },
      { providerKey: "tcgplayer", externalKey: "product:12345" },
    ],
    ...overrides,
  };
}

function providerProductObservation(): SourceObservationProviderProductNormalized {
  return {
    kind: "provider-product",
    languageCode: "en",
    name: "Pikachu",
    setName: "Sword & Shield",
    expansionName: "Sword & Shield",
    cardNumber: "001",
    imageUrls: [],
    providerProductId: "12345",
    providerProductName: "Pikachu",
    productLineName: "Pokemon",
    productCategoryName: "Cards",
    skuReferences: [],
  };
}

function productAssetSet(): ProductAssetSet {
  return {
    kind: "product-image",
    sourceHash: "asset-hash",
    source: {
      role: "source",
      width: 1000,
      height: 1400,
      density: null,
      mediaType: "image/webp",
      storageKey: "catalog/items/cat_001/product-image/source.webp",
      publicUrl: "https://assets.example/source.webp",
      byteSize: 1024,
      generatedAt: "2026-06-03T00:00:00.000Z",
    },
    variants: [
      {
        role: "catalog-detail",
        width: 480,
        height: 672,
        density: 1,
        mediaType: "image/webp",
        storageKey: "catalog/items/cat_001/product-image/detail.webp",
        publicUrl: "https://assets.example/detail.webp",
        byteSize: 512,
        generatedAt: "2026-06-03T00:00:00.000Z",
      },
    ],
  };
}
