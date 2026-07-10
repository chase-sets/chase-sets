import { describe, expect, it } from "vitest";
import type { BlueprintId, CatalogItemId, CategoryId, FieldId } from "../../../ids";
import type {
  SourceObservationMagicCardPrintNormalized,
  SourceObservationMagicSealedProductNormalized,
  SourceObservationOnePieceCardPrintNormalized,
  SourceObservationOnePieceSealedProductNormalized,
  SourceObservationPokemonCardNormalized,
  SourceObservationProviderProductNormalized,
} from "../domain/domain";
import {
  scrydexOnePieceCardPrintProviderProfile,
  scrydexOnePieceSealedProductProviderProfile,
  scrydexScryfallCardProviderProfile,
  scryfallMtgCardPrintProviderProfile,
  tcgdexPokemonTcgProviderProfile,
  tcgplayerAutomationClientProviderProfile,
  tcgplayerMtgSealedProductProviderProfile,
  tcgplayerOnePieceSingleCardProviderProfile,
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

  it("uses the normalized language-prefixed source-observation key", async () => {
    const db = duplicatePreventionDb({ sourceProductCatalogItemId: "cat_source_link" });

    const result = await resolveCatalogProviderDuplicatePrevention({
      db,
      profile: tcgdexPokemonTcgProviderProfile,
      providerKey: "TCGDEX",
      externalKey: "  provider:CaseSensitive  ",
      normalized: pokemonCardObservation({ languageCode: "EN-us", externalCatalogItemReferences: [] }),
      catalog: catalogMapping(),
    });

    expect(result).toMatchObject({
      status: "matched",
      catalogItemId: "cat_source_link",
      ruleKey: "source-observation-link",
    });
    expect(db.values).toContainEqual(["tcgdex", "en-US:provider:CaseSensitive"]);
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
      normalized: magicCardPrintObservation({
        name: "Fury Sliver",
        setName: "Time Spiral",
        expansionName: "Time Spiral",
        cardNumber: "157",
        externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:14240" }],
        mergeIdentity: {
          tcg: "magic",
          productLineName: "Magic: The Gathering",
          setName: "Time Spiral",
          printedProductName: "Fury Sliver",
          collectorNumber: "157",
          languageCode: "en",
          productForm: "magic-card-print",
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

  it("reuses existing One Piece Catalog Items when Scrydex carries TCGplayer card evidence", async () => {
    const db = duplicatePreventionDb({ externalCatalogItemIds: ["cat_op_tcgplayer_card"] });

    const result = await resolveCatalogProviderDuplicatePrevention({
      db,
      profile: scrydexOnePieceCardPrintProviderProfile,
      providerKey: "scrydex",
      externalKey: "card:op01-001",
      normalized: onePieceCardPrintObservation({
        externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:551001" }],
      }),
      catalog: catalogMapping(),
    });

    expect(result).toMatchObject({
      status: "matched",
      catalogItemId: "cat_op_tcgplayer_card",
      ruleKey: "exact-external-catalog-item-reference",
      evidenceSummary: {
        evidenceText: "1 external Catalog Item reference(s)",
      },
    });
    expect(db.queries.some((query) => query.includes("FROM catalog_items AS item"))).toBe(false);
  });

  it("reuses One Piece reprints and variants only through set, card number, name, and card type evidence", async () => {
    const db = duplicatePreventionDb({ deterministicCatalogItemIds: ["cat_op_romance_dawn_parallel"] });

    const result = await resolveCatalogProviderDuplicatePrevention({
      db,
      profile: scrydexOnePieceCardPrintProviderProfile,
      providerKey: "scrydex",
      externalKey: "card:op01-001-parallel",
      normalized: onePieceCardPrintObservation({
        name: "Monkey.D.Luffy",
        cardNumber: "OP01-001",
        setName: "Romance Dawn",
        expansionName: "Romance Dawn",
        cardType: "parallel",
        externalCatalogItemReferences: [],
      }),
      catalog: catalogMapping(),
    });

    expect(result).toMatchObject({
      status: "matched",
      catalogItemId: "cat_op_romance_dawn_parallel",
      ruleKey: "one-piece-card-print-deterministic-fields",
      evidenceSummary: {
        matchKind: "deterministic-one-piece-catalog-item-field-match",
        evidenceText: "deterministic One Piece catalog item identity",
      },
    });
    expect(db.values.flat().join("\n")).toContain('"fieldId":"field_card_variant","value":"parallel"');
    expect(db.values.flat().join("\n")).toContain('"referenceId":"ref_expansion_swsh1"');
  });

  it("reuses One Piece sealed packaging variants through product name, set, and sealed form", async () => {
    const result = await resolveCatalogProviderDuplicatePrevention({
      db: duplicatePreventionDb({ deterministicCatalogItemIds: ["cat_op_booster_box"] }),
      profile: scrydexOnePieceSealedProductProviderProfile,
      providerKey: "scrydex",
      externalKey: "sealed:op01-box",
      normalized: onePieceSealedProductObservation({
        name: "Romance Dawn Booster Box",
        sealedProductForm: "booster-box",
        externalCatalogItemReferences: [],
      }),
      catalog: catalogMapping(),
    });

    expect(result).toMatchObject({
      status: "matched",
      catalogItemId: "cat_op_booster_box",
      ruleKey: "one-piece-sealed-product-deterministic-fields",
      evidenceSummary: {
        matchKind: "deterministic-one-piece-catalog-item-field-match",
      },
    });
  });

  it("reuses existing One Piece sealed Catalog Items when Scrydex carries TCGplayer product evidence", async () => {
    const db = duplicatePreventionDb({ externalCatalogItemIds: ["cat_op_tcgplayer_sealed"] });

    const result = await resolveCatalogProviderDuplicatePrevention({
      db,
      profile: scrydexOnePieceSealedProductProviderProfile,
      providerKey: "scrydex",
      externalKey: "sealed:op01-pack",
      normalized: onePieceSealedProductObservation({
        externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:551777" }],
      }),
      catalog: catalogMapping(),
    });

    expect(result).toMatchObject({
      status: "matched",
      catalogItemId: "cat_op_tcgplayer_sealed",
      ruleKey: "exact-external-catalog-item-reference",
    });
    expect(db.queries.some((query) => query.includes("FROM catalog_items AS item"))).toBe(false);
  });

  it("keeps marketplace-only One Piece products review-only instead of creating a duplicate Catalog Item", async () => {
    const result = await resolveCatalogProviderDuplicatePrevention({
      db: duplicatePreventionDb({}),
      profile: tcgplayerOnePieceSingleCardProviderProfile,
      providerKey: "tcgplayer",
      externalKey: "product:551099",
      normalized: providerProductObservation({
        productLineName: "One Piece Card Game",
        productCategoryName: "Cards",
        externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:551099" }],
        mergeIdentity: {
          tcg: "one-piece",
          productLineName: "One Piece Card Game",
          setName: "Romance Dawn",
          printedProductName: "Marketplace Promo",
          collectorNumber: "P-001",
          languageCode: "en",
          productForm: "single-card",
          barcode: null,
        },
      }),
      catalog: catalogMapping(),
    });

    expect(result).toMatchObject({
      status: "review-only",
      ruleKey: "future-provider-bridge-review",
      candidateCatalogItemIds: [],
      evidenceSummary: {
        matchKind: "future-provider-bridge-match",
        evidenceText: "1 bridge provider reference(s)",
      },
    });
  });

  it("blocks ambiguous One Piece provider disagreement from automatic promotion", async () => {
    const result = await resolveCatalogProviderDuplicatePrevention({
      db: duplicatePreventionDb({ deterministicCatalogItemIds: ["cat_op_a", "cat_op_b"] }),
      profile: scrydexOnePieceCardPrintProviderProfile,
      providerKey: "scrydex",
      externalKey: "card:op01-001",
      normalized: onePieceCardPrintObservation({ externalCatalogItemReferences: [] }),
      catalog: catalogMapping(),
    });

    expect(result).toEqual({
      status: "blocked",
      ruleKey: "one-piece-card-print-deterministic-fields",
      diagnosticText:
        "Multiple Catalog Items match this Source Observation's deterministic One Piece identity evidence.",
      candidateCatalogItemIds: ["cat_op_a", "cat_op_b"],
      evidenceSummary: {
        ruleKey: "one-piece-card-print-deterministic-fields",
        matchKind: "deterministic-one-piece-catalog-item-field-match",
        evidenceText: "deterministic One Piece catalog item identity",
        candidateCatalogItemIds: ["cat_op_a", "cat_op_b"],
      },
    });
  });

  it("reuses Magic card prints through deterministic set, collector number, language, and name evidence", async () => {
    const result = await resolveCatalogProviderDuplicatePrevention({
      db: duplicatePreventionDb({ deterministicCatalogItemIds: ["cat_magic_print"] }),
      profile: scryfallMtgCardPrintProviderProfile,
      providerKey: "scryfall",
      externalKey: "card:0000579f-7b35-4ed3-b44c-db2a538066fe",
      normalized: magicCardPrintObservation({ externalCatalogItemReferences: [] }),
      catalog: catalogMapping(),
    });

    expect(result).toMatchObject({
      status: "matched",
      catalogItemId: "cat_magic_print",
      ruleKey: "magic-card-print-deterministic-fields",
      evidenceSummary: {
        matchKind: "deterministic-magic-catalog-item-field-match",
        evidenceText: "deterministic Magic catalog item identity",
      },
    });
  });

  it("blocks ambiguous Magic deterministic card-print candidates", async () => {
    const result = await resolveCatalogProviderDuplicatePrevention({
      db: duplicatePreventionDb({ deterministicCatalogItemIds: ["cat_magic_a", "cat_magic_b"] }),
      profile: scryfallMtgCardPrintProviderProfile,
      providerKey: "scryfall",
      externalKey: "card:0000579f-7b35-4ed3-b44c-db2a538066fe",
      normalized: magicCardPrintObservation({ externalCatalogItemReferences: [] }),
      catalog: catalogMapping(),
    });

    expect(result).toEqual({
      status: "blocked",
      ruleKey: "magic-card-print-deterministic-fields",
      diagnosticText: "Multiple Catalog Items match this Source Observation's deterministic Magic identity evidence.",
      candidateCatalogItemIds: ["cat_magic_a", "cat_magic_b"],
      evidenceSummary: {
        ruleKey: "magic-card-print-deterministic-fields",
        matchKind: "deterministic-magic-catalog-item-field-match",
        evidenceText: "deterministic Magic catalog item identity",
        candidateCatalogItemIds: ["cat_magic_a", "cat_magic_b"],
      },
    });
  });

  it("skips Magic deterministic matching when a required mapped field is unavailable", async () => {
    const db = duplicatePreventionDb({ deterministicCatalogItemIds: ["cat_magic_print"] });
    const mapping = catalogMapping();

    const result = await resolveCatalogProviderDuplicatePrevention({
      db,
      profile: scryfallMtgCardPrintProviderProfile,
      providerKey: "scryfall",
      externalKey: "card:0000579f-7b35-4ed3-b44c-db2a538066fe",
      normalized: magicCardPrintObservation({ externalCatalogItemReferences: [] }),
      catalog: { ...mapping, fieldIds: { ...mapping.fieldIds, cardNumber: undefined as unknown as FieldId } },
    });

    expect(result.status).toBe("none");
    expect(db.queries.some((query) => query.includes("FROM catalog_items AS item"))).toBe(false);
  });

  it("uses TCGplayer SKU references before Magic sealed provider set identity", async () => {
    const result = await resolveCatalogProviderDuplicatePrevention({
      db: duplicatePreventionDb({
        externalProductCatalogItemIds: ["cat_magic_sku"],
        deterministicCatalogItemIds: ["cat_magic_set_identity"],
      }),
      profile: tcgplayerMtgSealedProductProviderProfile,
      providerKey: "tcgplayer",
      externalKey: "96601",
      normalized: magicSealedProductObservation({
        externalProductReferences: [{ providerKey: "tcgplayer", externalKey: "sku:50096601" }],
      }),
      catalog: catalogMapping(),
    });

    expect(result).toMatchObject({
      status: "matched",
      catalogItemId: "cat_magic_sku",
      ruleKey: "exact-external-product-reference",
      evidenceSummary: {
        evidenceText: "1 external Product reference(s)",
      },
    });
  });

  it("reuses Magic sealed products through provider set identity when SKU evidence is absent", async () => {
    const result = await resolveCatalogProviderDuplicatePrevention({
      db: duplicatePreventionDb({ deterministicCatalogItemIds: ["cat_magic_booster_pack"] }),
      profile: tcgplayerMtgSealedProductProviderProfile,
      providerKey: "tcgplayer",
      externalKey: "96601",
      normalized: magicSealedProductObservation({ externalProductReferences: [] }),
      catalog: catalogMapping(),
    });

    expect(result).toMatchObject({
      status: "matched",
      catalogItemId: "cat_magic_booster_pack",
      ruleKey: "sealed-product-deterministic-fields",
      evidenceSummary: {
        evidenceText: "Magic sealed product provider set identity",
      },
    });
  });
});

function duplicatePreventionDb(input: {
  externalCatalogItemIds?: readonly string[];
  sourceProductCatalogItemId?: string | null;
  externalProductCatalogItemIds?: readonly string[];
  deterministicCatalogItemIds?: readonly string[];
  partialCatalogItemId?: string | null;
}): CatalogProviderDuplicatePreventionDb & { queries: string[]; values: readonly unknown[][] } {
  const queries: string[] = [];
  const values: unknown[][] = [];
  return {
    queries,
    values,
    query: async <T>(sql: string, queryValues: readonly unknown[] = []) => {
      queries.push(sql);
      values.push([...queryValues]);

      if (sql.includes("FROM catalog_external_catalog_item_references")) {
        return rows(input.externalCatalogItemIds ?? []);
      }

      if (sql.includes("FROM catalog_external_product_references")) {
        return sql.includes("WHERE reference.provider_key = $1")
          ? rows(input.sourceProductCatalogItemId ? [input.sourceProductCatalogItemId] : [])
          : rows(input.externalProductCatalogItemIds ?? []);
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

function onePieceCardPrintObservation(
  overrides: Partial<SourceObservationOnePieceCardPrintNormalized> = {},
): SourceObservationOnePieceCardPrintNormalized {
  return {
    kind: "one-piece-card-print",
    tcg: "one-piece",
    languageCode: "en",
    name: "Monkey.D.Luffy",
    cardNumber: "OP01-001",
    setId: "op-01",
    setCode: "OP-01",
    setName: "Romance Dawn",
    expansionName: "Romance Dawn",
    rarity: "Leader",
    cardType: "standard",
    releaseDate: "2022-12-02",
    releaseYear: 2022,
    productLineName: "One Piece Card Game",
    imageUrls: [],
    mergeIdentity: {
      tcg: "one-piece",
      productLineName: "One Piece Card Game",
      setName: "Romance Dawn",
      printedProductName: "Monkey.D.Luffy",
      collectorNumber: "OP01-001",
      languageCode: "en",
      productForm: "one-piece-card-print",
    },
    externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:551001" }],
    externalProductReferences: [],
    ...overrides,
  };
}

function onePieceSealedProductObservation(
  overrides: Partial<SourceObservationOnePieceSealedProductNormalized> = {},
): SourceObservationOnePieceSealedProductNormalized {
  return {
    kind: "one-piece-sealed-product",
    tcg: "one-piece",
    languageCode: "en",
    name: "Romance Dawn Booster Pack",
    cardNumber: null,
    setId: "op-01",
    setCode: "OP-01",
    setName: "Romance Dawn",
    expansionName: "Romance Dawn",
    sealedProductForm: "booster-pack",
    releaseDate: "2022-12-02",
    releaseYear: 2022,
    productLineName: "One Piece Card Game",
    barcode: null,
    imageUrls: [],
    mergeIdentity: {
      tcg: "one-piece",
      productLineName: "One Piece Card Game",
      setName: "Romance Dawn",
      printedProductName: "Romance Dawn Booster Pack",
      collectorNumber: null,
      languageCode: "en",
      productForm: "one-piece-sealed-product",
    },
    externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:551777" }],
    externalProductReferences: [],
    ...overrides,
  };
}

function magicSealedProductObservation(
  overrides: Partial<SourceObservationMagicSealedProductNormalized> = {},
): SourceObservationMagicSealedProductNormalized {
  return {
    kind: "magic-sealed-product",
    tcg: "magic",
    languageCode: "en",
    name: "Time Spiral Booster Pack",
    cardNumber: null,
    setCode: "tsp",
    setName: "Time Spiral",
    expansionName: "Time Spiral",
    setId: "1001",
    sealedProductForm: "booster-pack",
    packCount: 1,
    releaseDate: "2006-10-06",
    releaseYear: 2006,
    productLineName: "Magic: The Gathering",
    barcode: "0653569123456",
    imageUrls: [],
    mergeIdentity: {
      tcg: "magic",
      productLineName: "Magic: The Gathering",
      setName: "Time Spiral",
      printedProductName: "Time Spiral Booster Pack",
      collectorNumber: "PACK",
      languageCode: "en",
      productForm: "sealed",
      barcode: "0653569123456",
    },
    externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:96601" }],
    externalProductReferences: [],
    ...overrides,
  };
}

function magicCardPrintObservation(
  overrides: Partial<SourceObservationMagicCardPrintNormalized> = {},
): SourceObservationMagicCardPrintNormalized {
  return {
    kind: "magic-card-print",
    tcg: "magic",
    languageCode: "en",
    name: "Fury Sliver",
    cardNumber: "157",
    setCode: "tsp",
    setName: "Time Spiral",
    expansionName: "Time Spiral",
    setId: null,
    oracleId: "44623693-51d6-49ad-8cd7-140505caf02f",
    rarity: "Rare",
    illustrator: null,
    releaseDate: "2006-10-06",
    releaseYear: 2006,
    cardVariantKey: "standard",
    cardVariantLabel: "Standard",
    imageUrls: [],
    mergeIdentity: {
      tcg: "magic",
      productLineName: "Magic: The Gathering",
      setName: "Time Spiral",
      printedProductName: "Fury Sliver",
      collectorNumber: "157",
      languageCode: "en",
      productForm: "magic-card-print",
    },
    externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:14240" }],
    ...overrides,
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
      set: "field_set" as FieldId,
      expansion: "field_expansion" as FieldId,
      rarity: "field_rarity" as FieldId,
      cardVariant: "field_card_variant" as FieldId,
      cardIllustrator: "field_illustrator" as FieldId,
      releaseYear: "field_release_year" as FieldId,
      packCount: "field_pack_count" as FieldId,
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
