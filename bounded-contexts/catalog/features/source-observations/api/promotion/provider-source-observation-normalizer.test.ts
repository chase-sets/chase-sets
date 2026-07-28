import { describe, expect, it } from "vitest";
import { normalizedObservation } from "../../../../support/test-support/source-observation-fixtures";
import type { JsonObject, JsonValue } from "@chase-sets/primitives/json";
import {
  normalizeSourceObservationNaturalKeys,
  type SourceObservationPokemonCardNormalized,
} from "../../domain/domain";
import type {
  CatalogProviderExecutableMappingContract,
  CatalogProviderMappingEvidenceOwner,
  CatalogProviderMappingEvidenceUse,
  CatalogProviderMappingValueExpression,
} from "../providers/provider-integration-mapping-contract";
import {
  formatCatalogProviderNormalizationDiagnostics,
  normalizeCatalogProviderSourceObservation,
  type CatalogProviderSourceObservationMappingContract,
} from "./provider-source-observation-normalizer";
import tcgdexNormalFixture from "../__fixtures__/tcgdex/normal.json";
import { tcgdexPokemonCardSourceObservationMappingContract } from "../tcgdex-executable-mapping-contract";
import { scrydexScryfallCardSourceObservationMappingContract } from "../scrydex-executable-mapping-contract";
import {
  scryfallMtgCardPrintSourceObservationMappingContract,
  scryfallMtgImageEvidenceSourceObservationMappingContract,
} from "../scryfall-executable-mapping-contract";
import {
  mtgjsonMtgCardReferenceSourceObservationMappingContract,
  mtgjsonMtgSetReferenceSourceObservationMappingContract,
} from "../mtgjson-executable-mapping-contract";
import { scrydexOnePieceCardPrintSourceObservationMappingContract } from "../scrydex-one-piece-executable-mapping-contract";
import { tcgplayerOnePieceSingleCardProviderProductSourceObservationMappingContract } from "../tcgplayer-executable-mapping-contract";
import scrydexOnePieceCardFixture from "../__fixtures__/scrydex-one-piece-card-print/normal.json";
import tcgplayerOnePieceFixture from "../__fixtures__/tcgplayer-one-piece-single-card/normal.json";

