import { describe, expect, it } from "vitest";
import type { CatalogItemId, BlueprintId, CategoryId, FieldId, ReferenceRecordId } from "../../../ids";
import type { ProductAssetSet } from "../../../support/runtime-support/product-assets";
import type {
  SourceObservationMagicCardPrintNormalized,
  SourceObservationMagicSealedProductNormalized,
  SourceObservationMagicSetReferenceNormalized,
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
  planCatalogProviderPromotionCommands,
  type CatalogProviderPromotionResolvedCatalogMapping,
} from "./provider-promotion-command-planner";

describe("planCatalogProviderPromotionCommands", () => {
  it("plans the TCGdex Pokemon card create command sequence from profile catalog mapping", () => {
    const result = planCatalogProviderPromotionCommands({
      profile: tcgdexPokemonTcgProviderProfile,
      ...profileIdentity(),
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

  it("promotes approved image evidence through Catalog-owned asset URLs without leaking provider payload facts", () => {
    const result = planCatalogProviderPromotionCommands({
      profile: tcgdexPokemonTcgProviderProfile,
      ...profileIdentity(),
      providerKey: "tcgdex",
      externalKey: "swsh1-001",
      mode: "create",
      catalogItemId: "cat_001" as CatalogItemId,
      normalized: pokemonCardObservation({
        imageUrls: ["https://assets.tcgdex.net/en/swsh/swsh1/001/high.webp"],
        variants: {
          excludedEvidence: {
            price: "redacted fixture boundary",
            inventory: "redacted fixture boundary",
          },
        },
      }),
      catalog: catalogMapping(),
      expansionReferenceId: "ref_expansion_sword_shield" as ReferenceRecordId,
      metadata: { title: "Pikachu", subtitle: "" },
      productAssetSet: productAssetSet(),
      preflight: { status: "ready" },
    });

    expect(result.status).toBe("planned");
    expect(result.plan?.commands).toEqual(
      expect.arrayContaining([
        {
          type: "SetCatalogItemImageUrls",
          imageUrls: ["https://assets.example/detail.webp"],
        },
        {
          type: "SetCatalogItemProductAssetSets",
          productAssetSets: [
            expect.objectContaining({ sourcePolicy: expect.objectContaining({ sourceProviderKey: "tcgdex" }) }),
          ],
        },
      ]),
    );
    expect(JSON.stringify(result.plan?.commands)).not.toContain(
      "https://assets.tcgdex.net/en/swsh/swsh1/001/high.webp",
    );
    expect(JSON.stringify(result.plan?.commands)).not.toContain("redacted fixture boundary");
  });

  it("plans refresh without blueprint or category assignment and clears missing asset sets", () => {
    const result = planCatalogProviderPromotionCommands({
      profile: tcgdexPokemonTcgProviderProfile,
      ...profileIdentity(),
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
      ...profileIdentity(),
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
      profileKey: "pokemon-tcg-automation-client",
      profileVersion: "2026.06.03",
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

  it("plans Magic card-print Catalog Item promotion with Set reference fields", () => {
    const result = planCatalogProviderPromotionCommands({
      profile: scrydexScryfallCardProviderProfile,
      profileKey: "scryfall-card-fixture",
      profileVersion: "2026.06.03",
      providerKey: "scrydex",
      externalKey: "scryfall:0000579f-7b35-4ed3-b44c-db2a538066fe",
      mode: "create",
      catalogItemId: "cat_magic_001" as CatalogItemId,
      normalized: magicCardPrintObservation(),
      catalog: magicCardPrintCatalogMapping(),
      setReferenceId: "ref_seed_set_time_spiral" as ReferenceRecordId,
      metadata: { title: "Fury Sliver 157", subtitle: "Time Spiral Rare" },
      productAssetSet: null,
    });

    expect(result.status).toBe("planned");
    expect(result.plan?.review).toEqual({
      normalizedKind: "magic-card-print",
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
    expect(result.plan?.commands[4]).toEqual({
      type: "SetCatalogItemFieldValue",
      fieldId: "field_set",
      value: { referenceId: "ref_seed_set_time_spiral" },
    });
    expect(result.plan?.commands[9]).toEqual({
      type: "AssignCatalogItemToCategory",
      categoryId: "cat_magic_card_prints",
    });
    expect(result.plan?.commands[10]).toEqual({
      type: "SetCatalogItemTags",
      tags: ["magic", "scrydex", "set:tsp", "kind:magic-card-print", "variant:standard"],
    });
  });

  it("plans Magic sealed-product Catalog Item promotion when required facts are sufficient", () => {
    const result = planCatalogProviderPromotionCommands({
      profile: magicSealedProductProfile(),
      profileKey: "tcgplayer-magic-sealed-fixture",
      profileVersion: "2026.06.03",
      providerKey: "tcgplayer",
      externalKey: "product:96601",
      mode: "create",
      catalogItemId: "cat_magic_sealed_001" as CatalogItemId,
      normalized: magicSealedProductObservation(),
      catalog: magicSealedCatalogMapping(),
      setReferenceId: "ref_seed_set_time_spiral" as ReferenceRecordId,
      metadata: { title: "Time Spiral Booster Pack", subtitle: "Time Spiral sealed product" },
      productAssetSet: null,
    });

    expect(result.status).toBe("planned");
    expect(result.plan?.commands).toEqual(
      expect.arrayContaining([
        {
          type: "SetCatalogItemFieldValue",
          fieldId: "field_set",
          value: { referenceId: "ref_seed_set_time_spiral" },
        },
        { type: "SetCatalogItemFieldValue", fieldId: "field_pack_count", value: 1 },
        {
          type: "SetCatalogItemTags",
          tags: ["magic", "tcgplayer", "set:tsp", "kind:magic-sealed-product", "form:booster-pack"],
        },
        {
          type: "LinkExternalCatalogItemReference",
          providerKey: "tcgplayer",
          externalKey: "product:96601",
        },
      ]),
    );
  });

  it("blocks incomplete Magic card-print facts before command planning", () => {
    const result = planCatalogProviderPromotionCommands({
      profile: scrydexScryfallCardProviderProfile,
      profileKey: "scryfall-card-fixture",
      profileVersion: "2026.06.03",
      providerKey: "scrydex",
      externalKey: "scryfall:0000579f-7b35-4ed3-b44c-db2a538066fe",
      mode: "create",
      catalogItemId: "cat_magic_001" as CatalogItemId,
      normalized: magicCardPrintObservation({ cardNumber: "" }),
      catalog: magicCardPrintCatalogMapping(),
      setReferenceId: "ref_seed_set_time_spiral" as ReferenceRecordId,
      metadata: { title: "Fury Sliver", subtitle: "Time Spiral" },
      productAssetSet: null,
    });

    expect(result).toEqual({
      status: "blocked",
      plan: null,
      diagnostics: [
        {
          code: "missing-normalized-field",
          path: "normalized.cardNumber",
          diagnosticText:
            "Magic card print promotion requires a non-empty normalized field at 'normalized.cardNumber'.",
        },
      ],
    });
  });

  it("blocks incomplete Magic sealed-product facts before command planning", () => {
    const result = planCatalogProviderPromotionCommands({
      profile: magicSealedProductProfile(),
      profileKey: "tcgplayer-magic-sealed-fixture",
      profileVersion: "2026.06.03",
      providerKey: "tcgplayer",
      externalKey: "product:96601",
      mode: "create",
      catalogItemId: "cat_magic_sealed_001" as CatalogItemId,
      normalized: magicSealedProductObservation({ packCount: Number.NaN }),
      catalog: magicSealedCatalogMapping(),
      setReferenceId: "ref_seed_set_time_spiral" as ReferenceRecordId,
      metadata: { title: "Time Spiral Booster Pack", subtitle: "Time Spiral sealed product" },
      productAssetSet: null,
    });

    expect(result).toEqual({
      status: "blocked",
      plan: null,
      diagnostics: [
        {
          code: "missing-normalized-field",
          path: "normalized.packCount",
          diagnosticText:
            "Magic sealed product promotion requires a finite normalized number at 'normalized.packCount'.",
        },
      ],
    });
  });

  it("blocks Magic Set reference observations because the current promotion path writes Catalog Items", () => {
    const result = planCatalogProviderPromotionCommands({
      profile: {
        ...scrydexScryfallCardProviderProfile,
        normalizedObservationMapping: {
          ...scrydexScryfallCardProviderProfile.normalizedObservationMapping,
          kind: "magic-set-reference",
        },
      },
      profileKey: "mtgjson-set-reference-fixture",
      profileVersion: "2026.06.03",
      providerKey: "mtgjson",
      externalKey: "set:tsp",
      mode: "create",
      catalogItemId: "cat_should_not_be_used" as CatalogItemId,
      normalized: magicSetReferenceObservation(),
      catalog: magicCardPrintCatalogMapping(),
      setReferenceId: "ref_seed_set_time_spiral" as ReferenceRecordId,
      metadata: { title: "Time Spiral", subtitle: "Magic Set" },
      productAssetSet: null,
    });

    expect(result).toEqual({
      status: "blocked",
      plan: null,
      diagnostics: [
        {
          code: "unsupported-observation-kind",
          path: "normalized.kind",
          diagnosticText:
            "Magic Set reference observations are reference-data evidence and cannot be promoted through the Catalog Item promotion path.",
        },
      ],
    });
  });

  it("keeps Magic promotion fingerprints stable for replay and changes when normalized facts change", () => {
    const baseInput = {
      profile: scrydexScryfallCardProviderProfile,
      profileKey: "scryfall-card-fixture",
      profileVersion: "2026.06.03",
      providerKey: "scrydex",
      externalKey: "scryfall:0000579f-7b35-4ed3-b44c-db2a538066fe",
      mode: "refresh" as const,
      catalogItemId: "cat_magic_001" as CatalogItemId,
      catalog: magicCardPrintCatalogMapping(),
      setReferenceId: "ref_seed_set_time_spiral" as ReferenceRecordId,
      metadata: { title: "Fury Sliver 157", subtitle: "Time Spiral Rare" },
      productAssetSet: null,
    };

    const first = planCatalogProviderPromotionCommands({ ...baseInput, normalized: magicCardPrintObservation() });
    const replay = planCatalogProviderPromotionCommands({ ...baseInput, normalized: magicCardPrintObservation() });
    const changed = planCatalogProviderPromotionCommands({
      ...baseInput,
      normalized: magicCardPrintObservation({ rarity: "Special" }),
    });

    expect(first.status).toBe("planned");
    expect(replay.status).toBe("planned");
    expect(changed.status).toBe("planned");
    expect(first.plan?.planFingerprint).toBe(replay.plan?.planFingerprint);
    expect(changed.plan?.planFingerprint).not.toBe(first.plan?.planFingerprint);
  });

  it("blocks ambiguous Magic identity preflight before returning executable commands", () => {
    const result = planCatalogProviderPromotionCommands({
      profile: scrydexScryfallCardProviderProfile,
      profileKey: "scryfall-card-fixture",
      profileVersion: "2026.06.03",
      providerKey: "scrydex",
      externalKey: "scryfall:0000579f-7b35-4ed3-b44c-db2a538066fe",
      mode: "refresh",
      catalogItemId: "cat_magic_001" as CatalogItemId,
      normalized: magicCardPrintObservation(),
      catalog: magicCardPrintCatalogMapping(),
      setReferenceId: "ref_seed_set_time_spiral" as ReferenceRecordId,
      metadata: { title: "Fury Sliver 157", subtitle: "Time Spiral Rare" },
      productAssetSet: null,
      preflight: {
        status: "blocked",
        code: "ambiguous-duplicate-candidates",
        diagnosticText: "Multiple Catalog Items match this Magic Source Observation's deterministic identity.",
        candidateCatalogItemIds: ["cat_magic_001" as CatalogItemId, "cat_magic_002" as CatalogItemId],
      },
    });

    expect(result).toEqual({
      status: "blocked",
      plan: null,
      diagnostics: [
        {
          code: "ambiguous-duplicate-candidates",
          path: "preflight",
          diagnosticText: "Multiple Catalog Items match this Magic Source Observation's deterministic identity.",
        },
      ],
    });
  });

  it("blocks ambiguous duplicate candidates before returning executable commands", () => {
    const result = planCatalogProviderPromotionCommands({
      profile: tcgdexPokemonTcgProviderProfile,
      ...profileIdentity(),
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

function profileIdentity() {
  return {
    profileKey: "pokemon-tcg",
    profileVersion: "2026.06.03",
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

function magicCardPrintCatalogMapping(): CatalogProviderPromotionResolvedCatalogMapping {
  return {
    blueprintId: "bp_magic_card_print" as BlueprintId,
    categoryId: "cat_magic_card_prints" as CategoryId,
    fieldIds: {
      cardNumber: "field_card_number" as FieldId,
      cardName: "field_card_name" as FieldId,
      set: "field_set" as FieldId,
      expansion: "field_set" as FieldId,
      rarity: "field_rarity" as FieldId,
      cardVariant: "field_card_variant" as FieldId,
      cardIllustrator: "field_illustrator" as FieldId,
      releaseYear: "field_release_year" as FieldId,
    },
  };
}

function magicSealedCatalogMapping(): CatalogProviderPromotionResolvedCatalogMapping {
  return {
    blueprintId: "bp_magic_sealed_product" as BlueprintId,
    categoryId: "cat_magic_booster_packs" as CategoryId,
    fieldIds: {
      cardNumber: "field_card_number" as FieldId,
      cardName: "field_card_name" as FieldId,
      set: "field_set" as FieldId,
      expansion: "field_set" as FieldId,
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

function magicCardPrintObservation(
  overrides: Partial<SourceObservationMagicCardPrintNormalized> = {},
): SourceObservationMagicCardPrintNormalized {
  return {
    kind: "magic-card-print",
    tcg: "magic",
    languageCode: "en",
    name: "Fury Sliver",
    setName: "Time Spiral",
    expansionName: "Time Spiral",
    cardNumber: "157",
    imageUrls: ["https://cards.scryfall.io/normal/front/fury-sliver.jpg"],
    setCode: "tsp",
    setId: null,
    oracleId: "44623693-51d6-49ad-8cd7-140505caf02f",
    rarity: "Rare",
    illustrator: "Paolo Parente",
    releaseDate: "2006-10-06",
    releaseYear: 2006,
    cardVariantKey: "standard",
    cardVariantLabel: "Standard",
    mergeIdentity: {
      tcg: "magic",
      productLineName: "Magic: The Gathering",
      setName: "Time Spiral",
      printedProductName: "Fury Sliver",
      collectorNumber: "157",
      languageCode: "en",
      productForm: "magic-card-print",
    },
    externalCatalogItemReferences: [
      { providerKey: "TCGPLAYER", externalKey: "PRODUCT:14240" },
      { providerKey: "tcgplayer", externalKey: "product:14240" },
    ],
    ...overrides,
  };
}

function magicSetReferenceObservation(): SourceObservationMagicSetReferenceNormalized {
  return {
    kind: "magic-set-reference",
    tcg: "magic",
    languageCode: "en",
    name: "Time Spiral",
    setName: "Time Spiral",
    expansionName: null,
    cardNumber: null,
    imageUrls: [],
    setCode: "tsp",
    setId: null,
    releaseDate: "2006-10-06",
    releaseYear: 2006,
    cardCount: 301,
    productLineName: "Magic: The Gathering",
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
    setName: "Time Spiral",
    expansionName: "Time Spiral",
    cardNumber: null,
    imageUrls: ["https://images.example/time-spiral-booster-pack.jpg"],
    setCode: "tsp",
    setId: null,
    sealedProductForm: "booster-pack",
    packCount: 1,
    releaseDate: "2006-10-06",
    releaseYear: 2006,
    productLineName: "Magic: The Gathering",
    barcode: null,
    mergeIdentity: {
      tcg: "magic",
      productLineName: "Magic: The Gathering",
      setName: "Time Spiral",
      printedProductName: "Time Spiral Booster Pack",
      collectorNumber: null,
      languageCode: "en",
      productForm: "booster-pack",
    },
    externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:96601" }],
    externalProductReferences: [],
    ...overrides,
  };
}

function magicSealedProductProfile(): CatalogProviderIntegrationProfile {
  return {
    ...scrydexScryfallCardProviderProfile,
    providerKey: "tcgplayer",
    displayName: "TCGplayer Magic sealed fixture",
    capabilities: ["catalog-item-promotion"],
    normalizedObservationMapping: {
      ...scrydexScryfallCardProviderProfile.normalizedObservationMapping,
      kind: "magic-sealed-product",
    },
  };
}

function productAssetSet(): ProductAssetSet {
  return {
    kind: "product-image",
    sourceHash: "asset-hash",
    sourcePolicy: {
      sourceProviderKey: "tcgdex",
      sourceUrlHost: "assets.tcgdex.net",
      sourceUrlHash: "source-url-hash",
      sourceContentType: "image/webp",
      approval: "catalog-owned-rehost-approved",
      rehostingBehavior: "store-source-and-webp-display-variants",
      retention: {
        policyKey: "catalog-product-image-retention-v1",
        retentionKind: "retain-while-referenced",
        previewRetentionDays: 90,
        takedownPath: "catalog-asset-takedown",
        removalSlaDays: 30,
      },
    },
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
