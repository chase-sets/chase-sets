import { describe, expect, it } from "vitest";
import type { BlueprintId, CatalogItemId, CategoryId, FieldId } from "../../../ids";
import type {
  SourceObservationPokemonCardNormalized,
  SourceObservationProviderProductNormalized,
} from "../domain/domain";
import {
  scrydexScryfallCardProviderProfile,
  tcgdexPokemonTcgProviderProfile,
  tcgplayerAutomationClientProviderProfile,
  type CatalogProviderIntegrationProfile,
} from "./provider-integration-profiles";
import {
  resolveCatalogProviderDuplicatePrevention,
  type CatalogProviderDuplicatePreventionDb,
} from "./provider-duplicate-prevention-resolver";
import type { CatalogProviderPromotionResolvedCatalogMapping } from "./provider-promotion-command-planner";

describe("resolveCatalogProviderDuplicatePrevention", () => {
  it("uses exact external Catalog Item references before deterministic field evidence", async () => {
    const db = duplicatePreventionDb({
      externalCatalogItemIds: ["cat_external"],
      deterministicCatalogItemIds: ["cat_deterministic"],
    });

    const result = await resolveCatalogProviderDuplicatePrevention({
      db,
      profile: tcgdexPokemonTcgProviderProfile,
      providerKey: "tcgdex",
      externalKey: "swsh1-001",
      normalized: pokemonCardObservation({
        externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:610001" }],
      }),
      catalog: catalogMapping(),
    });

    expect(result).toMatchObject({
      status: "matched",
      catalogItemId: "cat_external",
      ruleKey: "exact-external-catalog-item-reference",
    });
    expect(db.queries.some((query) => query.includes("FROM catalog_items AS item"))).toBe(false);
  });

  it("blocks automatic promotion when reusable external references are ambiguous", async () => {
    const result = await resolveCatalogProviderDuplicatePrevention({
      db: duplicatePreventionDb({ externalCatalogItemIds: ["cat_a", "cat_b"] }),
      profile: tcgdexPokemonTcgProviderProfile,
      providerKey: "tcgdex",
      externalKey: "swsh1-001",
      normalized: pokemonCardObservation({
        externalCatalogItemReferences: [
          { providerKey: "tcgplayer", externalKey: "product:610001" },
          { providerKey: "cardmarket", externalKey: "product:880001" },
        ],
      }),
      catalog: catalogMapping(),
    });

    expect(result).toEqual({
      status: "blocked",
      ruleKey: "exact-external-catalog-item-reference",
      diagnosticText: "Multiple Catalog Items match this Source Observation's external catalog item references.",
      candidateCatalogItemIds: ["cat_a", "cat_b"],
      evidenceSummary: {
        ruleKey: "exact-external-catalog-item-reference",
        matchKind: "exact-external-catalog-item-reference",
        evidenceText: "2 external Catalog Item reference(s)",
        candidateCatalogItemIds: ["cat_a", "cat_b"],
      },
    });
  });

  it("matches deterministic Pokemon card evidence when external references are absent", async () => {
    const result = await resolveCatalogProviderDuplicatePrevention({
      db: duplicatePreventionDb({ deterministicCatalogItemIds: ["cat_deterministic"] }),
      profile: tcgdexPokemonTcgProviderProfile,
      providerKey: "tcgdex",
      externalKey: "swsh1-001",
      normalized: pokemonCardObservation(),
      catalog: catalogMapping(),
    });

    expect(result).toMatchObject({
      status: "matched",
      catalogItemId: "cat_deterministic",
      ruleKey: "pokemon-card-deterministic-fields",
      evidenceSummary: {
        matchKind: "deterministic-pokemon-card-field-match",
      },
    });
  });

  it("does not apply single-card deterministic identity to sealed provider products", async () => {
    const db = duplicatePreventionDb({ deterministicCatalogItemIds: ["cat_single_card"] });

    const result = await resolveCatalogProviderDuplicatePrevention({
      db,
      profile: tcgdexPokemonTcgProviderProfile,
      providerKey: "tcgplayer",
      externalKey: "product:sealed",
      normalized: providerProductObservation(),
      catalog: catalogMapping(),
    });

    expect(result).toEqual({
      status: "none",
      evidenceSummaries: [],
    });
    expect(db.queries.some((query) => query.includes("FROM catalog_items AS item"))).toBe(false);
  });

  it("returns review-only candidates when profile ambiguity policy is review-only", async () => {
    const result = await resolveCatalogProviderDuplicatePrevention({
      db: duplicatePreventionDb({ externalCatalogItemIds: ["cat_a", "cat_b"] }),
      profile: {
        ...tcgdexPokemonTcgProviderProfile,
        duplicatePreventionMapping: {
          ...tcgdexPokemonTcgProviderProfile.duplicatePreventionMapping,
          ambiguousCandidatePolicy: "review-only",
        },
      } satisfies CatalogProviderIntegrationProfile,
      providerKey: "tcgdex",
      externalKey: "swsh1-001",
      normalized: pokemonCardObservation({
        externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:610001" }],
      }),
      catalog: catalogMapping(),
    });

    expect(result).toMatchObject({
      status: "review-only",
      ruleKey: "exact-external-catalog-item-reference",
      candidateCatalogItemIds: ["cat_a", "cat_b"],
    });
  });

  it("surfaces TCGplayer barcode identity as review-only evidence", async () => {
    const result = await resolveCatalogProviderDuplicatePrevention({
      db: duplicatePreventionDb({}),
      profile: tcgplayerAutomationClientProviderProfile,
      providerKey: "tcgplayer",
      externalKey: "product:610777",
      normalized: providerProductObservation({
        barcode: "0084123456789",
        mergeIdentity: {
          tcg: "pokemon",
          productLineName: "Pokemon",
          setName: "Sword & Shield",
          printedProductName: "Pokemon Booster Pack",
          collectorNumber: null,
          languageCode: "en",
          productForm: "single",
          barcode: "0084123456789",
        },
      }),
      catalog: catalogMapping(),
    });

    expect(result).toMatchObject({
      status: "review-only",
      ruleKey: "barcode-gtin-review",
      evidenceSummary: {
        matchKind: "barcode-gtin-match",
        evidenceText: "barcode/GTIN evidence 0084123456789",
      },
    });
  });

  it("reuses existing Catalog Items for Scrydex observations through TCGplayer ID evidence", async () => {
    const db = duplicatePreventionDb({ externalCatalogItemIds: ["cat_tcgplayer_bridge"] });

    const result = await resolveCatalogProviderDuplicatePrevention({
      db,
      profile: scrydexScryfallCardProviderProfile,
      providerKey: "scrydex",
      externalKey: "scryfall:0000579f-7b35-4ed3-b44c-db2a538066fe",
      normalized: providerProductObservation({
        name: "Fury Sliver",
        setName: "Time Spiral",
        expansionName: "Time Spiral",
        cardNumber: "157",
        providerProductId: "0000579f-7b35-4ed3-b44c-db2a538066fe",
        providerProductName: "Fury Sliver",
        productLineName: "Magic: The Gathering",
        productCategoryName: "Cards",
        externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:14240" }],
        mergeIdentity: {
          tcg: "magic",
          productLineName: "Magic: The Gathering",
          setName: "Time Spiral",
          printedProductName: "Fury Sliver",
          collectorNumber: "157",
          languageCode: "en",
          productForm: "single",
        },
      }),
      catalog: catalogMapping(),
    });

    expect(result).toMatchObject({
      status: "matched",
      catalogItemId: "cat_tcgplayer_bridge",
      ruleKey: "exact-external-catalog-item-reference",
      evidenceSummary: {
        evidenceText: "1 external Catalog Item reference(s)",
      },
    });
    expect(db.queries.some((query) => query.includes("FROM catalog_items AS item"))).toBe(false);
  });
});