describe("provider Source Observation normalizer", () => {
  it("builds a provider-product Source Observation from mapping config", () => {
    const contract = providerProductContract();

    const result = normalizeCatalogProviderSourceObservation({
      contract,
      payload: providerProductPayload(),
      observedAt: "2026-06-03T00:00:00.000Z",
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.observation).toMatchObject({
      observationId: "tcgplayer_en_product_610001",
      providerKey: "tcgplayer",
      externalKey: "product:610001",
      sourceUrl: "https://mp-search-api.tcgplayer.com/v2/product/610001/details",
      languageCode: "en",
      sourceUpdatedAt: "2025-01-17",
      normalized: {
        kind: "provider-product",
        providerProductId: "610001",
        providerProductName: "Eevee ex",
        name: "Eevee ex",
        cardNumber: "167",
        externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:610001" }],
      },
    });
    expect(result.observation?.sourceRecordHash).toHaveLength(64);
  });

  it("keeps price and listing signals out of configured hash material", () => {
    const contract = providerProductContract();
    const base = providerProductPayload();
    const repriced = {
      ...base,
      marketPrice: 10_000,
      lowestPrice: 9_999,
      listings: 999,
    };

    const original = normalizeCatalogProviderSourceObservation({
      contract,
      payload: base,
      observedAt: "2026-06-03T00:00:00.000Z",
    });
    const changed = normalizeCatalogProviderSourceObservation({
      contract,
      payload: repriced,
      observedAt: "2026-06-03T00:00:00.000Z",
    });

    expect(changed.observation?.sourceRecordHash).toBe(original.observation?.sourceRecordHash);
  });

  it("builds a Yu-Gi-Oh card-print observation without treating vendor prices as Catalog truth", () => {
    const contract = yugiohCardPrintContract();
    const base = yugiohCardPrintPayload();
    const repriced = {
      ...base,
      card_prices: [{ tcgplayer_price: "999.99", cardmarket_price: "888.88" }],
    };

    const original = normalizeCatalogProviderSourceObservation({
      contract,
      payload: base,
      observedAt: "2026-06-20T00:00:00.000Z",
    });
    const changed = normalizeCatalogProviderSourceObservation({
      contract,
      payload: repriced,
      observedAt: "2026-06-20T00:00:00.000Z",
    });

    expect(original.diagnostics).toEqual([]);
    expect(original.observation).toMatchObject({
      observationId: "ygoprodeck_en_card_89631139",
      providerKey: "ygoprodeck",
      externalKey: "card:89631139",
      languageCode: "en",
      normalized: {
        kind: "yugioh-card-print",
        tcg: "yugioh",
        name: "Blue-Eyes White Dragon",
        passcode: "89631139",
        setName: "Legend of Blue Eyes White Dragon",
        rarity: "Ultra Rare",
        imageUrls: ["https://images.ygoprodeck.com/images/cards/89631139.jpg"],
      },
    });
    expect(changed.observation?.sourceRecordHash).toBe(original.observation?.sourceRecordHash);
    expect(JSON.stringify(original.observation?.normalized)).not.toMatch(/tcgplayer_price|cardmarket_price|999\.99/);
  });

  it("reports missing required fields without leaking provider values", () => {
    const result = normalizeCatalogProviderSourceObservation({
      contract: providerProductContract(),
      payload: {
        productId: 610001,
        productName: "Secret Rare Cookie",
        auth: { cookie: "TCGAuthTicket_Production=do-not-log" },
      },
      observedAt: "2026-06-03T00:00:00.000Z",
    });

    const text = formatCatalogProviderNormalizationDiagnostics("tcgplayer", result.diagnostics);

    expect(result.observation).toBeNull();
    expect(text).toContain("tcgplayer");
    expect(text).not.toContain("Secret Rare Cookie");
    expect(text).not.toContain("TCGAuthTicket_Production");
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing-required-path",
          path: "normalizedObservation.fields.setName.selector.path",
        }),
      ]),
    );
  });

  it("builds a Scrydex magic-card-print observation with Scryfall card print identity", () => {
    const result = normalizeCatalogProviderSourceObservation({
      contract: scrydexScryfallCardSourceObservationMappingContract,
      payload: {
        ...scrydexScryfallCardPayload(),
        set: "TSP",
        collector_number: "0136",
      },
      observedAt: "2026-06-03T00:00:00.000Z",
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.observation).toMatchObject({
      observationId: "scrydex_en_0000579f-7b35-4ed3-b44c-db2a538066fe",
      providerKey: "scrydex",
      externalKey: "scryfall:0000579f-7b35-4ed3-b44c-db2a538066fe",
      sourceUrl: "https://scryfall.com/card/tsp/157/fury-sliver",
      languageCode: "en",
      sourceUpdatedAt: "2006-10-06",
      normalized: {
        kind: "magic-card-print",
        tcg: "magic",
        name: "Fury Sliver",
        setCode: "tsp",
        setName: "Time Spiral",
        cardNumber: "136",
        oracleId: "44623693-51d6-49ad-8cd7-140505caf02f",
        releaseDate: "2006-10-06",
        cardVariantKey: "standard",
        cardVariantLabel: "Standard",
        imageUrls: [
          "https://cards.scryfall.io/normal/front/0/0/0000579f-7b35-4ed3-b44c-db2a538066fe.jpg",
          "https://cards.scryfall.io/png/front/0/0/0000579f-7b35-4ed3-b44c-db2a538066fe.png",
        ],
        externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:14240" }],
        mergeIdentity: {
          tcg: "magic",
          productLineName: "Magic: The Gathering",
          setName: "Time Spiral",
          printedProductName: "Fury Sliver",
          collectorNumber: "136",
          languageCode: "en",
          productForm: "magic-card-print",
        },
      },
    });
    expect(result.observation?.sourceRecordHash).toHaveLength(64);
  });

  it("normalizes natural keys from a TCGdex Pokemon payload", () => {
    const result = normalizeCatalogProviderSourceObservation({
      contract: tcgdexPokemonCardSourceObservationMappingContract,
      payload: {
        ...tcgdexNormalFixture,
        languageCode: "EN-us",
        card: {
          ...tcgdexNormalFixture.card,
          localId: 136,
        },
        mergeIdentity: {
          ...tcgdexNormalFixture.mergeIdentity,
          cardNumber: "0136",
        },
      },
      observedAt: "2026-07-09T00:00:00.000Z",
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.observation?.normalized).toMatchObject({
      kind: "pokemon-card",
      languageCode: "en-US",
      cardNumber: "136",
      mergeIdentity: {
        cardNumber: "136",
      },
    });
  });

  it("normalizes the number and locale shape used by Pokemon TCG API payloads", () => {
    const pokemonTcgPayload = {
      name: "Furret",
      number: "0136",
      set: { id: "swsh3", name: "Darkness Ablaze" },
    };
    const normalized = normalizeSourceObservationNaturalKeys(
      normalizedObservation({
        languageCode: "EN-us",
        name: pokemonTcgPayload.name,
        cardNumber: pokemonTcgPayload.number,
        setId: pokemonTcgPayload.set.id,
        setName: pokemonTcgPayload.set.name,
        expansionId: pokemonTcgPayload.set.id,
        expansionName: pokemonTcgPayload.set.name,
        expansionAbbreviation: "DAA",
        expansionCardCount: 189,
        expansionParallelSetCardCount: null,
        seriesId: "swsh",
        seriesName: "Sword & Shield",
        rarity: "Uncommon",
        illustrator: "tetsuya koizumi",
        releaseDate: "2020-08-14",
        releaseYear: 2020,
        category: "Pokemon",
        imageBaseUrl: null,
        imageUrls: [],
        productAssetSet: null,
        parallelSet: false,
        cardVariantKey: "standard",
        cardVariantLabel: "Standard",
        cardVariantSourceKey: null,
        cardVariantIsPrimaryImage: true,
        imageDisclaimer: null,
        variants: {},
      }) satisfies SourceObservationPokemonCardNormalized,
    );

    expect(normalized).toMatchObject({ languageCode: "en-US", cardNumber: "136" });
  });

  it("builds production Scryfall observations from wrapped adapter payloads", () => {
    const cardPayload = scryfallWrappedCardPayload();
    const card = cardPayload.card as JsonObject;
    const cardResult = normalizeCatalogProviderSourceObservation({
      contract: scryfallMtgCardPrintSourceObservationMappingContract,
      payload: cardPayload,
      observedAt: "2026-06-19T00:00:00.000Z",
    });
    const imageResult = normalizeCatalogProviderSourceObservation({
      contract: scryfallMtgImageEvidenceSourceObservationMappingContract,
      payload: {
        kind: "image-evidence",
        card,
        imageUris: card.image_uris,
      },
      observedAt: "2026-06-19T00:00:00.000Z",
    });

    expect(cardResult.diagnostics).toEqual([]);
    expect(cardResult.observation).toMatchObject({
      observationId: "scryfall_card_en_0000579f-7b35-4ed3-b44c-db2a538066fe",
      providerKey: "scryfall",
      externalKey: "card:0000579f-7b35-4ed3-b44c-db2a538066fe",
      sourceUrl: "https://api.scryfall.com/cards/0000579f-7b35-4ed3-b44c-db2a538066fe",
      sourceProfileKey: "mtg-card-print-reference-data",
      sourceProfileVersion: "2026.06.19",
      normalized: {
        kind: "magic-card-print",
        tcg: "magic",
        name: "Fury Sliver",
        setCode: "tsp",
        setName: "Time Spiral",
        cardNumber: "157",
        oracleId: "44623693-51d6-49ad-8cd7-140505caf02f",
        illustrator: "Pete Venters",
        externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:14240" }],
      },
      sourcePayload: expect.objectContaining({ kind: "single-card" }),
    });
    expect(imageResult.diagnostics).toEqual([]);
    expect(imageResult.observation).toMatchObject({
      observationId: "scryfall_image_en_0000579f-7b35-4ed3-b44c-db2a538066fe",
      providerKey: "scryfall",
      externalKey: "image:0000579f-7b35-4ed3-b44c-db2a538066fe",
      sourceProfileKey: "mtg-card-image-evidence",
      normalized: {
        kind: "magic-card-print",
        imageUrls: [
          "https://cards.scryfall.io/normal/front/0/0/0000579f-7b35-4ed3-b44c-db2a538066fe.jpg",
          "https://cards.scryfall.io/png/front/0/0/0000579f-7b35-4ed3-b44c-db2a538066fe.png",
        ],
      },
    });
  });

  it("builds production MTGJSON card and set reference observations from wrapped adapter payloads", () => {
    const cardPayload = mtgjsonWrappedCardPayload();
    const setResult = normalizeCatalogProviderSourceObservation({
      contract: mtgjsonMtgSetReferenceSourceObservationMappingContract,
      payload: {
        kind: "set-reference",
        meta: cardPayload.meta,
        set: cardPayload.set,
        sourceUrl: cardPayload.sourceUrl,
      },
      observedAt: "2026-06-19T00:00:00.000Z",
    });
    const cardResult = normalizeCatalogProviderSourceObservation({
      contract: mtgjsonMtgCardReferenceSourceObservationMappingContract,
      payload: cardPayload,
      observedAt: "2026-06-19T00:00:00.000Z",
    });

    expect(setResult.diagnostics).toEqual([]);
    expect(setResult.observation).toMatchObject({
      observationId: "mtgjson_set_en_TSP",
      providerKey: "mtgjson",
      externalKey: "set:TSP",
      sourceUrl: "https://mtgjson.com/api/v5/TSP.json",
      sourceProfileKey: "mtg-set-reference-data",
      sourceProfileVersion: "2026.06.19",
      normalized: {
        kind: "magic-set-reference",
        tcg: "magic",
        name: "Time Spiral",
        setCode: "tsp",
        setName: "Time Spiral",
        cardCount: 301,
        productLineName: "Magic: The Gathering",
      },
    });
    expect(cardResult.diagnostics).toEqual([]);
    expect(cardResult.observation).toMatchObject({
      observationId: "mtgjson_card_en_13fd9d47-9aa7-5f7c-8f47-fury-sliver",
      providerKey: "mtgjson",
      externalKey: "card:13fd9d47-9aa7-5f7c-8f47-fury-sliver",
      sourceProfileKey: "mtg-card-reference-data",
      sourceProfileVersion: "2026.06.19",
      normalized: {
        kind: "magic-card-print",
        tcg: "magic",
        name: "Fury Sliver",
        setCode: "tsp",
        setName: "Time Spiral",
        cardNumber: "157",
        oracleId: "44623693-51d6-49ad-8cd7-140505caf02f",
        externalCatalogItemReferences: [
          { providerKey: "scryfall", externalKey: "card:0000579f-7b35-4ed3-b44c-db2a538066fe" },
        ],
      },
    });
  });

  it("normalizes redacted One Piece fixtures without retaining provider imagery or commerce payloads", () => {
    const scrydexResult = normalizeCatalogProviderSourceObservation({
      contract: scrydexOnePieceCardPrintSourceObservationMappingContract,
      payload: scrydexOnePieceCardFixture,
      observedAt: "2026-06-23T00:00:00.000Z",
    });
    const tcgplayerResult = normalizeCatalogProviderSourceObservation({
      contract: tcgplayerOnePieceSingleCardProviderProductSourceObservationMappingContract,
      payload: tcgplayerOnePieceFixture,
      observedAt: "2026-06-23T00:00:00.000Z",
    });

    expect(scrydexResult.diagnostics).toEqual([]);
    expect(scrydexResult.observation).toMatchObject({
      providerKey: "scrydex",
      normalized: {
        kind: "one-piece-card-print",
        imageUrls: [],
      },
    });
    expect(tcgplayerResult.diagnostics).toEqual([]);
    expect(tcgplayerResult.observation).toMatchObject({
      providerKey: "tcgplayer",
      normalized: {
        kind: "provider-product",
        productLineName: "One Piece Card Game",
        imageUrls: [],
      },
    });
    expect(JSON.stringify(scrydexResult.observation?.sourcePayload)).not.toMatch(
      /image_url|imageUrls|price|inventory/i,
    );
    expect(JSON.stringify(tcgplayerResult.observation?.sourcePayload)).toContain("redacted fixture boundary");
    expect(JSON.stringify(tcgplayerResult.observation?.sourcePayload)).not.toMatch(/\b\d+\.\d{2}\b|quantity|seller/i);
  });

  it("extracts approved TCGplayer One Piece image URL evidence when the fixture provides it", () => {
    const result = normalizeCatalogProviderSourceObservation({
      contract: tcgplayerOnePieceSingleCardProviderProductSourceObservationMappingContract,
      payload: {
        ...tcgplayerOnePieceFixture,
        imageUrls: ["https://tcgplayer-cdn.tcgplayer.com/product/987650_200w.jpg"],
      },
      observedAt: "2026-06-23T00:00:00.000Z",
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.observation?.normalized).toMatchObject({
      kind: "provider-product",
      productLineName: "One Piece Card Game",
      imageUrls: ["https://tcgplayer-cdn.tcgplayer.com/product/987650_200w.jpg"],
    });
  });

  it("extracts approved Scrydex One Piece image URL evidence from sanitized payloads", () => {
    const result = normalizeCatalogProviderSourceObservation({
      contract: scrydexOnePieceCardPrintSourceObservationMappingContract,
      payload: {
        ...scrydexOnePieceCardFixture,
        card: {
          ...scrydexOnePieceCardFixture.card,
          imageUrls: ["https://images.scrydex.example/op01-001/large"],
        },
      },
      observedAt: "2026-06-23T00:00:00.000Z",
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.observation?.normalized).toMatchObject({
      kind: "one-piece-card-print",
      imageUrls: ["https://images.scrydex.example/op01-001/large"],
    });
  });

  it("blocks incomplete magic-card-print observations with actionable normalized field diagnostics", () => {
    const contract: CatalogProviderSourceObservationMappingContract = {
      ...scrydexScryfallCardSourceObservationMappingContract,
      normalizedObservation: {
        ...scrydexScryfallCardSourceObservationMappingContract.normalizedObservation,
        fields: {
          ...scrydexScryfallCardSourceObservationMappingContract.normalizedObservation.fields,
          setCode: optionalExpr("missing_set_code", "catalog-truth", ["normalized-observation"]),
        },
      },
    };

    const result = normalizeCatalogProviderSourceObservation({
      contract,
      payload: scrydexScryfallCardPayload(),
      observedAt: "2026-06-03T00:00:00.000Z",
    });

    expect(result.observation).toBeNull();
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "transform-type-mismatch",
          path: "normalizedObservation.fields.setCode",
          diagnosticText: expect.stringContaining("setCode"),
        }),
      ]),
    );
  });
});

