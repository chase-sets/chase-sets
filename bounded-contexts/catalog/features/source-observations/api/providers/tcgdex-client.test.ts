import { describe, expect, it } from "vitest";
import {
  fetchTcgdexEnglishMirrorEntity,
  fetchTcgdexExpansionOptions,
  fetchTcgdexSeriesOptions,
  fetchTcgdexSetObservationPayloads,
  listTcgdexLanguageOptions,
  normalizeTcgdexImageAsset,
  type TcgdexObservationPayload,
} from "./tcgdex-client";
import {
  requireCatalogProviderSourceObservationMappingContract,
  tcgdexPokemonTcgProviderProfile,
} from "../provider-integration-profiles";
import { requireCatalogProviderSourceObservation } from "../promotion/provider-source-observation-normalizer";

const testImageProcessor = {
  async metadata() {
    return { width: 734, height: 1024 };
  },
  async normalizeDisplaySource(body: Uint8Array) {
    return body.slice(1);
  },
  async resizeToWebp(input: { body: Uint8Array; width: number; quality: number }) {
    return {
      body: new Uint8Array([input.width % 251, input.quality, input.body.byteLength]),
      width: input.width,
      height: Math.round(input.width * 1.4),
    };
  },
};

describe("TCGdex client", () => {
  it("preloads supported language options from the Catalog-owned allowlist", () => {
    expect(listTcgdexLanguageOptions(tcgdexPokemonTcgProviderProfile)).toEqual(
      expect.arrayContaining([{ languageCode: "en" }, { languageCode: "ja" }, { languageCode: "zh-tw" }]),
    );
  });

  it("normalizes TCGdex series and expansion metadata for import selection", async () => {
    const responses = new Map<string, unknown>([
      [
        "https://api.tcgdex.net/v2/en/series",
        [
          { id: "me", name: "Mega Evolution", logo: "https://assets.tcgdex.net/en/me/me01/logo" },
          { id: "sv", name: "Scarlet & Violet" },
        ],
      ],
      [
        "https://api.tcgdex.net/v2/en/series/me",
        {
          id: "me",
          name: "Mega Evolution",
          sets: [
            {
              id: "me02.5",
              name: "Ascended Heroes",
              logo: "https://assets.tcgdex.net/en/me/me02.5/logo",
              symbol: "https://assets.tcgdex.net/univ/me/me02.5/symbol",
              cardCount: { total: 295, official: 217 },
            },
          ],
        },
      ],
    ]);
    const fetcher: typeof globalThis.fetch = async (input) => {
      const response = responses.get(String(input));
      return response ? new Response(JSON.stringify(response), { status: 200 }) : new Response(null, { status: 404 });
    };

    await expect(
      fetchTcgdexSeriesOptions({ profile: tcgdexPokemonTcgProviderProfile, languageCode: "EN", fetch: fetcher }),
    ).resolves.toEqual([
      { seriesId: "me", name: "Mega Evolution", logoUrl: "https://assets.tcgdex.net/en/me/me01/logo" },
      { seriesId: "sv", name: "Scarlet & Violet", logoUrl: null },
    ]);
    await expect(
      fetchTcgdexExpansionOptions({
        profile: tcgdexPokemonTcgProviderProfile,
        languageCode: "en",
        seriesId: "ME",
        fetch: fetcher,
      }),
    ).resolves.toEqual([
      {
        expansionId: "me02.5",
        name: "Ascended Heroes",
        seriesId: "me",
        seriesName: "Mega Evolution",
        logoUrl: "https://assets.tcgdex.net/en/me/me02.5/logo",
        symbolUrl: "https://assets.tcgdex.net/univ/me/me02.5/symbol",
        cardCount: 295,
        officialCardCount: 217,
      },
    ]);
  });

  it("records provider image URLs for Source Observations without writing bucket assets", async () => {
    const requestedUrls: string[] = [];
    const responses = new Map<string, unknown>([
      [
        "https://api.tcgdex.net/v2/en/sets/swsh3",
        {
          id: "swsh3",
          name: "Darkness Ablaze",
          releaseDate: "2020-08-14",
          cardCount: { official: 189, reverse: 155, total: 201 },
          abbreviation: { official: "DAA" },
          serie: { id: "swsh", name: "Sword & Shield" },
          cards: [{ id: "swsh3-136", localId: "136", name: "Furret" }],
        },
      ],
      [
        "https://api.tcgdex.net/v2/en/cards/swsh3-136",
        {
          id: "swsh3-136",
          localId: "136",
          name: "Furret",
          image: "https://assets.tcgdex.net/en/swsh/swsh3/136",
          category: "Pokemon",
          illustrator: "tetsuya koizumi",
          rarity: "Uncommon",
          updated: "2026-05-15T00:00:00.000Z",
          set: { id: "swsh3", name: "Darkness Ablaze" },
          pricing: { tcgplayer: { updated: "2026-05-15T00:00:00.000Z" } },
          variants: { reverse: true, normal: true, holo: false },
        },
      ],
    ]);

    const fetcher: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      const response = responses.get(url);
      if (!response) {
        return new Response(null, { status: 404 });
      }

      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const observations = normalizeTcgdexObservationPayloads(
      await fetchTcgdexSetObservationPayloads({
        profile: tcgdexPokemonTcgProviderProfile,
        languageCode: "EN",
        setId: "SWSH3",
        fetch: fetcher,
      }),
    );

    expect(observations).toHaveLength(2);
    expect(observations[0]).toMatchObject({
      observationId: "tcgdex_en_swsh3_136",
      providerKey: "tcgdex",
      externalKey: "swsh3-136",
      sourceUrl: "https://api.tcgdex.net/v2/en/cards/swsh3-136",
      languageCode: "en",
      sourceUpdatedAt: "2026-05-15T00:00:00.000Z",
      normalized: {
        name: "Furret",
        cardNumber: "136",
        setId: "swsh3",
        setName: "Darkness Ablaze",
        expansionId: "swsh3",
        expansionName: "Darkness Ablaze",
        expansionAbbreviation: "DAA",
        expansionCardCount: 189,
        expansionParallelSetCardCount: 155,
        seriesName: "Sword & Shield",
        rarity: "Uncommon",
        illustrator: "tetsuya koizumi",
        releaseYear: 2020,
        imageUrls: ["https://assets.tcgdex.net/en/swsh/swsh3/136/high.webp"],
        mergeIdentity: {
          tcg: "pokemon",
          productLineName: "Pokemon",
          setName: "Darkness Ablaze",
          printedProductName: "Furret",
          collectorNumber: "136",
          languageCode: "en",
        },
        productAssetSet: null,
        parallelSet: false,
        cardVariantKey: "standard",
        cardVariantLabel: "Standard Set",
        cardVariantSourceKey: "normal",
        cardVariantIsPrimaryImage: true,
        imageDisclaimer: null,
      },
    });
    expect(observations[1]).toMatchObject({
      observationId: "tcgdex_en_swsh3_136_reverse_holo",
      externalKey: "swsh3-136:reverse-holo",
      normalized: {
        parallelSet: true,
        cardVariantKey: "reverse-holo",
        cardVariantLabel: "Parallel Set - Reverse Foil",
        cardVariantSourceKey: "reverse",
        cardVariantIsPrimaryImage: false,
        imageDisclaimer:
          "TCGDex provides one image for this card number. This Catalog Item represents the Parallel Set - Reverse Foil variant, so the image may not show the exact foil or pattern.",
      },
    });
    expect(requestedUrls).not.toContain("https://assets.tcgdex.net/en/swsh/swsh3/136/high.webp");
    expect(observations[0]?.sourceRecordHash).toHaveLength(64);
    expect(observations[0]?.sourcePayload).not.toHaveProperty("pricing");
  });

  it("uses the selected series as a reference fallback when set metadata omits serie", async () => {
    const responses = new Map<string, unknown>([
      [
        "https://api.tcgdex.net/v2/ja/sets/sv8",
        {
          id: "SV8",
          name: "Super Electric Breaker",
          cardCount: { official: 106, total: 106 },
          cards: [{ id: "SV8-001", localId: "001", name: "Pokemon A" }],
        },
      ],
      [
        "https://api.tcgdex.net/v2/ja/cards/SV8-001",
        {
          id: "SV8-001",
          localId: "001",
          name: "Pokemon A",
          image: "https://assets.tcgdex.net/ja/sv/sv8/001",
          category: "Pokemon",
          set: { id: "SV8", name: "Super Electric Breaker" },
          variants: { normal: true },
        },
      ],
    ]);
    const fetcher: typeof globalThis.fetch = async (input) => {
      const response = responses.get(String(input));
      return response ? new Response(JSON.stringify(response), { status: 200 }) : new Response(null, { status: 404 });
    };

    const observations = normalizeTcgdexObservationPayloads(
      await fetchTcgdexSetObservationPayloads({
        profile: tcgdexPokemonTcgProviderProfile,
        languageCode: "ja",
        seriesId: "SV",
        setId: "SV8",
        fetch: fetcher,
      }),
    );

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      observationId: "tcgdex_ja_sv8_001",
      languageCode: "ja",
      normalized: {
        setId: "SV8",
        expansionId: "SV8",
        seriesId: "sv",
      },
    });
  });

  it("uses Pokemon marketplace language for premium parallel variants", async () => {
    const responses = new Map<string, unknown>([
      [
        "https://api.tcgdex.net/v2/en/sets/sv4pt5",
        {
          id: "sv4pt5",
          name: "Scarlet & Violet - 151",
          cards: [{ id: "sv4pt5-025", localId: "025", name: "Pikachu" }],
        },
      ],
      [
        "https://api.tcgdex.net/v2/en/cards/sv4pt5-025",
        {
          id: "sv4pt5-025",
          localId: "025",
          name: "Pikachu",
          image: "https://assets.tcgdex.net/en/sv/sv4pt5/025",
          category: "Pokemon",
          set: { id: "sv4pt5", name: "Scarlet & Violet - 151" },
          variants: {
            normal: true,
            holo: true,
            pokeball: true,
            masterBall: true,
            confettiFoil: true,
          },
        },
      ],
    ]);
    const fetcher: typeof globalThis.fetch = async (input) => {
      const response = responses.get(String(input));
      return response ? new Response(JSON.stringify(response), { status: 200 }) : new Response(null, { status: 404 });
    };

    const observations = normalizeTcgdexObservationPayloads(
      await fetchTcgdexSetObservationPayloads({
        profile: tcgdexPokemonTcgProviderProfile,
        languageCode: "en",
        setId: "sv4pt5",
        fetch: fetcher,
      }),
    );

    expect(observations.map((observation) => observation.normalized.cardVariantLabel)).toEqual([
      "Standard Set",
      "Standard Set Foil",
      "Premium Parallel Set - Poke Ball",
      "Premium Parallel Set - Master Ball",
      "Unclassified Variant - Confetti Foil",
    ]);
    expect(observations.map((observation) => observation.normalized.parallelSet)).toEqual([
      false,
      false,
      true,
      true,
      false,
    ]);
    expect(observations.map((observation) => observation.externalKey)).toEqual([
      "sv4pt5-025",
      "sv4pt5-025:holofoil",
      "sv4pt5-025:poke-ball",
      "sv4pt5-025:master-ball",
      "sv4pt5-025:confetti-foil",
    ]);
  });

  it("captures unambiguous marketplace product ids as Catalog Item references", async () => {
    const responses = new Map<string, unknown>([
      [
        "https://api.tcgdex.net/v2/en/sets/sv1",
        {
          id: "sv1",
          name: "Scarlet & Violet",
          cards: [{ id: "sv1-001", localId: "001", name: "Sprigatito" }],
        },
      ],
      [
        "https://api.tcgdex.net/v2/en/cards/sv1-001",
        {
          id: "sv1-001",
          localId: "001",
          name: "Sprigatito",
          category: "Pokemon",
          set: { id: "sv1", name: "Scarlet & Violet" },
          variants: {
            normal: true,
            reverse: true,
          },
          pricing: {
            tcgplayer: {
              normal: { productId: 490001 },
              "reverse-holofoil": { productId: 490002 },
            },
          },
          variants_detailed: [
            { type: "normal", tcgplayerProductId: 490001, cardmarketId: 880001 },
            { type: "reverse", tcgplayerProductId: 490002, cardmarketId: 880002 },
          ],
        },
      ],
    ]);
    const fetcher: typeof globalThis.fetch = async (input) => {
      const response = responses.get(String(input));
      return response ? new Response(JSON.stringify(response), { status: 200 }) : new Response(null, { status: 404 });
    };

    const observations = normalizeTcgdexObservationPayloads(
      await fetchTcgdexSetObservationPayloads({
        profile: tcgdexPokemonTcgProviderProfile,
        languageCode: "en",
        setId: "sv1",
        fetch: fetcher,
      }),
    );

    expect(observations.map((observation) => observation.normalized.externalCatalogItemReferences)).toEqual([
      [
        { providerKey: "tcgplayer", externalKey: "product:490001" },
        { providerKey: "cardmarket", externalKey: "product:880001" },
      ],
      [
        { providerKey: "tcgplayer", externalKey: "product:490002" },
        { providerKey: "cardmarket", externalKey: "product:880002" },
      ],
    ]);
    expect(observations[0]?.sourcePayload).not.toHaveProperty("pricing");
  });

  it("skips marketplace product ids that TCGdex repeats across variants", async () => {
    const responses = new Map<string, unknown>([
      [
        "https://api.tcgdex.net/v2/en/sets/swsh3",
        {
          id: "swsh3",
          name: "Darkness Ablaze",
          cards: [{ id: "swsh3-136", localId: "136", name: "Furret" }],
        },
      ],
      [
        "https://api.tcgdex.net/v2/en/cards/swsh3-136",
        {
          id: "swsh3-136",
          localId: "136",
          name: "Furret",
          category: "Pokemon",
          set: { id: "swsh3", name: "Darkness Ablaze" },
          variants: {
            normal: true,
            reverse: true,
          },
          pricing: {
            tcgplayer: {
              normal: { productId: 219333 },
              "reverse-holofoil": { productId: 219333 },
            },
            cardmarket: { idProduct: 483559 },
          },
        },
      ],
    ]);
    const fetcher: typeof globalThis.fetch = async (input) => {
      const response = responses.get(String(input));
      return response ? new Response(JSON.stringify(response), { status: 200 }) : new Response(null, { status: 404 });
    };

    const observations = normalizeTcgdexObservationPayloads(
      await fetchTcgdexSetObservationPayloads({
        profile: tcgdexPokemonTcgProviderProfile,
        languageCode: "en",
        setId: "swsh3",
        fetch: fetcher,
      }),
    );

    expect(observations.map((observation) => observation.normalized.externalCatalogItemReferences)).toEqual([[], []]);
  });

  it("reports set import progress while fetching cards", async () => {
    const responses = new Map<string, unknown>([
      [
        "https://api.tcgdex.net/v2/en/sets/swsh3",
        {
          id: "swsh3",
          name: "Darkness Ablaze",
          cards: [
            { id: "swsh3-136", localId: "136", name: "Furret" },
            { id: "swsh3-137", localId: "137", name: "Sentret" },
          ],
        },
      ],
      [
        "https://api.tcgdex.net/v2/en/cards/swsh3-136",
        {
          id: "swsh3-136",
          localId: "136",
          name: "Furret",
          image: "https://assets.tcgdex.net/en/swsh/swsh3/136",
          category: "Pokemon",
          set: { id: "swsh3", name: "Darkness Ablaze" },
        },
      ],
      [
        "https://api.tcgdex.net/v2/en/cards/swsh3-137",
        {
          id: "swsh3-137",
          localId: "137",
          name: "Sentret",
          category: "Pokemon",
          set: { id: "swsh3", name: "Darkness Ablaze" },
        },
      ],
    ]);
    const fetcher: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      const response = responses.get(url);
      return response ? new Response(JSON.stringify(response), { status: 200 }) : new Response(null, { status: 404 });
    };
    const progress: unknown[] = [];

    const observations = normalizeTcgdexObservationPayloads(
      await fetchTcgdexSetObservationPayloads({
        profile: tcgdexPokemonTcgProviderProfile,
        languageCode: "en",
        setId: "swsh3",
        fetch: fetcher,
        onProgress: (event) => {
          progress.push(event);
        },
      }),
    );

    expect(observations).toHaveLength(2);
    expect(progress).toEqual([
      { phase: "fetching", completed: 0, total: 2, currentName: null },
      { phase: "fetching", completed: 1, total: 2, currentName: "Furret" },
      { phase: "fetching", completed: 2, total: 2, currentName: "Sentret" },
    ]);
  });

  it("records observations without image urls when TCGdex has no image", async () => {
    const responses = new Map<string, unknown>([
      [
        "https://api.tcgdex.net/v2/en/sets/swsh3",
        {
          id: "swsh3",
          name: "Darkness Ablaze",
          cards: [{ id: "swsh3-136", localId: "136", name: "Furret" }],
        },
      ],
      [
        "https://api.tcgdex.net/v2/en/cards/swsh3-136",
        {
          id: "swsh3-136",
          localId: "136",
          name: "Furret",
          category: "Pokemon",
          set: { id: "swsh3", name: "Darkness Ablaze" },
        },
      ],
    ]);

    const fetcher: typeof globalThis.fetch = async (input) => {
      const response = responses.get(String(input));
      return response ? new Response(JSON.stringify(response), { status: 200 }) : new Response(null, { status: 404 });
    };

    const observations = normalizeTcgdexObservationPayloads(
      await fetchTcgdexSetObservationPayloads({
        profile: tcgdexPokemonTcgProviderProfile,
        languageCode: "en",
        setId: "swsh3",
        fetch: fetcher,
      }),
    );

    expect(observations).toMatchObject([
      {
        normalized: {
          imageBaseUrl: null,
          imageUrls: [],
          productAssetSet: null,
          cardVariantKey: "standard",
          cardVariantLabel: "Standard Set",
          cardVariantSourceKey: null,
          cardVariantIsPrimaryImage: true,
          imageDisclaimer: null,
        },
      },
    ]);
  });

  it("normalizes a TCGdex image into Catalog Item-owned WebP variants during promotion", async () => {
    const storedAssets: Array<{
      key: string;
      body: Uint8Array;
      contentType: string;
      cacheControl?: string;
    }> = [];
    const fetcher: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      if (url === "https://assets.tcgdex.net/en/swsh/swsh3/136/high.webp") {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "image/webp" },
        });
      }

      return new Response(null, { status: 404 });
    };

    const assetSet = await normalizeTcgdexImageAsset({
      profile: tcgdexPokemonTcgProviderProfile,
      imageBaseUrl: "https://assets.tcgdex.net/en/swsh/swsh3/136",
      storageBaseKey: "catalog/items/cat_test/product-image",
      observedAt: "2026-05-19T00:00:00.000Z",
      fetcher,
      assetStorage: {
        async putObject(input) {
          storedAssets.push(input);
          return {
            key: input.key,
            publicUrl: `https://assets.chasesets.test/${input.key}`,
          };
        },
      },
      imageProcessor: testImageProcessor,
    });

    expect(assetSet.sourceHash).toBe("039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81");
    expect(storedAssets.map((asset) => asset.key)).toEqual([
      "catalog/items/cat_test/product-image/source-039058c6f2c0.webp",
      expect.stringMatching(
        /^catalog\/items\/cat_test\/product-image\/thumbnail-96w-1x-039058c6f2c0-trim-alpha-v1-[a-f0-9]{12}\.webp$/,
      ),
      expect.stringMatching(
        /^catalog\/items\/cat_test\/product-image\/thumbnail-192w-2x-039058c6f2c0-trim-alpha-v1-[a-f0-9]{12}\.webp$/,
      ),
      expect.stringMatching(
        /^catalog\/items\/cat_test\/product-image\/search-card-224w-1x-039058c6f2c0-trim-alpha-v1-[a-f0-9]{12}\.webp$/,
      ),
      expect.stringMatching(
        /^catalog\/items\/cat_test\/product-image\/search-card-448w-2x-039058c6f2c0-trim-alpha-v1-[a-f0-9]{12}\.webp$/,
      ),
      expect.stringMatching(
        /^catalog\/items\/cat_test\/product-image\/catalog-detail-480w-1x-039058c6f2c0-trim-alpha-v1-[a-f0-9]{12}\.webp$/,
      ),
      expect.stringMatching(
        /^catalog\/items\/cat_test\/product-image\/catalog-detail-960w-2x-039058c6f2c0-trim-alpha-v1-[a-f0-9]{12}\.webp$/,
      ),
    ]);
    expect(storedAssets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          contentType: "image/webp",
          cacheControl: "public, max-age=31536000, immutable",
        }),
      ]),
    );
    expect(assetSet.variants).toHaveLength(6);
  });

  it("fetches a same-id English mirror entity from the explicit English locale", async () => {
    const requestedUrls: string[] = [];
    const fetcher: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url === "https://api.tcgdex.net/v2/en/sets/sv1a") {
        return new Response(JSON.stringify({ id: "sv1a", name: "Triplet Beat" }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    };

    await expect(
      fetchTcgdexEnglishMirrorEntity({
        profile: tcgdexPokemonTcgProviderProfile,
        entity: "set",
        id: "sv1a",
        fetch: fetcher,
      }),
    ).resolves.toEqual({ id: "sv1a", name: "Triplet Beat" });
    expect(requestedUrls).toEqual(["https://api.tcgdex.net/v2/en/sets/sv1a"]);
  });

  it("returns null when the English mirror endpoint does not exist for a Japanese-only set", async () => {
    const fetcher: typeof globalThis.fetch = async () => new Response(null, { status: 404 });

    await expect(
      fetchTcgdexEnglishMirrorEntity({
        profile: tcgdexPokemonTcgProviderProfile,
        entity: "card",
        id: "sv1a-001",
        fetch: fetcher,
      }),
    ).resolves.toBeNull();
  });

  it("fails promotion asset normalization when a declared high quality asset cannot be mirrored", async () => {
    const fetcher: typeof globalThis.fetch = async (input) =>
      String(input) === "https://assets.tcgdex.net/en/swsh/swsh3/136/high.webp"
        ? new Response(null, { status: 502 })
        : new Response(null, { status: 404 });

    await expect(
      normalizeTcgdexImageAsset({
        profile: tcgdexPokemonTcgProviderProfile,
        imageBaseUrl: "https://assets.tcgdex.net/en/swsh/swsh3/136",
        storageBaseKey: "catalog/items/cat_test/product-image",
        observedAt: "2026-05-19T00:00:00.000Z",
        fetcher,
        assetStorage: {
          async putObject() {
            throw new Error("unexpected storage call");
          },
        },
      }),
    ).rejects.toThrow(
      "TCGdex asset request failed with 502 for https://assets.tcgdex.net/en/swsh/swsh3/136/high.webp.",
    );
  });
});

function normalizeTcgdexObservationPayloads(payloads: readonly TcgdexObservationPayload[]) {
  const contract = requireCatalogProviderSourceObservationMappingContract("tcgdex");
  return payloads.map(({ observedAt, payload }) =>
    requireCatalogProviderSourceObservation({
      contract,
      payload,
      observedAt,
    }),
  );
}