function duplicatePreventionDb(input: {
  externalCatalogItemIds?: readonly string[];
  sourceProductCatalogItemId?: string | null;
  deterministicCatalogItemIds?: readonly string[];
  partialCatalogItemId?: string | null;
}): CatalogProviderDuplicatePreventionDb & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    query: async <T>(sql: string) => {
      queries.push(sql);

      if (sql.includes("FROM catalog_external_catalog_item_references")) {
        return rows(input.externalCatalogItemIds ?? []);
      }

      if (sql.includes("FROM catalog_external_product_references")) {
        return rows(input.sourceProductCatalogItemId ? [input.sourceProductCatalogItemId] : []);
      }

      if (sql.includes("FROM catalog_reference_records")) {
        return {
          rowCount: 1,
          rows: [{ reference_record_id: "ref_expansion_swsh1" }] as T[],
        };
      }

      if (sql.includes("FROM catalog_items AS item") && sql.includes("item.status NOT IN")) {
        return rows(input.deterministicCatalogItemIds ?? []);
      }

      if (sql.includes("FROM catalog_items AS item")) {
        return rows(input.partialCatalogItemId ? [input.partialCatalogItemId] : []);
      }

      return {
        rowCount: 0,
        rows: [] as T[],
      };
    },
  };
}

function rows<T>(catalogItemIds: readonly string[]) {
  return {
    rowCount: catalogItemIds.length,
    rows: catalogItemIds.map((catalogItemId) => ({ catalog_item_id: catalogItemId })) as T[],
  };
}

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
    imageBaseUrl: null,
    imageUrls: [],
    productAssetSet: null,
    parallelSet: false,
    cardVariantKey: "holofoil",
    cardVariantLabel: "Standard Set Foil",
    cardVariantSourceKey: "holo",
    cardVariantIsPrimaryImage: true,
    imageDisclaimer: null,
    variants: {},
    ...overrides,
  };
}

function providerProductObservation(
  overrides: Partial<SourceObservationProviderProductNormalized> = {},
): SourceObservationProviderProductNormalized {
  return {
    kind: "provider-product",
    languageCode: "en",
    name: "Pokemon Sealed Box",
    setName: "Sword & Shield",
    expansionName: "Sword & Shield",
    cardNumber: null,
    imageUrls: [],
    providerProductId: "610777",
    providerProductName: "Pokemon Sealed Box",
    productLineName: "Pokemon",
    productCategoryName: "Sealed Products",
    skuReferences: [],
    mergeIdentity: {
      tcg: "pokemon",
      productLineName: "Pokemon",
      setName: "Sword & Shield",
      printedProductName: "Pokemon Sealed Box",
      collectorNumber: null,
      languageCode: "en",
      productForm: "sealed",
      barcode: null,
    },
    ...overrides,
  };
}