function scrydexScryfallCardPayload(): JsonObject {
  return {
    object: "card",
    id: "0000579f-7b35-4ed3-b44c-db2a538066fe",
    oracle_id: "44623693-51d6-49ad-8cd7-140505caf02f",
    name: "Fury Sliver",
    lang: "en",
    released_at: "2006-10-06",
    scryfall_uri: "https://scryfall.com/card/tsp/157/fury-sliver",
    set: "tsp",
    set_name: "Time Spiral",
    collector_number: "157",
    image_uris: {
      normal: "https://cards.scryfall.io/normal/front/0/0/0000579f-7b35-4ed3-b44c-db2a538066fe.jpg",
      png: "https://cards.scryfall.io/png/front/0/0/0000579f-7b35-4ed3-b44c-db2a538066fe.png",
    },
    tcgplayer_id: 14240,
  };
}

function scryfallWrappedCardPayload(): JsonObject {
  return {
    kind: "single-card",
    card: {
      ...scrydexScryfallCardPayload(),
      uri: "https://api.scryfall.com/cards/0000579f-7b35-4ed3-b44c-db2a538066fe",
      set_id: "c1d109bc-ffd8-428f-8d7d-3f8d7e648046",
      artist: "Pete Venters",
    },
  };
}

function mtgjsonWrappedCardPayload(): JsonObject {
  return {
    kind: "single-card",
    meta: {
      date: "2026-06-05",
      version: "5.3.0+20260605",
    },
    set: {
      code: "TSP",
      name: "Time Spiral",
      releaseDate: "2006-10-06",
      totalSetSize: 301,
      type: "expansion",
    },
    card: {
      uuid: "13fd9d47-9aa7-5f7c-8f47-fury-sliver",
      name: "Fury Sliver",
      number: "157",
      rarity: "uncommon",
      layout: "normal",
      identifiers: {
        scryfallId: "0000579f-7b35-4ed3-b44c-db2a538066fe",
        scryfallOracleId: "44623693-51d6-49ad-8cd7-140505caf02f",
      },
    },
    sourceUrl: "https://mtgjson.com/api/v5/TSP.json",
  };
}

