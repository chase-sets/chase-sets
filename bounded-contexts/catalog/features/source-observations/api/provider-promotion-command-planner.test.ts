import { normalizedObservation } from "../../../support/test-support/source-observation-fixtures";
import { describe, expect, it } from "vitest";
import type { CatalogItemId, BlueprintId, CategoryId, FieldId, ReferenceRecordId } from "../../../ids";
import type { ProductAssetSet } from "../../../support/runtime-support/product-assets";
import type {
  SourceObservationLorcanaCardPrintNormalized,
  SourceObservationLorcanaSealedProductNormalized,
  SourceObservationLorcanaSetReferenceNormalized,
  SourceObservationMagicCardPrintNormalized,
  SourceObservationMagicSealedProductNormalized,
  SourceObservationMagicSetReferenceNormalized,
  SourceObservationOnePieceCardPrintNormalized,
  SourceObservationOnePieceSealedProductNormalized,
  SourceObservationPokemonCardNormalized,
  SourceObservationPokemonSealedProductNormalized,
  SourceObservationProviderProductNormalized,
  SourceObservationYugiohSealedProductNormalized,
} from "../domain/domain";
import {
  lorcanajsonLorcanaCardReferenceProviderProfile,
  scrydexScryfallCardProviderProfile,
  scrydexOnePieceCardPrintProviderProfile,
  scrydexOnePieceSealedProductProviderProfile,
  tcgdexPokemonTcgProviderProfile,
  tcgplayerAutomationClientProviderProfile,
  tcgplayerPokemonSealedProductProviderProfile,
  ygojsonYugiohSealedProductReferenceProviderProfile,
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
    const assetSetCommand = result.plan?.commands.find((command) => command.type === "SetCatalogItemProductAssetSets");
    expect(assetSetCommand).toMatchObject({
      productAssetSets: [
        {
          variants: expect.arrayContaining([
            expect.objectContaining({
              role: "search-card",
              density: 1,
              width: 124,
              height: 170,
            }),
          ]),
        },
      ],
    });
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

  it("preserves actual variant dimensions when refreshing a previously promoted item", () => {
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
      productAssetSet: productAssetSet(),
      preflight: { status: "ready" },
    });

    expect(result.status).toBe("planned");
    expect(result.plan?.commands).toContainEqual({
      type: "SetCatalogItemProductAssetSets",
      productAssetSets: [productAssetSet()],
    });
  });

  it("plans Pokemon sealed-product creation with images, asset sets, and external references", () => {
    const assetSet = pokemonSealedProductAssetSet();
    const result = planCatalogProviderPromotionCommands({
      profile: tcgplayerPokemonSealedProductProviderProfile,
      profileKey: "pokemon-sealed-product-sku",
      profileVersion: "2026.07.13",
      providerKey: "tcgplayer",
      externalKey: "497105",
      mode: "create",
      catalogItemId: "cat_pokemon_sealed_497105" as CatalogItemId,
      normalized: pokemonSealedProductObservation(),
      catalog: pokemonSealedProductCatalogMapping(),
      expansionReferenceId: "ref_expansion_scarlet_violet" as ReferenceRecordId,
      metadata: {
        title: "Scarlet & Violet Elite Trainer Box",
        subtitle: "Scarlet & Violet sealed product",
      },
      productAssetSet: assetSet,
      preflight: { status: "ready" },
    });

    expect(result.status).toBe("planned");
    expect(result.plan?.review).toEqual({
      normalizedKind: "pokemon-sealed-product",
      commandCount: 13,
      catalogItemReferencesLinked: 1,
      sourceProductReferencesLinked: 2,
    });
    expect(result.plan?.commands.map((command) => command.type)).toEqual([
      "CreateCatalogItem",
      "AssignBlueprintToCatalogItem",
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
      "LinkExternalProductReference",
    ]);
    expect(result.plan?.commands).toEqual(
      expect.arrayContaining([
        {
          type: "SetCatalogItemFieldValue",
          fieldId: "field_expansion",
          value: { referenceId: "ref_expansion_scarlet_violet" },
        },
        { type: "SetCatalogItemFieldValue", fieldId: "field_pack_count", value: 9 },
        {
          type: "SetCatalogItemTags",
          tags: ["pokemon", "tcgplayer", "set:scarlet-violet", "kind:pokemon-sealed-product", "form:elite-trainer-box"],
        },
        { type: "SetCatalogItemImageUrls", imageUrls: ["https://assets.example/detail.webp"] },
        { type: "SetCatalogItemProductAssetSets", productAssetSets: [assetSet] },
        {
          type: "LinkExternalProductReference",
          providerKey: "tcgplayer",
          externalKey: "en:497105",
        },
        {
          type: "LinkExternalCatalogItemReference",
          providerKey: "tcgplayer",
          externalKey: "product:497105",
        },
        {
          type: "LinkExternalProductReference",
          providerKey: "tcgplayer",
          externalKey: "sku:15501001",
          selectedOptions: [{ dimensionId: "dim_product_form", optionId: "opt_unopened" }],
        },
      ]),
    );
  });

  it("plans Pokemon sealed-product refresh without recreating Catalog structure", () => {
    const result = planCatalogProviderPromotionCommands({
      profile: tcgplayerPokemonSealedProductProviderProfile,
      profileKey: "pokemon-sealed-product-sku",
      profileVersion: "2026.07.13",
      providerKey: "tcgplayer",
      externalKey: "497105",
      mode: "refresh",
      catalogItemId: "cat_pokemon_sealed_497105" as CatalogItemId,
      normalized: pokemonSealedProductObservation(),
      catalog: pokemonSealedProductCatalogMapping(),
      expansionReferenceId: "ref_expansion_scarlet_violet" as ReferenceRecordId,
      metadata: {
        title: "Scarlet & Violet Elite Trainer Box",
        subtitle: "Scarlet & Violet sealed product",
      },
      productAssetSet: null,
    });

    expect(result.status).toBe("planned");
    expect(result.plan?.commands.map((command) => command.type)).toEqual([
      "ReviseCatalogItemMetadata",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemTags",
      "SetCatalogItemImageUrls",
      "SetCatalogItemProductAssetSets",
      "LinkExternalProductReference",
      "LinkExternalCatalogItemReference",
      "LinkExternalProductReference",
    ]);
    expect(result.plan?.commands).toEqual(
      expect.arrayContaining([
        {
          type: "SetCatalogItemImageUrls",
          imageUrls: ["https://images.example/pokemon/scarlet-violet-etb.jpg"],
        },
        { type: "SetCatalogItemProductAssetSets", productAssetSets: [] },
      ]),
    );
    expect(result.plan?.commands).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "CreateCatalogItem" }),
        expect.objectContaining({ type: "AssignBlueprintToCatalogItem" }),
        expect.objectContaining({ type: "AssignCatalogItemToCategory" }),
      ]),
    );
  });

  it("plans YGOJSON Yu-Gi-Oh! sealed-product creation with the resolved Set, assets, and external references", () => {
    const assetSet = ygojsonSealedProductAssetSet();
    const result = planCatalogProviderPromotionCommands({
      profile: ygojsonYugiohSealedProductReferenceProviderProfile,
      profileKey: "yugioh-sealed-product-reference-data",
      profileVersion: "2026.07.14",
      providerKey: "ygojson",
      externalKey: "sealed-product:22222222-2222-4222-8222-222222222222",
      mode: "create",
      catalogItemId: "cat_yugioh_sealed_2222" as CatalogItemId,
      normalized: yugiohSealedProductObservation(),
      catalog: yugiohSealedProductCatalogMapping(),
      setReferenceId: "ref_yugioh_set_lob" as ReferenceRecordId,
      metadata: { title: "Legend of Blue Eyes White Dragon Booster Box", subtitle: "Yu-Gi-Oh! sealed product" },
      productAssetSet: assetSet,
      preflight: { status: "ready" },
    });

    expect(result.status).toBe("planned");
    expect(result.plan?.review).toEqual({
      normalizedKind: "yugioh-sealed-product",
      commandCount: 12,
      catalogItemReferencesLinked: 1,
      sourceProductReferencesLinked: 2,
    });
    expect(result.plan?.commands.map((command) => command.type)).toEqual([
      "CreateCatalogItem",
      "AssignBlueprintToCatalogItem",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "SetCatalogItemFieldValue",
      "AssignCatalogItemToCategory",
      "SetCatalogItemTags",
      "SetCatalogItemImageUrls",
      "SetCatalogItemProductAssetSets",
      "LinkExternalProductReference",
      "LinkExternalCatalogItemReference",
      "LinkExternalProductReference",
    ]);
    expect(result.plan?.commands).toEqual(
      expect.arrayContaining([
        {
          type: "SetCatalogItemFieldValue",
          fieldId: "field_set",
          value: { referenceId: "ref_yugioh_set_lob" },
        },
        {
          type: "SetCatalogItemTags",
          tags: [
            "yugioh",
            "ygojson",
            "set:11111111-1111-4111-8111-111111111111",
            "kind:yugioh-sealed-product",
            "form:booster-box",
          ],
        },
        { type: "SetCatalogItemImageUrls", imageUrls: ["https://assets.example/detail.webp"] },
        { type: "SetCatalogItemProductAssetSets", productAssetSets: [assetSet] },
        {
          type: "LinkExternalCatalogItemReference",
          providerKey: "ygojson",
          externalKey: "sealed-product:22222222-2222-4222-8222-222222222222",
        },
        {
          type: "LinkExternalProductReference",
          providerKey: "ygojson",
          externalKey: "product:22222222-2222-4222-8222-222222222222",
          selectedOptions: [],
        },
      ]),
    );
  });

  it("refreshes YGOJSON sealed products without recreating Catalog structure and blocks a missing Set", () => {
    const input = {
      profile: ygojsonYugiohSealedProductReferenceProviderProfile,
      profileKey: "yugioh-sealed-product-reference-data",
      profileVersion: "2026.07.14",
      providerKey: "ygojson",
      externalKey: "sealed-product:22222222-2222-4222-8222-222222222222",
      mode: "refresh" as const,
      catalogItemId: "cat_yugioh_sealed_2222" as CatalogItemId,
      normalized: yugiohSealedProductObservation(),
      catalog: yugiohSealedProductCatalogMapping(),
      metadata: { title: "LOB Booster Box (updated)", subtitle: "Yu-Gi-Oh! sealed product" },
      productAssetSet: null,
    };
    const refreshed = planCatalogProviderPromotionCommands({
      ...input,
      setReferenceId: "ref_yugioh_set_lob" as ReferenceRecordId,
    });
    const blocked = planCatalogProviderPromotionCommands(input);

    expect(refreshed.status).toBe("planned");
    expect(refreshed.plan?.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "ReviseCatalogItemMetadata" }),
        {
          type: "SetCatalogItemFieldValue",
          fieldId: "field_set",
          value: { referenceId: "ref_yugioh_set_lob" },
        },
        {
          type: "SetCatalogItemImageUrls",
          imageUrls: ["https://images.example/yugioh/lob-booster-box.png"],
        },
        { type: "SetCatalogItemProductAssetSets", productAssetSets: [] },
        {
          type: "LinkExternalCatalogItemReference",
          providerKey: "ygojson",
          externalKey: "sealed-product:22222222-2222-4222-8222-222222222222",
        },
        {
          type: "LinkExternalProductReference",
          providerKey: "ygojson",
          externalKey: "product:22222222-2222-4222-8222-222222222222",
          selectedOptions: [],
        },
      ]),
    );
    expect(refreshed.plan?.commands).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "CreateCatalogItem" }),
        expect.objectContaining({ type: "AssignBlueprintToCatalogItem" }),
        expect.objectContaining({ type: "AssignCatalogItemToCategory" }),
      ]),
    );
    expect(blocked).toMatchObject({
      status: "blocked",
      diagnostics: [
        expect.objectContaining({
          code: "missing-reference-target",
          path: "setReferenceId",
        }),
      ],
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
      profileKey: "pokemon-single-card-product-sku",
      profileVersion: "2026.06.05",
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

  it("plans One Piece card-print Catalog Item promotion with Set reference fields", () => {
    const result = planCatalogProviderPromotionCommands({
      profile: scrydexOnePieceCardPrintProviderProfile,
      profileKey: "scrydex-one-piece-card-print",
      profileVersion: "2026.06.22",
      providerKey: "scrydex",
      externalKey: "card:op01-001",
      mode: "create",
      catalogItemId: "cat_one_piece_001" as CatalogItemId,
      normalized: onePieceCardPrintObservation(),
      catalog: onePieceCardPrintCatalogMapping(),
      setReferenceId: "ref_scrydex_one_piece_op01" as ReferenceRecordId,
      metadata: { title: "Monkey.D.Luffy", subtitle: "Romance Dawn Leader" },
      productAssetSet: null,
    });

    expect(result.status).toBe("planned");
    expect(result.plan?.review).toEqual({
      normalizedKind: "one-piece-card-print",
      commandCount: 15,
      catalogItemReferencesLinked: 1,
      sourceProductReferencesLinked: 2,
    });
    expect(result.plan?.commands).toEqual(
      expect.arrayContaining([
        {
          type: "SetCatalogItemFieldValue",
          fieldId: "field_set",
          value: { referenceId: "ref_scrydex_one_piece_op01" },
        },
        {
          type: "SetCatalogItemTags",
          tags: ["one-piece", "scrydex", "set:op01", "kind:one-piece-card-print", "card-type:leader"],
        },
        {
          type: "LinkExternalCatalogItemReference",
          providerKey: "tcgplayer",
          externalKey: "product:555001",
        },
        {
          type: "LinkExternalProductReference",
          providerKey: "tcgplayer",
          externalKey: "sku:888001",
          selectedOptions: [{ dimensionId: "dim_condition", optionId: "opt_near_mint" }],
        },
      ]),
    );
  });

  it("plans One Piece sealed-product Catalog Item promotion without price or inventory facts", () => {
    const result = planCatalogProviderPromotionCommands({
      profile: scrydexOnePieceSealedProductProviderProfile,
      profileKey: "scrydex-one-piece-sealed-product",
      profileVersion: "2026.06.22",
      providerKey: "scrydex",
      externalKey: "sealed:op01-booster-box",
      mode: "create",
      catalogItemId: "cat_one_piece_sealed_001" as CatalogItemId,
      normalized: onePieceSealedProductObservation(),
      catalog: onePieceSealedCatalogMapping(),
      setReferenceId: "ref_scrydex_one_piece_op01" as ReferenceRecordId,
      metadata: { title: "Romance Dawn Booster Box", subtitle: "One Piece sealed product" },
      productAssetSet: null,
    });

    expect(result.status).toBe("planned");
    expect(result.plan?.commands).toEqual(
      expect.arrayContaining([
        {
          type: "SetCatalogItemFieldValue",
          fieldId: "field_set",
          value: { referenceId: "ref_scrydex_one_piece_op01" },
        },
        { type: "SetCatalogItemFieldValue", fieldId: "field_sealed_product_form", value: "booster-box" },
        {
          type: "SetCatalogItemTags",
          tags: ["one-piece", "scrydex", "set:op01", "kind:one-piece-sealed-product", "form:booster-box"],
        },
        {
          type: "LinkExternalCatalogItemReference",
          providerKey: "tcgplayer",
          externalKey: "product:555900",
        },
      ]),
    );
    expect(JSON.stringify(result.plan?.commands)).not.toMatch(/price|inventory|seller|listing/i);
  });

  it("plans Lorcana card-print Catalog Item promotion with Set reference fields", () => {
    const result = planCatalogProviderPromotionCommands({
      profile: lorcanajsonLorcanaCardReferenceProviderProfile,
      profileKey: "lorcanajson-lorcana-card-reference",
      profileVersion: "2026.06.23",
      providerKey: "lorcanajson",
      externalKey: "card:the-first-chapter:17",
      mode: "create",
      catalogItemId: "cat_lorcana_001" as CatalogItemId,
      normalized: lorcanaCardPrintObservation(),
      catalog: lorcanaCardPrintCatalogMapping(),
      setReferenceId: "ref_lorcanajson_lorcana_tfc" as ReferenceRecordId,
      metadata: { title: "Elsa - Snow Queen", subtitle: "The First Chapter Storyborn" },
      productAssetSet: null,
    });

    expect(result.status).toBe("planned");
    expect(result.plan?.review).toEqual({
      normalizedKind: "lorcana-card-print",
      commandCount: 15,
      catalogItemReferencesLinked: 1,
      sourceProductReferencesLinked: 2,
    });
    expect(result.plan?.commands).toEqual(
      expect.arrayContaining([
        {
          type: "SetCatalogItemFieldValue",
          fieldId: "field_set",
          value: { referenceId: "ref_lorcanajson_lorcana_tfc" },
        },
        {
          type: "SetCatalogItemTags",
          tags: ["lorcana", "lorcanajson", "set:tfc", "kind:lorcana-card-print", "card-type:storyborn", "ink:amethyst"],
        },
        {
          type: "LinkExternalCatalogItemReference",
          providerKey: "tcgplayer",
          externalKey: "product:1005010",
        },
        {
          type: "LinkExternalProductReference",
          providerKey: "tcgplayer",
          externalKey: "sku:2005010",
          selectedOptions: [{ dimensionId: "dim_condition", optionId: "opt_near_mint" }],
        },
      ]),
    );
  });

  it("plans Lorcana sealed-product Catalog Item promotion without price or inventory facts", () => {
    const result = planCatalogProviderPromotionCommands({
      profile: lorcanaSealedProductProfile(),
      profileKey: "lorcana-sealed-fixture",
      profileVersion: "2026.06.23",
      providerKey: "scrydex",
      externalKey: "sealed:tfc-booster-box",
      mode: "create",
      catalogItemId: "cat_lorcana_sealed_001" as CatalogItemId,
      normalized: lorcanaSealedProductObservation(),
      catalog: lorcanaSealedCatalogMapping(),
      setReferenceId: "ref_lorcanajson_lorcana_tfc" as ReferenceRecordId,
      metadata: { title: "The First Chapter Booster Box", subtitle: "Lorcana sealed product" },
      productAssetSet: null,
    });

    expect(result.status).toBe("planned");
    expect(result.plan?.commands).toEqual(
      expect.arrayContaining([
        {
          type: "SetCatalogItemFieldValue",
          fieldId: "field_set",
          value: { referenceId: "ref_lorcanajson_lorcana_tfc" },
        },
        { type: "SetCatalogItemFieldValue", fieldId: "field_sealed_product_form", value: "booster-box" },
        {
          type: "SetCatalogItemTags",
          tags: ["lorcana", "scrydex", "set:tfc", "kind:lorcana-sealed-product", "form:booster-box"],
        },
        {
          type: "LinkExternalCatalogItemReference",
          providerKey: "tcgplayer",
          externalKey: "product:1005020",
        },
      ]),
    );
    expect(JSON.stringify(result.plan?.commands)).not.toMatch(/price|inventory|seller|listing/i);
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

  it("blocks One Piece Set reference observations because the Catalog Item path writes cards or sealed products", () => {
    const result = planCatalogProviderPromotionCommands({
      profile: {
        ...scrydexOnePieceCardPrintProviderProfile,
        normalizedObservationMapping: {
          ...scrydexOnePieceCardPrintProviderProfile.normalizedObservationMapping,
          kind: "one-piece-set-reference",
        },
      },
      profileKey: "scrydex-one-piece-set-reference",
      profileVersion: "2026.06.22",
      providerKey: "scrydex",
      externalKey: "set:op01",
      mode: "create",
      catalogItemId: "cat_should_not_be_used" as CatalogItemId,
      normalized: {
        kind: "one-piece-set-reference",
        tcg: "one-piece",
        languageCode: "en",
        name: "Romance Dawn",
        setName: "Romance Dawn",
        expansionName: "Romance Dawn",
        cardNumber: null,
        imageUrls: [],
        setId: "op01",
        setCode: "OP01",
        releaseDate: "2022-12-02",
        releaseYear: 2022,
        cardCount: 121,
        productLineName: "One Piece Card Game",
      },
      catalog: onePieceCardPrintCatalogMapping(),
      setReferenceId: "ref_scrydex_one_piece_op01" as ReferenceRecordId,
      metadata: { title: "Romance Dawn", subtitle: "One Piece Set" },
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
            "One Piece Set reference observations are reference-data evidence and cannot be promoted through the Catalog Item promotion path.",
        },
      ],
    });
  });

  it("blocks Lorcana Set reference observations because the Catalog Item path writes cards or sealed products", () => {
    const result = planCatalogProviderPromotionCommands({
      profile: {
        ...lorcanajsonLorcanaCardReferenceProviderProfile,
        normalizedObservationMapping: {
          ...lorcanajsonLorcanaCardReferenceProviderProfile.normalizedObservationMapping,
          kind: "lorcana-set-reference",
        },
      },
      profileKey: "lorcanajson-lorcana-set-reference",
      profileVersion: "2026.06.23",
      providerKey: "lorcanajson",
      externalKey: "set:tfc",
      mode: "create",
      catalogItemId: "cat_should_not_be_used" as CatalogItemId,
      normalized: lorcanaSetReferenceObservation(),
      catalog: lorcanaCardPrintCatalogMapping(),
      setReferenceId: "ref_lorcanajson_lorcana_tfc" as ReferenceRecordId,
      metadata: { title: "The First Chapter", subtitle: "Lorcana Set" },
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
            "Lorcana Set reference observations are reference-data evidence and cannot be promoted through the Catalog Item promotion path.",
        },
      ],
    });
  });

  it("keeps Magic promotion fingerprints stable for replay and changes when normalized facts change", () => {
    const assets = productAssetSet();
    const reorderedAssets = {
      variants: assets.variants.map((variant) => ({
        generatedAt: variant.generatedAt,
        byteSize: variant.byteSize,
        publicUrl: variant.publicUrl,
        storageKey: variant.storageKey,
        mediaType: variant.mediaType,
        density: variant.density,
        height: variant.height,
        width: variant.width,
        role: variant.role,
      })),
      source: {
        generatedAt: assets.source.generatedAt,
        byteSize: assets.source.byteSize,
        publicUrl: assets.source.publicUrl,
        storageKey: assets.source.storageKey,
        mediaType: assets.source.mediaType,
        density: assets.source.density,
        height: assets.source.height,
        width: assets.source.width,
        role: assets.source.role,
      },
      sourcePolicy: {
        retention: {
          removalSlaDays: assets.sourcePolicy.retention.removalSlaDays,
          takedownPath: assets.sourcePolicy.retention.takedownPath,
          previewRetentionDays: assets.sourcePolicy.retention.previewRetentionDays,
          retentionKind: assets.sourcePolicy.retention.retentionKind,
          policyKey: assets.sourcePolicy.retention.policyKey,
        },
        rehostingBehavior: assets.sourcePolicy.rehostingBehavior,
        approval: assets.sourcePolicy.approval,
        sourceContentType: assets.sourcePolicy.sourceContentType,
        sourceUrlHash: assets.sourcePolicy.sourceUrlHash,
        sourceUrlHost: assets.sourcePolicy.sourceUrlHost,
        sourceProviderKey: assets.sourcePolicy.sourceProviderKey,
      },
      sourceHash: assets.sourceHash,
      kind: assets.kind,
    } satisfies ProductAssetSet;
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
      productAssetSet: assets,
    };

    const first = planCatalogProviderPromotionCommands({ ...baseInput, normalized: magicCardPrintObservation() });
    const replay = planCatalogProviderPromotionCommands({
      ...baseInput,
      normalized: magicCardPrintObservation(),
      productAssetSet: reorderedAssets,
    });
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

  it("plans Product Contents promotion only after review resolves one contained Catalog Item target", () => {
    const result = planCatalogProviderPromotionCommands({
      profile: magicSealedProductProfile(),
      profileKey: "tcgplayer-magic-sealed-fixture",
      profileVersion: "2026.06.03",
      providerKey: "tcgplayer",
      externalKey: "product:96601",
      mode: "create",
      catalogItemId: "cat_magic_sealed_001" as CatalogItemId,
      normalized: magicSealedProductObservation({
        productContentsPromotion: productContentsPromotion({
          contentTypeId: "pct_reviewed_content",
          inclusionPolicyId: "pcp_reviewed_policy",
          candidateCatalogItemIds: ["cat_fury_sliver"],
          quantity: 15,
        }),
      }),
      catalog: magicSealedCatalogMapping(),
      setReferenceId: "ref_seed_set_time_spiral" as ReferenceRecordId,
      metadata: { title: "Time Spiral Booster Pack", subtitle: "Time Spiral sealed product" },
      productAssetSet: null,
    });

    expect(result.status).toBe("planned");
    expect(result.plan?.productContents).toEqual({
      planKind: "product-contents-promotion",
      replacement: {
        containerCatalogItemId: "cat_magic_sealed_001",
        lines: [
          {
            containedCatalogItemId: "cat_fury_sliver",
            containedSelectedOptions: [],
            quantity: 15,
            contentTypeId: "pct_reviewed_content",
            inclusionPolicyId: "pcp_reviewed_policy",
            provenance: { sourceObservationEvidence: "reviewed-provider-contents" },
          },
        ],
      },
      review: { lineCount: 1 },
    });
  });

  it("does not write Product Contents for observations with retained evidence but no reviewed contents promotion", () => {
    const result = planCatalogProviderPromotionCommands({
      profile: magicSealedProductProfile(),
      profileKey: "tcgplayer-magic-sealed-fixture",
      profileVersion: "2026.06.03",
      providerKey: "tcgplayer",
      externalKey: "product:96601",
      mode: "create",
      catalogItemId: "cat_magic_sealed_001" as CatalogItemId,
      normalized: magicSealedProductObservation({
        productContentsEvidence: { rawProviderContents: [{ name: "Fury Sliver" }] },
      }),
      catalog: magicSealedCatalogMapping(),
      setReferenceId: "ref_seed_set_time_spiral" as ReferenceRecordId,
      metadata: { title: "Time Spiral Booster Pack", subtitle: "Time Spiral sealed product" },
      productAssetSet: null,
    });

    expect(result.status).toBe("planned");
    expect(result.plan?.productContents).toBeNull();
  });

  it("blocks Product Contents promotion when reviewed evidence has no resolved contained target", () => {
    const result = planCatalogProviderPromotionCommands({
      profile: magicSealedProductProfile(),
      profileKey: "tcgplayer-magic-sealed-fixture",
      profileVersion: "2026.06.03",
      providerKey: "tcgplayer",
      externalKey: "product:96601",
      mode: "create",
      catalogItemId: "cat_magic_sealed_001" as CatalogItemId,
      normalized: magicSealedProductObservation({
        productContentsPromotion: productContentsPromotion({
          contentTypeId: "pct_reviewed_content",
          candidateCatalogItemIds: [],
        }),
      }),
      catalog: magicSealedCatalogMapping(),
      setReferenceId: "ref_seed_set_time_spiral" as ReferenceRecordId,
      metadata: { title: "Time Spiral Booster Pack", subtitle: "Time Spiral sealed product" },
      productAssetSet: null,
    });

    expect(result).toMatchObject({
      status: "blocked",
      diagnostics: [expect.objectContaining({ code: "missing-product-contents-target" })],
    });
  });

  it("blocks ambiguous Product Contents targets and ambiguous content types", () => {
    const result = planCatalogProviderPromotionCommands({
      profile: magicSealedProductProfile(),
      profileKey: "tcgplayer-magic-sealed-fixture",
      profileVersion: "2026.06.03",
      providerKey: "tcgplayer",
      externalKey: "product:96601",
      mode: "create",
      catalogItemId: "cat_magic_sealed_001" as CatalogItemId,
      normalized: magicSealedProductObservation({
        productContentsPromotion: productContentsPromotion({
          contentTypeId: null,
          candidateContentTypeIds: ["pct_reviewed_content", "pct_reviewed_insert"],
          candidateCatalogItemIds: ["cat_fury_sliver", "cat_fury_sliver_reprint"],
        }),
      }),
      catalog: magicSealedCatalogMapping(),
      setReferenceId: "ref_seed_set_time_spiral" as ReferenceRecordId,
      metadata: { title: "Time Spiral Booster Pack", subtitle: "Time Spiral sealed product" },
      productAssetSet: null,
    });

    expect(result).toMatchObject({
      status: "blocked",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "ambiguous-product-contents-content-type" }),
        expect.objectContaining({ code: "ambiguous-product-contents-target" }),
      ]),
    });
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

