import { describe, expect, it } from "vitest";
import {
  lorcanajsonLorcanaCardReferenceProviderProfile,
  lorcastLorcanaCardReferenceProviderProfile,
  mtgjsonMtgCardReferenceProviderProfile,
  scrydexOnePieceConnectorProfile,
  tcgdexPokemonTcgProviderProfile,
  tcgplayerAutomationClientProviderProfile,
  type CatalogProviderIntegrationProfile,
} from "../provider-integration-profiles";
import {
  CatalogProviderOptionQueryInvalidRequestError,
  listCatalogProviderIntegrationOptionsFromProfiles,
} from "./provider-option-query-resolver";

describe("listCatalogProviderIntegrationOptionsFromProfiles", () => {
  it("maps provider list options from profile config", async () => {
    const options = await listCatalogProviderIntegrationOptionsFromProfiles({
      profiles: [tcgdexPokemonTcgProviderProfile, tcgplayerAutomationClientProviderProfile],
      providerKey: "tcgdex",
      queryKind: "provider",
      defaultProviderKey: "tcgdex",
      transports: {},
    });

    expect(options.map((option) => [option.value, option.label, option.queryKind])).toEqual([
      ["tcgdex", "TCGdex", "providers"],
      ["tcgplayer", "TCGplayer Pokemon Single Cards", "providers"],
    ]);
  });

  it("maps TCGdex language, series, and expansion options through profile selectors", async () => {
    const transports = {
      listTcgdexLanguages: async () => [{ languageCode: "en" }],
      listTcgdexSeries: async ({ languageCode }: { languageCode: string }) => [
        { seriesId: "swsh", name: "Sword & Shield", logoUrl: "https://img.example/swsh.png", languageCode },
      ],
      listTcgdexExpansions: async () => [
        {
          expansionId: "swsh1",
          name: "Sword & Shield",
          seriesId: "swsh",
          seriesName: "Sword & Shield",
          logoUrl: "https://img.example/logo.png",
          symbolUrl: "https://img.example/symbol.png",
          cardCount: 216,
          officialCardCount: 202,
        },
      ],
    };

    await expect(
      listCatalogProviderIntegrationOptionsFromProfiles({
        profiles: [tcgdexPokemonTcgProviderProfile],
        providerKey: "tcgdex",
        queryKind: "language",
        defaultProviderKey: "tcgdex",
        transports,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        providerKey: "tcgdex",
        queryKind: "languages",
        value: "en",
        label: "en",
      }),
    ]);

    await expect(
      listCatalogProviderIntegrationOptionsFromProfiles({
        profiles: [tcgdexPokemonTcgProviderProfile],
        providerKey: "tcgdex",
        queryKind: "series",
        languageCode: "en",
        defaultProviderKey: "tcgdex",
        transports,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        value: "swsh",
        label: "Sword & Shield",
        parentValue: "en",
        imageUrl: "https://img.example/swsh.png",
        metadata: expect.objectContaining({ languageCode: "en", seriesId: "swsh" }),
      }),
    ]);

    await expect(
      listCatalogProviderIntegrationOptionsFromProfiles({
        profiles: [tcgdexPokemonTcgProviderProfile],
        providerKey: "tcgdex",
        queryKind: "expansion",
        languageCode: "en",
        parentValue: "swsh",
        defaultProviderKey: "tcgdex",
        transports,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        queryKind: "expansions",
        value: "swsh1",
        description: "Sword & Shield - 202 official cards",
        parentValue: "swsh",
        imageUrl: "https://img.example/symbol.png",
      }),
    ]);
  });

  it("maps typed option aliases from the record onto the resolved option", async () => {
    const transports = {
      listTcgdexSeries: async ({ languageCode }: { languageCode: string }) => [
        {
          seriesId: "SV",
          name: "ポケモンカードゲーム スカーレット&バイオレット",
          languageCode,
          aliases: [
            {
              aliasText: "Scarlet & Violet",
              aliasLanguageCode: "en",
              aliasType: "series-equivalent",
              confidence: "high",
              reviewStatus: "pending",
              sourceCategory: "provider-same-id-localized-endpoint",
              evidence: { providerId: "SV" },
            },
            // Malformed alias entries are dropped, never coerced.
            { aliasText: "broken" },
          ],
        },
      ],
    };

    const [option] = await listCatalogProviderIntegrationOptionsFromProfiles({
      profiles: [tcgdexPokemonTcgProviderProfile],
      providerKey: "tcgdex",
      queryKind: "series",
      languageCode: "ja",
      defaultProviderKey: "tcgdex",
      transports,
    });

    expect(option.value).toBe("SV");
    expect(option.label).toBe("ポケモンカードゲーム スカーレット&バイオレット");
    expect(option.aliases).toEqual([
      {
        aliasText: "Scarlet & Violet",
        aliasLanguageCode: "en",
        aliasType: "series-equivalent",
        confidence: "high",
        reviewStatus: "pending",
        sourceCategory: "provider-same-id-localized-endpoint",
        evidence: { providerId: "SV" },
      },
    ]);
    // The semantic English signal must not leak into metadata.
    expect(option.metadata.aliases).toBeUndefined();
  });

  it("maps TCGplayer product-line and set-name options through profile selectors", async () => {
    const transports = {
      listTcgplayerProductLines: async () => [
        { productLineId: 3, productLineName: "Pokemon", productLineUrlName: "pokemon", isDirect: true },
      ],
      listTcgplayerSetNames: async () => [
        {
          setNameId: 7001,
          categoryId: 3,
          cleanSetName: "Prismatic Evolutions",
          name: "Prismatic Evolutions",
          urlName: "prismatic-evolutions",
          abbreviation: "PRE",
          releaseDate: "2025-01-17",
          isSupplemental: false,
          active: true,
        },
      ],
      listTcgplayerProducts: async () => [
        {
          productId: 610001,
          productName: "Eevee ex",
        },
      ],
      listTcgplayerSkus: async () => [
        {
          sku: 7001001,
        },
      ],
    };

    await expect(
      listCatalogProviderIntegrationOptionsFromProfiles({
        profiles: [tcgplayerAutomationClientProviderProfile],
        providerKey: "tcgplayer",
        queryKind: "categories",
        defaultProviderKey: "tcgdex",
        transports,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        queryKind: "product-lines",
        value: "3",
        label: "Pokemon",
        metadata: expect.objectContaining({ productLineId: 3 }),
      }),
    ]);

    await expect(
      listCatalogProviderIntegrationOptionsFromProfiles({
        profiles: [tcgplayerAutomationClientProviderProfile],
        providerKey: "tcgplayer",
        queryKind: "sets",
        parentValue: "3",
        defaultProviderKey: "tcgdex",
        transports,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        queryKind: "set-names",
        value: "Prismatic Evolutions",
        description: "PRE - 2025-01-17",
        parentValue: "3",
        metadata: expect.objectContaining({ productLineId: 3, setNameId: 7001 }),
      }),
    ]);

    await expect(
      listCatalogProviderIntegrationOptionsFromProfiles({
        profiles: [tcgplayerAutomationClientProviderProfile],
        providerKey: "tcgplayer",
        queryKind: "products",
        parentValue: "Prismatic Evolutions",
        defaultProviderKey: "tcgdex",
        transports,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        queryKind: "products",
        value: "610001",
        label: "Eevee ex",
        metadata: expect.objectContaining({ productId: 610001 }),
      }),
    ]);

    await expect(
      listCatalogProviderIntegrationOptionsFromProfiles({
        profiles: [tcgplayerAutomationClientProviderProfile],
        providerKey: "tcgplayer",
        queryKind: "skus",
        parentValue: "610001",
        defaultProviderKey: "tcgdex",
        transports,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        queryKind: "skus",
        value: "7001001",
        label: "7001001",
        metadata: expect.objectContaining({ sku: 7001001 }),
      }),
    ]);
  });

  it("maps MTGJSON set and card options through profile selectors", async () => {
    const transports = {
      listMtgjsonSets: async () => [
        {
          setCode: "TSP",
          name: "Time Spiral",
          releaseDate: "2006-10-06",
          totalSetSize: 301,
          type: "expansion",
          mtgjsonVersion: "5.3.0+20260605",
        },
      ],
      listMtgjsonCards: async ({ setCode }: { setCode: string | null }) => [
        {
          cardId: "13fd9d47-9aa7-5f7c-8f47-fury-sliver",
          name: "Fury Sliver #157",
          setCode,
          setName: "Time Spiral",
          collectorNumber: "157",
          rarity: "uncommon",
          layout: "normal",
          scryfallId: "0000579f-7b35-4ed3-b44c-db2a538066fe",
        },
      ],
    };

    await expect(
      listCatalogProviderIntegrationOptionsFromProfiles({
        profiles: [mtgjsonMtgCardReferenceProviderProfile],
        providerKey: "mtgjson",
        queryKind: "sets",
        defaultProviderKey: "tcgdex",
        transports,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        providerKey: "mtgjson",
        queryKind: "sets",
        value: "TSP",
        label: "Time Spiral",
        description: "2006-10-06",
        metadata: expect.objectContaining({ totalSetSize: 301, mtgjsonVersion: "5.3.0+20260605" }),
      }),
    ]);

    await expect(
      listCatalogProviderIntegrationOptionsFromProfiles({
        profiles: [mtgjsonMtgCardReferenceProviderProfile],
        providerKey: "mtgjson",
        queryKind: "cards",
        parentValue: "TSP",
        defaultProviderKey: "tcgdex",
        transports,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        providerKey: "mtgjson",
        queryKind: "cards",
        value: "13fd9d47-9aa7-5f7c-8f47-fury-sliver",
        label: "Fury Sliver #157",
        parentValue: "TSP",
        metadata: expect.objectContaining({
          collectorNumber: "157",
          scryfallId: "0000579f-7b35-4ed3-b44c-db2a538066fe",
        }),
      }),
    ]);
  });

  it("maps LorcanaJSON set and card options through profile selectors", async () => {
    const transports = {
      listLorcanajsonSets: async () => [
        {
          setId: "1",
          setCode: "1",
          name: "The First Chapter",
          releaseDate: "2023-08-18",
          cardCount: 204,
          formatVersion: "2.3.2",
          generatedOn: "2026-05-26T19:11:58",
        },
      ],
      listLorcanajsonCards: async ({ setCode }: { setCode: string | null }) => [
        {
          cardId: "1-041",
          name: "Elsa - Snow Queen #41",
          setCode,
          setName: "The First Chapter",
          cardNumber: "41",
          rarity: "Super Rare",
          cardType: "Storyborn Hero Queen",
          inkColor: "Amethyst",
          tcgplayerProductId: "1005010",
          imageUrl: "https://images.lorcanajson.org/cards/en/1/041.webp",
        },
      ],
    };

    await expect(
      listCatalogProviderIntegrationOptionsFromProfiles({
        profiles: [lorcanajsonLorcanaCardReferenceProviderProfile],
        providerKey: "lorcanajson",
        queryKind: "sets",
        defaultProviderKey: "tcgdex",
        transports,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        providerKey: "lorcanajson",
        queryKind: "sets",
        value: "1",
        label: "The First Chapter",
        description: "2023-08-18",
        metadata: expect.objectContaining({ cardCount: 204, formatVersion: "2.3.2" }),
      }),
    ]);

    await expect(
      listCatalogProviderIntegrationOptionsFromProfiles({
        profiles: [lorcanajsonLorcanaCardReferenceProviderProfile],
        providerKey: "lorcanajson",
        queryKind: "cards",
        parentValue: "1",
        defaultProviderKey: "tcgdex",
        transports,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        providerKey: "lorcanajson",
        queryKind: "cards",
        value: "1-041",
        label: "Elsa - Snow Queen #41",
        parentValue: "1",
        imageUrl: "https://images.lorcanajson.org/cards/en/1/041.webp",
        metadata: expect.objectContaining({
          cardNumber: "41",
          inkColor: "Amethyst",
          tcgplayerProductId: "1005010",
        }),
      }),
    ]);
  });

  it("maps Lorcast set and card options through profile selectors", async () => {
    const transports = {
      listLorcastSets: async () => [
        {
          setId: "set_7ecb0e0c71af496a9e0110e23824e0a5",
          setCode: "1",
          name: "The First Chapter",
          releaseDate: "2023-08-18",
          prereleaseDate: "2023-08-18",
          cacheGuidance: "cache-at-least-24h",
        },
      ],
      listLorcastCards: async ({ setCode }: { setCode: string | null }) => [
        {
          cardId: "crd_elsa_snow_queen_1_041",
          name: "Elsa - Snow Queen #41",
          setId: "set_7ecb0e0c71af496a9e0110e23824e0a5",
          setCode,
          setName: "The First Chapter",
          cardNumber: "41",
          rarity: "Super Rare",
          cardType: "Character",
          inkColor: "Amethyst",
          tcgplayerProductId: "1005010",
          imageUrl: "https://cards.lorcast.io/card/digital/large/crd_elsa_snow_queen_1_041.avif",
          releaseDate: "2023-08-18",
        },
      ],
    };

    await expect(
      listCatalogProviderIntegrationOptionsFromProfiles({
        profiles: [lorcastLorcanaCardReferenceProviderProfile],
        providerKey: "lorcast",
        queryKind: "sets",
        defaultProviderKey: "tcgdex",
        transports,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        providerKey: "lorcast",
        queryKind: "sets",
        value: "1",
        label: "The First Chapter",
        description: "2023-08-18",
        metadata: expect.objectContaining({ cacheGuidance: "cache-at-least-24h" }),
      }),
    ]);

    await expect(
      listCatalogProviderIntegrationOptionsFromProfiles({
        profiles: [lorcastLorcanaCardReferenceProviderProfile],
        providerKey: "lorcast",
        queryKind: "cards",
        parentValue: "1",
        defaultProviderKey: "tcgdex",
        transports,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        providerKey: "lorcast",
        queryKind: "cards",
        value: "crd_elsa_snow_queen_1_041",
        label: "Elsa - Snow Queen #41",
        parentValue: "1",
        imageUrl: "https://cards.lorcast.io/card/digital/large/crd_elsa_snow_queen_1_041.avif",
        metadata: expect.objectContaining({
          cardNumber: "41",
          inkColor: "Amethyst",
          tcgplayerProductId: "1005010",
        }),
      }),
    ]);
  });

  it("generates unsupported query and parent validation errors from profile data", async () => {
    await expect(
      listCatalogProviderIntegrationOptionsFromProfiles({
        profiles: [tcgplayerAutomationClientProviderProfile],
        providerKey: "tcgplayer",
        queryKind: "unknown",
        defaultProviderKey: "tcgdex",
        transports: {},
      }),
    ).rejects.toThrow(
      "Unsupported Catalog integration query 'unknown' for provider 'tcgplayer'. Supported queries: product-lines, set-names, products, skus.",
    );

    let parentValidationError: unknown;
    try {
      await listCatalogProviderIntegrationOptionsFromProfiles({
        profiles: [tcgplayerAutomationClientProviderProfile],
        providerKey: "tcgplayer",
        queryKind: "set-names",
        defaultProviderKey: "tcgdex",
        transports: {},
      });
    } catch (error) {
      parentValidationError = error;
    }
    expect(parentValidationError).toBeInstanceOf(CatalogProviderOptionQueryInvalidRequestError);
    expect(parentValidationError).toMatchObject({
      name: "CatalogProviderOptionQueryInvalidRequestError",
      code: "catalog_provider_option_query_parent_required",
      message: "TCGplayer set-name option queries require a productLineId/categoryId parent value.",
    });
  });

  it("can add a Scrydex-style option query without runtime provider branching", async () => {
    const scrydexProfile = {
      ...tcgdexPokemonTcgProviderProfile,
      providerKey: "scrydex",
      displayName: "Scrydex",
      optionQueries: [
        {
          queryKind: "sets",
          queryKeySynonyms: ["expansions"],
          displayName: "Set",
          scope: "expansion",
          parentScope: null,
          operation: "scrydex-list-sets",
          output: {
            valuePath: "id",
            labelPath: "name",
            metadataPaths: { setId: "id", code: "code" },
          },
        },
      ],
    } satisfies CatalogProviderIntegrationProfile;

    await expect(
      listCatalogProviderIntegrationOptionsFromProfiles({
        profiles: [scrydexProfile],
        providerKey: "scrydex",
        queryKind: "expansions",
        defaultProviderKey: "tcgdex",
        transports: {
          listScrydexSets: async () => [{ id: "sv1", name: "Scarlet & Violet", code: "SVI" }],
        },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        providerKey: "scrydex",
        queryKind: "sets",
        value: "sv1",
        label: "Scarlet & Violet",
        metadata: { setId: "sv1", code: "SVI" },
      }),
    ]);
  });

  it("maps Scrydex One Piece set, card, and sealed-product selectors through injected bulk transports", async () => {
    const seenParents: Array<string | null> = [];
    const scrydexOnePieceProfile: CatalogProviderIntegrationProfile = {
      ...tcgdexPokemonTcgProviderProfile,
      providerKey: "scrydex",
      displayName: "Scrydex One Piece",
      status: "planned",
      supportedScopes: ["set-name", "product/card", "product"],
      connector: scrydexOnePieceConnectorProfile,
      normalizedObservationMapping: {
        ...tcgdexPokemonTcgProviderProfile.normalizedObservationMapping,
        kind: "provider-product",
      },
      optionQueries: [
        {
          queryKind: "sets",
          queryKeySynonyms: ["set"],
          displayName: "Set",
          scope: "set-name",
          parentScope: null,
          operation: "scrydex-one-piece-list-sets",
          output: {
            valuePath: "setId",
            labelPath: "name",
            description: { kind: "path", path: "releaseDate" },
            metadataPaths: {
              setId: "setId",
              setCode: "setCode",
              estimatedRequestCount: "usage.estimatedRequestCount",
            },
          },
        },
        {
          queryKind: "cards",
          queryKeySynonyms: ["card"],
          displayName: "Card",
          scope: "product/card",
          parentScope: "set-name",
          operation: "scrydex-one-piece-list-cards",
          parentValue: {
            required: true,
            valueKind: "set-code",
            diagnosticText: "Scrydex One Piece card option queries require a selected set.",
          },
          output: {
            valuePath: "cardId",
            labelPath: "name",
            parentValuePath: "$parentValue",
            metadataPaths: { setId: "$parentValue", cardNumber: "cardNumber", variantCount: "variantCount" },
          },
        },
        {
          queryKind: "sealed-products",
          queryKeySynonyms: ["sealed-products"],
          displayName: "Sealed Product",
          scope: "product",
          parentScope: "set-name",
          operation: "scrydex-one-piece-list-sealed-products",
          parentValue: {
            required: true,
            valueKind: "set-code",
            diagnosticText: "Scrydex One Piece sealed-product option queries require a selected set.",
          },
          output: {
            valuePath: "sealedProductId",
            labelPath: "name",
            parentValuePath: "$parentValue",
            metadataPaths: { setId: "$parentValue", packageForm: "packageForm" },
          },
        },
      ],
    };

    const transports = {
      listScrydexOnePieceSets: async () => [
        {
          setId: "op-01",
          setCode: "OP-01",
          name: "Romance Dawn",
          releaseDate: "2022-12-02",
          usage: { estimatedRequestCount: 1 },
        },
      ],
      listScrydexOnePieceCards: async ({ setId }: { setId: string | null }) => {
        seenParents.push(setId);
        return [{ cardId: "op01-001", name: "Monkey.D.Luffy", cardNumber: "OP01-001", variantCount: 2 }];
      },
      listScrydexOnePieceSealedProducts: async ({ setId }: { setId: string | null }) => {
        seenParents.push(setId);
        return [{ sealedProductId: "op01-booster-box", name: "Romance Dawn Booster Box", packageForm: "booster-box" }];
      },
    };

    await expect(
      listCatalogProviderIntegrationOptionsFromProfiles({
        profiles: [scrydexOnePieceProfile],
        providerKey: "scrydex",
        queryKind: "sets",
        defaultProviderKey: "tcgdex",
        transports,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        providerKey: "scrydex",
        queryKind: "sets",
        value: "op-01",
        label: "Romance Dawn",
        metadata: expect.objectContaining({ estimatedRequestCount: 1, setCode: "OP-01" }),
      }),
    ]);

    await expect(
      listCatalogProviderIntegrationOptionsFromProfiles({
        profiles: [scrydexOnePieceProfile],
        providerKey: "scrydex",
        queryKind: "card",
        parentValue: "op-01",
        defaultProviderKey: "tcgdex",
        transports,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        value: "op01-001",
        label: "Monkey.D.Luffy",
        parentValue: "op-01",
        metadata: expect.objectContaining({ setId: "op-01", variantCount: 2 }),
      }),
    ]);

    await expect(
      listCatalogProviderIntegrationOptionsFromProfiles({
        profiles: [scrydexOnePieceProfile],
        providerKey: "scrydex",
        queryKind: "sealed-products",
        parentValue: "op-01",
        defaultProviderKey: "tcgdex",
        transports,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        value: "op01-booster-box",
        label: "Romance Dawn Booster Box",
        metadata: expect.objectContaining({ packageForm: "booster-box" }),
      }),
    ]);
    expect(seenParents).toEqual(["op-01", "op-01"]);
  });

  it("resolves TCGplayer One Piece options through the existing product-line scoped operations", async () => {
    const transports = {
      listTcgplayerProductLines: async () => [
        { productLineId: 68, productLineName: "One Piece Card Game", productLineUrlName: "one-piece-card-game" },
      ],
      listTcgplayerSetNames: async ({ productLineId }: { productLineId: number }) => [
        {
          setNameId: 68001,
          categoryId: productLineId,
          cleanSetName: "Romance Dawn",
          name: "Romance Dawn",
          urlName: "romance-dawn",
          abbreviation: "OP-01",
          releaseDate: "2022-12-02",
          active: true,
        },
      ],
      listTcgplayerProducts: async ({ setName }: { setName: string }) => [
        { productId: 900001, productName: `Monkey.D.Luffy - ${setName}` },
      ],
      listTcgplayerSkus: async () => [{ sku: 90000101 }],
    };

    await expect(
      listCatalogProviderIntegrationOptionsFromProfiles({
        profiles: [tcgplayerAutomationClientProviderProfile],
        providerKey: "tcgplayer",
        queryKind: "product-lines",
        defaultProviderKey: "tcgdex",
        transports,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        value: "68",
        label: "One Piece Card Game",
        metadata: expect.objectContaining({ productLineId: 68 }),
      }),
    ]);

    await expect(
      listCatalogProviderIntegrationOptionsFromProfiles({
        profiles: [tcgplayerAutomationClientProviderProfile],
        providerKey: "tcgplayer",
        queryKind: "sets",
        parentValue: "68",
        defaultProviderKey: "tcgdex",
        transports,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        value: "Romance Dawn",
        label: "Romance Dawn",
        parentValue: "68",
        metadata: expect.objectContaining({ productLineId: 68, setNameId: 68001 }),
      }),
    ]);

    await expect(
      listCatalogProviderIntegrationOptionsFromProfiles({
        profiles: [tcgplayerAutomationClientProviderProfile],
        providerKey: "tcgplayer",
        queryKind: "products",
        parentValue: "Romance Dawn",
        defaultProviderKey: "tcgdex",
        transports,
      }),
    ).resolves.toEqual([expect.objectContaining({ value: "900001", label: "Monkey.D.Luffy - Romance Dawn" })]);

    await expect(
      listCatalogProviderIntegrationOptionsFromProfiles({
        profiles: [tcgplayerAutomationClientProviderProfile],
        providerKey: "tcgplayer",
        queryKind: "skus",
        parentValue: "900001",
        defaultProviderKey: "tcgdex",
        transports,
      }),
    ).resolves.toEqual([expect.objectContaining({ value: "90000101", label: "90000101" })]);
  });

  it("maps Yu-Gi-Oh provider set and card selectors through the same option-query path", async () => {
    const yugiohProfile = {
      ...tcgdexPokemonTcgProviderProfile,
      providerKey: "ygoprodeck",
      displayName: "YGOPRODeck",
      status: "active",
      supportedScopes: ["set-name", "product/card"],
      optionQueries: [
        {
          queryKind: "sets",
          queryKeySynonyms: ["set"],
          displayName: "Set",
          scope: "set-name",
          parentScope: null,
          operation: "ygoprodeck-list-sets",
          output: {
            valuePath: "setName",
            labelPath: "setName",
            description: { kind: "path", path: "releaseDate" },
            metadataPaths: { setName: "setName", setCode: "setCode", cardCount: "cardCount" },
          },
        },
        {
          queryKind: "cards",
          queryKeySynonyms: ["card"],
          displayName: "Card",
          scope: "product/card",
          parentScope: "set-name",
          operation: "ygoprodeck-list-cards",
          parentValue: {
            required: true,
            valueKind: "set-code",
            diagnosticText: "YGOPRODeck card option queries require a selected set name or set code.",
          },
          output: {
            valuePath: "cardPrintId",
            labelPath: "name",
            parentValuePath: "setName",
            metadataPaths: { cardId: "cardId", setName: "setName", setCode: "setCode", rarity: "rarity" },
          },
        },
      ] as const,
      connector: {
        kind: "ygoprodeck-json",
        baseUrl: "https://db.ygoprodeck.com/api/v7",
        sourceContractDocument: "bounded-contexts/catalog/docs/provider-integration-profiles.md",
        authentication: { scheme: "public-api", credentialsRequired: false, userAgentRequired: true },
        throttling: {
          providerLimit: "20-requests-per-second",
          cacheProviderDataLocally: true,
          cacheImagesLocally: true,
        },
        acceptedEvidence: ["ygoprodeck-card-id", "passcode", "set-code", "set-name", "rarity"],
        excludedEvidence: ["price", "seller", "inventory", "order", "message", "image-hotlink"],
        assetPolicy: { hotlinkingAllowed: false, requiresCatalogAssetStorage: true },
      },
      normalizedObservationMapping: {
        ...tcgdexPokemonTcgProviderProfile.normalizedObservationMapping,
        kind: "yugioh-card-print",
      },
    } satisfies CatalogProviderIntegrationProfile;

    await expect(
      listCatalogProviderIntegrationOptionsFromProfiles({
        profiles: [yugiohProfile],
        providerKey: "ygoprodeck",
        queryKind: "set",
        defaultProviderKey: "tcgdex",
        transports: {
          listYgoprodeckSets: async () => [
            {
              setName: "Legend of Blue Eyes White Dragon",
              setCode: "LOB",
              releaseDate: "2002-03-08",
              cardCount: 126,
            },
          ],
        },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        providerKey: "ygoprodeck",
        queryKind: "sets",
        value: "Legend of Blue Eyes White Dragon",
        label: "Legend of Blue Eyes White Dragon",
        description: "2002-03-08",
        metadata: expect.objectContaining({ setCode: "LOB", cardCount: 126 }),
      }),
    ]);

    await expect(
      listCatalogProviderIntegrationOptionsFromProfiles({
        profiles: [yugiohProfile],
        providerKey: "ygoprodeck",
        queryKind: "card",
        parentValue: "Legend of Blue Eyes White Dragon",
        defaultProviderKey: "tcgdex",
        transports: {
          listYgoprodeckCards: async ({ setCode }: { setCode: string | null }) => [
            {
              cardPrintId: "89631139:LOB-001",
              cardId: "89631139",
              name: "Blue-Eyes White Dragon",
              setName: setCode,
              setCode: "LOB-001",
              rarity: "Ultra Rare",
            },
          ],
        },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        providerKey: "ygoprodeck",
        queryKind: "cards",
        value: "89631139:LOB-001",
        label: "Blue-Eyes White Dragon",
        parentValue: "Legend of Blue Eyes White Dragon",
        metadata: expect.objectContaining({ cardId: "89631139", rarity: "Ultra Rare" }),
      }),
    ]);
  });
});