function providerProductPayload(): JsonObject {
  return {
    productId: 610001,
    productName: "Eevee ex",
    productLineName: "Pokemon",
    productTypeName: "Cards",
    setName: "Prismatic Evolutions",
    releaseDate: "2025-01-17",
    customAttributes: { number: "167" },
    sourceUrl: "https://mp-search-api.tcgplayer.com/v2/product/610001/details",
    externalKey: "product:610001",
    observationId: "tcgplayer_en_product_610001",
    catalogHashMaterial: {
      productId: 610001,
      productName: "Eevee ex",
      setName: "Prismatic Evolutions",
      number: "167",
    },
  };
}

function yugiohCardPrintPayload(): JsonObject {
  return {
    id: 89631139,
    name: "Blue-Eyes White Dragon",
    passcode: "89631139",
    type: "Normal Monster",
    attribute: "LIGHT",
    archetype: "Blue-Eyes",
    card_sets: [
      {
        set_name: "Legend of Blue Eyes White Dragon",
        set_code: "LOB-001",
        set_rarity: "Ultra Rare",
      },
    ],
    selectedPrint: {
      set_name: "Legend of Blue Eyes White Dragon",
      set_code: "LOB-001",
      set_rarity: "Ultra Rare",
    },
    card_images: [{ image_url: "https://images.ygoprodeck.com/images/cards/89631139.jpg" }],
    card_prices: [{ tcgplayer_price: "1.23", cardmarket_price: "1.11" }],
    sourceUrl: "https://db.ygoprodeck.com/api/v7/cardinfo.php?id=89631139",
    sourceUpdatedAt: "2026-06-20",
    externalKey: "card:89631139",
    observationId: "ygoprodeck_en_card_89631139",
    catalogHashMaterial: {
      id: 89631139,
      name: "Blue-Eyes White Dragon",
      setCode: "LOB-001",
      setName: "Legend of Blue Eyes White Dragon",
      rarity: "Ultra Rare",
    },
  };
}