function pokemonSealedProductCatalogMapping(): CatalogProviderPromotionResolvedCatalogMapping {
  return {
    blueprintId: "bp_pokemon_sealed_product" as BlueprintId,
    categoryId: "cat_sealed_products" as CategoryId,
    fieldIds: {
      cardNumber: "field_card_number" as FieldId,
      cardName: "field_card_name" as FieldId,
      expansion: "field_expansion" as FieldId,
      rarity: "field_rarity" as FieldId,
      cardVariant: "field_card_variant" as FieldId,
      cardIllustrator: "field_card_illustrator" as FieldId,
      releaseYear: "field_release_year" as FieldId,
      packCount: "field_pack_count" as FieldId,
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

function yugiohSealedProductCatalogMapping(): CatalogProviderPromotionResolvedCatalogMapping {
  return {
    blueprintId: "bp_yugioh_sealed_product" as BlueprintId,
    categoryId: "cat_yugioh_sealed_products" as CategoryId,
    fieldIds: {
      cardNumber: "field_sealed_product_id" as FieldId,
      cardName: "field_sealed_product_name" as FieldId,
      set: "field_set" as FieldId,
      expansion: "field_set" as FieldId,
      rarity: "field_product_kind" as FieldId,
      cardVariant: "field_sealed_product_form" as FieldId,
      cardIllustrator: "field_publisher" as FieldId,
      releaseYear: "field_release_year" as FieldId,
      packCount: "field_pack_count" as FieldId,
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

function onePieceCardPrintCatalogMapping(): CatalogProviderPromotionResolvedCatalogMapping {
  return {
    blueprintId: "bp_one_piece_card_print" as BlueprintId,
    categoryId: "cat_one_piece_card_prints" as CategoryId,
    fieldIds: {
      cardNumber: "field_card_number" as FieldId,
      cardName: "field_card_name" as FieldId,
      set: "field_set" as FieldId,
      expansion: "field_set" as FieldId,
      rarity: "field_rarity" as FieldId,
      cardVariant: "field_card_type" as FieldId,
      cardIllustrator: "field_publisher" as FieldId,
      releaseYear: "field_release_year" as FieldId,
    },
  };
}

function onePieceSealedCatalogMapping(): CatalogProviderPromotionResolvedCatalogMapping {
  return {
    blueprintId: "bp_one_piece_sealed_product" as BlueprintId,
    categoryId: "cat_one_piece_sealed_products" as CategoryId,
    fieldIds: {
      cardNumber: "field_sealed_product_id" as FieldId,
      cardName: "field_sealed_product_name" as FieldId,
      set: "field_set" as FieldId,
      expansion: "field_set" as FieldId,
      rarity: "field_product_kind" as FieldId,
      cardVariant: "field_sealed_product_form" as FieldId,
      cardIllustrator: "field_publisher" as FieldId,
      releaseYear: "field_release_year" as FieldId,
      packCount: "field_pack_count" as FieldId,
    },
  };
}

function lorcanaCardPrintCatalogMapping(): CatalogProviderPromotionResolvedCatalogMapping {
  return {
    blueprintId: "bp_lorcana_card_print" as BlueprintId,
    categoryId: "cat_lorcana_card_prints" as CategoryId,
    fieldIds: {
      cardNumber: "field_card_number" as FieldId,
      cardName: "field_card_name" as FieldId,
      set: "field_set" as FieldId,
      expansion: "field_set" as FieldId,
      rarity: "field_rarity" as FieldId,
      cardVariant: "field_card_type" as FieldId,
      cardIllustrator: "field_publisher" as FieldId,
      releaseYear: "field_release_year" as FieldId,
    },
  };
}

function lorcanaSealedCatalogMapping(): CatalogProviderPromotionResolvedCatalogMapping {
  return {
    blueprintId: "bp_lorcana_sealed_product" as BlueprintId,
    categoryId: "cat_lorcana_sealed_products" as CategoryId,
    fieldIds: {
      cardNumber: "field_sealed_product_id" as FieldId,
      cardName: "field_sealed_product_name" as FieldId,
      set: "field_set" as FieldId,
      expansion: "field_set" as FieldId,
      rarity: "field_product_kind" as FieldId,
      cardVariant: "field_sealed_product_form" as FieldId,
      cardIllustrator: "field_publisher" as FieldId,
      releaseYear: "field_release_year" as FieldId,
      packCount: "field_pack_count" as FieldId,
    },
  };
}

function pokemonCardObservation(
  overrides: Partial<SourceObservationPokemonCardNormalized> = {},
): SourceObservationPokemonCardNormalized {
  return normalizedObservation({
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
    imageBaseUrl: "https://images.example/swsh1-001",
    imageUrls: ["https://images.example/swsh1-001/high.webp"],
    cardVariantKey: "holofoil",
    cardVariantLabel: "Standard Set Foil",
    cardVariantSourceKey: "holo",
    imageDisclaimer: "Variant artwork uses provider image reference.",
    variants: {},
    externalCatalogItemReferences: [
      { providerKey: "TCGPLAYER", externalKey: "PRODUCT:12345" },
      { providerKey: "tcgplayer", externalKey: "product:12345" },
    ],
    ...overrides,
  });
}

function pokemonSealedProductObservation(
  overrides: Partial<SourceObservationPokemonSealedProductNormalized> = {},
): SourceObservationPokemonSealedProductNormalized {
  return {
    kind: "pokemon-sealed-product",
    tcg: "pokemon",
    languageCode: "en",
    name: "Scarlet & Violet Elite Trainer Box",
    setId: "10001",
    setCode: "svi",
    setName: "Scarlet & Violet",
    expansionName: "Scarlet & Violet",
    cardNumber: null,
    sealedProductForm: "elite-trainer-box",
    packCount: 9,
    releaseDate: "2023-03-31",
    releaseYear: 2023,
    productLineName: "Pokemon",
    barcode: "0820650851234",
    imageUrls: ["https://images.example/pokemon/scarlet-violet-etb.jpg"],
    mergeIdentity: {
      tcg: "pokemon",
      productLineName: "Pokemon",
      setName: "Scarlet & Violet",
      printedProductName: "Scarlet & Violet Elite Trainer Box",
      collectorNumber: "ETB",
      languageCode: "en",
      productForm: "sealed",
      barcode: "0820650851234",
    },
    externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:497105" }],
    externalProductReferences: [
      {
        providerKey: "tcgplayer",
        externalKey: "sku:15501001",
        selectedOptions: [{ dimensionId: "dim_product_form", optionId: "opt_unopened" }],
      },
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

function yugiohSealedProductObservation(
  overrides: Partial<SourceObservationYugiohSealedProductNormalized> = {},
): SourceObservationYugiohSealedProductNormalized {
  return {
    kind: "yugioh-sealed-product",
    tcg: "yugioh",
    languageCode: "en",
    name: "Legend of Blue Eyes White Dragon Booster Box",
    setName: null,
    expansionName: null,
    cardNumber: null,
    setCode: null,
    sealedProductForm: "booster-box",
    releaseDate: "2002-03-08",
    productLineName: "Yu-Gi-Oh!",
    barcode: null,
    boxOfSetEvidence: ["11111111-1111-4111-8111-111111111111"],
    imageUrls: ["https://images.example/yugioh/lob-booster-box.png"],
    externalCatalogItemReferences: [
      { providerKey: "ygojson", externalKey: "sealed-product:22222222-2222-4222-8222-222222222222" },
    ],
    externalProductReferences: [
      {
        providerKey: "ygojson",
        externalKey: "product:22222222-2222-4222-8222-222222222222",
        selectedOptions: [],
      },
    ],
    ...overrides,
  };
}

function productContentsPromotion(input: {
  contentTypeId: string | null;
  candidateContentTypeIds?: readonly string[];
  inclusionPolicyId?: string | null;
  candidateCatalogItemIds?: readonly string[];
  quantity?: number | null;
}) {
  return {
    lines: [
      {
        contentTypeId: input.contentTypeId,
        candidateContentTypeIds: input.candidateContentTypeIds ?? [],
        inclusionPolicyId: input.inclusionPolicyId ?? null,
        candidateCatalogItemIds: input.candidateCatalogItemIds ?? [],
        quantity: input.quantity ?? null,
        provenance: { sourceObservationEvidence: "reviewed-provider-contents" },
      },
    ],
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
    setName: "Romance Dawn",
    expansionName: "Romance Dawn",
    cardNumber: "OP01-001",
    imageUrls: ["https://images.example/one-piece/op01-001.jpg"],
    setId: "op01",
    setCode: "OP01",
    rarity: "L",
    cardType: "Leader",
    releaseDate: "2022-12-02",
    releaseYear: 2022,
    productLineName: "One Piece Card Game",
    mergeIdentity: {
      tcg: "one-piece",
      productLineName: "One Piece Card Game",
      setName: "Romance Dawn",
      printedProductName: "Monkey.D.Luffy",
      collectorNumber: "OP01-001",
      languageCode: "en",
      productForm: "one-piece-card-print",
    },
    externalCatalogItemReferences: [{ providerKey: "TCGPLAYER", externalKey: "PRODUCT:555001" }],
    externalProductReferences: [
      {
        providerKey: "tcgplayer",
        externalKey: "sku:888001",
        selectedOptions: [{ dimensionId: "dim_condition", optionId: "opt_near_mint" }],
      },
    ],
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
    name: "Romance Dawn Booster Box",
    setName: "Romance Dawn",
    expansionName: "Romance Dawn",
    cardNumber: null,
    imageUrls: ["https://images.example/one-piece/op01-booster-box.jpg"],
    setId: "op01",
    setCode: "OP01",
    sealedProductForm: "booster-box",
    releaseDate: "2022-12-02",
    releaseYear: 2022,
    productLineName: "One Piece Card Game",
    barcode: null,
    mergeIdentity: {
      tcg: "one-piece",
      productLineName: "One Piece Card Game",
      setName: "Romance Dawn",
      printedProductName: "Romance Dawn Booster Box",
      collectorNumber: null,
      languageCode: "en",
      productForm: "booster-box",
    },
    externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:555900" }],
    externalProductReferences: [],
    ...overrides,
  };
}

function lorcanaCardPrintObservation(
  overrides: Partial<SourceObservationLorcanaCardPrintNormalized> = {},
): SourceObservationLorcanaCardPrintNormalized {
  return {
    kind: "lorcana-card-print",
    tcg: "lorcana",
    languageCode: "en",
    name: "Elsa - Snow Queen",
    setName: "The First Chapter",
    expansionName: "The First Chapter",
    cardNumber: "17",
    imageUrls: ["https://images.example/lorcana/tfc-17.jpg"],
    setId: "tfc",
    setCode: "TFC",
    rarity: "Legendary",
    cardType: "Storyborn",
    inkColor: "Amethyst",
    releaseDate: "2023-08-18",
    releaseYear: 2023,
    productLineName: "Disney Lorcana",
    mergeIdentity: {
      tcg: "lorcana",
      productLineName: "Disney Lorcana",
      setName: "The First Chapter",
      printedProductName: "Elsa - Snow Queen",
      collectorNumber: "17",
      languageCode: "en",
      productForm: "lorcana-card-print",
    },
    externalCatalogItemReferences: [{ providerKey: "TCGPLAYER", externalKey: "PRODUCT:1005010" }],
    externalProductReferences: [
      {
        providerKey: "tcgplayer",
        externalKey: "sku:2005010",
        selectedOptions: [{ dimensionId: "dim_condition", optionId: "opt_near_mint" }],
      },
    ],
    ...overrides,
  };
}

function lorcanaSetReferenceObservation(): SourceObservationLorcanaSetReferenceNormalized {
  return {
    kind: "lorcana-set-reference",
    tcg: "lorcana",
    languageCode: "en",
    name: "The First Chapter",
    setName: "The First Chapter",
    expansionName: "The First Chapter",
    cardNumber: null,
    imageUrls: [],
    setId: "tfc",
    setCode: "TFC",
    releaseDate: "2023-08-18",
    releaseYear: 2023,
    cardCount: 204,
    productLineName: "Disney Lorcana",
  };
}

function lorcanaSealedProductObservation(
  overrides: Partial<SourceObservationLorcanaSealedProductNormalized> = {},
): SourceObservationLorcanaSealedProductNormalized {
  return {
    kind: "lorcana-sealed-product",
    tcg: "lorcana",
    languageCode: "en",
    name: "The First Chapter Booster Box",
    setName: "The First Chapter",
    expansionName: "The First Chapter",
    cardNumber: null,
    imageUrls: ["https://images.example/lorcana/tfc-booster-box.jpg"],
    setId: "tfc",
    setCode: "TFC",
    sealedProductForm: "booster-box",
    releaseDate: "2023-08-18",
    releaseYear: 2023,
    productLineName: "Disney Lorcana",
    barcode: null,
    mergeIdentity: {
      tcg: "lorcana",
      productLineName: "Disney Lorcana",
      setName: "The First Chapter",
      printedProductName: "The First Chapter Booster Box",
      collectorNumber: null,
      languageCode: "en",
      productForm: "booster-box",
    },
    externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:1005020" }],
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

function lorcanaSealedProductProfile(): CatalogProviderIntegrationProfile {
  return {
    ...lorcanajsonLorcanaCardReferenceProviderProfile,
    providerKey: "scrydex",
    displayName: "Scrydex Lorcana sealed fixture",
    capabilities: ["catalog-item-promotion"],
    normalizedObservationMapping: {
      ...lorcanajsonLorcanaCardReferenceProviderProfile.normalizedObservationMapping,
      kind: "lorcana-sealed-product",
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
        role: "search-card",
        width: 124,
        height: 170,
        density: 1,
        mediaType: "image/webp",
        storageKey: "catalog/items/cat_001/product-image/search-card-224w-1x.webp",
        publicUrl: "https://assets.example/search-card-224w.webp",
        byteSize: 256,
        generatedAt: "2026-06-03T00:00:00.000Z",
      },
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

function pokemonSealedProductAssetSet(): ProductAssetSet {
  const assetSet = productAssetSet();
  return {
    ...assetSet,
    sourcePolicy: {
      ...assetSet.sourcePolicy,
      sourceProviderKey: "tcgplayer",
      sourceUrlHost: "images.tcgplayer.com",
    },
  };
}

function ygojsonSealedProductAssetSet(): ProductAssetSet {
  const assetSet = productAssetSet();
  return {
    ...assetSet,
    sourcePolicy: {
      ...assetSet.sourcePolicy,
      sourceProviderKey: "ygojson",
      sourceUrlHost: "raw.githubusercontent.com",
    },
  };
}
