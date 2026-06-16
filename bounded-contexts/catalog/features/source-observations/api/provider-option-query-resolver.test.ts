import { describe, expect, it } from "vitest";
import {
  tcgdexPokemonTcgProviderProfile,
  tcgplayerAutomationClientProviderProfile,
  type CatalogProviderIntegrationProfile,
} from "./provider-integration-profiles";
import { listCatalogProviderIntegrationOptionsFromProfiles } from "./provider-option-query-resolver";

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
      ["tcgplayer", "TCGplayer", "providers"],
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

    await expect(
      listCatalogProviderIntegrationOptionsFromProfiles({
        profiles: [tcgplayerAutomationClientProviderProfile],
        providerKey: "tcgplayer",
        queryKind: "set-names",
        defaultProviderKey: "tcgdex",
        transports: {},
      }),
    ).rejects.toThrow("TCGplayer set-name option queries require a productLineId/categoryId parent value.");
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
});