function providerProductContract(): CatalogProviderSourceObservationMappingContract {
  return {
    ...baseContract(),
    sourceObservation: {
      observationId: expr("observationId", "catalog-merge-evidence", ["normalized-observation"]),
      externalKey: expr("externalKey", "external-reference", ["external-reference"]),
      sourceUrl: expr("sourceUrl", "operations", ["source-payload"]),
      sourceUpdatedAt: optionalExpr("releaseDate", "catalog-truth", ["normalized-observation"]),
      sourcePayload: expr(".", "catalog-merge-evidence", ["source-payload"]),
    },
    normalizedObservation: {
      outputKind: "provider-product",
      languageCode: constantExpr("en", "catalog-truth", ["normalized-observation", "hash-material"]),
      fields: {
        name: expr("productName", "catalog-truth", ["normalized-observation", "hash-material"]),
        setName: expr("setName", "catalog-truth", ["normalized-observation", "hash-material"]),
        expansionName: expr("setName", "catalog-truth", ["normalized-observation", "hash-material"]),
        cardNumber: expr("customAttributes.number", "catalog-truth", ["normalized-observation", "hash-material"]),
        imageUrls: constantExpr([], "catalog-truth", ["normalized-observation"]),
        providerProductId: expr("productId", "external-reference", ["normalized-observation", "hash-material"], {
          transforms: [{ kind: "coerce", to: "string" }],
        }),
        providerProductName: expr("productName", "catalog-truth", ["normalized-observation"]),
        productLineName: expr("productLineName", "catalog-merge-evidence", ["normalized-observation"]),
        productCategoryName: expr("productTypeName", "catalog-merge-evidence", ["normalized-observation"]),
        skuReferences: constantExpr([], "external-reference", ["normalized-observation"]),
        externalCatalogItemReferences: constantExpr(
          [{ providerKey: "tcgplayer", externalKey: "product:610001" }],
          "external-reference",
          ["normalized-observation", "external-reference"],
        ),
      },
      hashMaterial: [expr("catalogHashMaterial", "catalog-truth", ["hash-material"])],
      mergeIdentity: [],
    },
  };
}

function yugiohCardPrintContract(): CatalogProviderSourceObservationMappingContract {
  return {
    ...baseContract(),
    providerKey: "ygoprodeck",
    profileKey: "ygoprodeck-yugioh-card-print",
    displayName: "YGOPRODeck Yu-Gi-Oh Card Print",
    sourceObservation: {
      observationId: expr("observationId", "catalog-merge-evidence", ["normalized-observation"]),
      externalKey: expr("externalKey", "external-reference", ["external-reference"]),
      sourceUrl: expr("sourceUrl", "operations", ["source-payload"]),
      sourceUpdatedAt: optionalExpr("sourceUpdatedAt", "catalog-truth", ["normalized-observation"]),
      sourcePayload: expr(".", "catalog-merge-evidence", ["source-payload"]),
    },
    normalizedObservation: {
      outputKind: "yugioh-card-print",
      languageCode: constantExpr("en", "catalog-truth", ["normalized-observation", "hash-material"]),
      fields: {
        tcg: constantExpr("yugioh", "catalog-truth", ["normalized-observation", "hash-material"]),
        name: expr("name", "catalog-truth", ["normalized-observation", "hash-material"]),
        cardNumber: expr("selectedPrint.set_code", "catalog-truth", ["normalized-observation", "hash-material"]),
        passcode: expr("passcode", "catalog-truth", ["normalized-observation", "hash-material"]),
        setCode: expr("selectedPrint.set_code", "catalog-truth", ["normalized-observation", "hash-material"]),
        setName: expr("selectedPrint.set_name", "catalog-truth", ["normalized-observation", "hash-material"]),
        expansionName: expr("selectedPrint.set_name", "catalog-truth", ["normalized-observation", "hash-material"]),
        rarity: expr("selectedPrint.set_rarity", "catalog-truth", ["normalized-observation", "hash-material"]),
        cardType: expr("type", "catalog-truth", ["normalized-observation", "hash-material"]),
        attribute: optionalExpr("attribute", "catalog-truth", ["normalized-observation", "hash-material"]),
        archetype: optionalExpr("archetype", "catalog-truth", ["normalized-observation", "hash-material"]),
        releaseDate: optionalExpr("sourceUpdatedAt", "catalog-truth", ["normalized-observation", "hash-material"]),
        imageUrls: constantExpr(["https://images.ygoprodeck.com/images/cards/89631139.jpg"], "catalog-truth", [
          "normalized-observation",
        ]),
        externalCatalogItemReferences: constantExpr(
          [{ providerKey: "ygoprodeck", externalKey: "card:89631139" }],
          "external-reference",
          ["normalized-observation", "external-reference"],
        ),
      },
      hashMaterial: [expr("catalogHashMaterial", "catalog-truth", ["hash-material"])],
      mergeIdentity: [],
    },
  };
}

function baseContract(): Omit<CatalogProviderExecutableMappingContract, "sourceObservation" | "normalizedObservation"> {
  return {
    providerKey: "tcgplayer",
    profileKey: "tcgplayer-test",
    displayName: "TCGplayer Test",
    profileVersion: "2026.06.03",
    lifecycle: "test",
    sourceContract: {
      owner: "Catalog",
      repository: null,
      commit: null,
      documentPath: "bounded-contexts/catalog/docs/provider-integration-mapping-contract.md",
      fixtureSetVersion: "test",
    },
    connector: {
      kind: "tcgplayer-automation-client",
      transportOwns: ["raw-provider-parse"],
      mappingOwns: ["normalized-observation", "hash-material", "merge-identity"],
    },
    fixtures: {
      fixtureRoot: "bounded-contexts/catalog/features/source-observations/api/__fixtures__/tcgplayer",
      coveredFlows: [
        "normal",
        "partial",
        "stale",
        "changed",
        "ambiguous",
        "replay",
        "sealed-product",
        "unknown-option",
      ],
      liveProviderCallsAllowed: false,
    },
    externalReferences: [],
    referenceHierarchy: [],
    duplicatePrevention: {
      exactExternalCatalogItemReferencesFirst: true,
      mergeCandidateEvidence: [],
      identityRules: [],
      ambiguousCandidatePolicy: "block-promotion",
      replayPolicy: "same-profile-version",
    },
    promotionCommandPlan: {
      planKind: "catalog-item-promotion",
      requiresReview: true,
      commands: [],
    },
    nonGoals: [
      "no-live-provider-calls-in-mapping-tests",
      "no-pricing-facts-as-catalog-truth",
      "no-inventory-facts-as-global-catalog-truth",
      "no-provider-secrets-in-events-logs-or-fixtures",
      "no-provider-transport-branches-in-mapping-interpreter",
    ],
  };
}

function expr(
  path: string,
  owner: CatalogProviderMappingEvidenceOwner,
  uses: readonly CatalogProviderMappingEvidenceUse[],
  options: Partial<Pick<CatalogProviderMappingValueExpression, "transforms" | "redaction">> = {},
): CatalogProviderMappingValueExpression {
  return {
    selector: {
      kind: "path",
      path,
      required: true,
      nullPolicy: "diagnostic",
    },
    transforms: options.transforms,
    owner,
    uses,
    redaction: options.redaction ?? "none",
  };
}

function optionalExpr(
  path: string,
  owner: CatalogProviderMappingEvidenceOwner,
  uses: readonly CatalogProviderMappingEvidenceUse[],
): CatalogProviderMappingValueExpression {
  return {
    selector: {
      kind: "path",
      path,
      required: false,
      nullPolicy: "allow-null",
    },
    owner,
    uses,
    redaction: "none",
  };
}

function constantExpr(
  value: JsonValue,
  owner: CatalogProviderMappingEvidenceOwner,
  uses: readonly CatalogProviderMappingEvidenceUse[],
): CatalogProviderMappingValueExpression {
  return {
    selector: {
      kind: "constant",
      value,
    },
    owner,
    uses,
    redaction: "none",
  };
}
