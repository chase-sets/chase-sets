import { describe, expect, it } from "vitest";
import {
  fetchTcgdexExpansionOptions,
  fetchTcgdexSeriesOptions,
  fetchTcgdexSetObservations,
  listTcgdexLanguageOptions,
} from "./tcgdex-client";

const testImageProcessor = {
  async metadata() {
    return { width: 734, height: 1024 };
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
    expect(listTcgdexLanguageOptions()).toEqual(
      expect.arrayContaining([
        { languageCode: "en" },
        { languageCode: "ja" },
        { languageCode: "zh-tw" },
      ]),
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
      return response
        ? new Response(JSON.stringify(response), { status: 200 })
        : new Response(null, { status: 404 });
    };

    await expect(fetchTcgdexSeriesOptions({ languageCode: "EN", fetch: fetcher }))
      .resolves.toEqual([
        { seriesId: "me", name: "Mega Evolution", logoUrl: "https://assets.tcgdex.net/en/me/me01/logo" },
        { seriesId: "sv", name: "Scarlet & Violet", logoUrl: null },
      ]);
    await expect(fetchTcgdexExpansionOptions({ languageCode: "en", seriesId: "me", fetch: fetcher }))
      .resolves.toEqual([
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

  it("normalizes the high quality set card asset into owned WebP variants", async () => {
    const storedAssets: Array<{
      key: string;
      body: Uint8Array;
      contentType: string;
      cacheControl?: string;
    }> = [];
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
      if (url === "https://assets.tcgdex.net/en/swsh/swsh3/136/high.webp") {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "image/webp" },
        });
      }
      const response = responses.get(url);
      if (!response) {
        return new Response(null, { status: 404 });
      }

      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const observations = await fetchTcgdexSetObservations({
      languageCode: "en",
      setId: "swsh3",
      fetch: fetcher,
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

    expect(observations).toHaveLength(1);
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
        imageUrls: [
          "https://assets.chasesets.test/catalog/source-observations/tcgdex/en/swsh3-136/catalog-detail-480w-1x-039058c6f2c0.webp",
        ],
        productAssetSet: {
          kind: "product-image",
          sourceHash: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
        },
        parallelSet: true,
      },
    });
    expect(storedAssets.map((asset) => asset.key)).toEqual([
      "catalog/source-observations/tcgdex/en/swsh3-136/source-039058c6f2c0.webp",
      "catalog/source-observations/tcgdex/en/swsh3-136/thumbnail-96w-1x-039058c6f2c0.webp",
      "catalog/source-observations/tcgdex/en/swsh3-136/thumbnail-192w-2x-039058c6f2c0.webp",
      "catalog/source-observations/tcgdex/en/swsh3-136/search-card-160w-1x-039058c6f2c0.webp",
      "catalog/source-observations/tcgdex/en/swsh3-136/search-card-320w-2x-039058c6f2c0.webp",
      "catalog/source-observations/tcgdex/en/swsh3-136/catalog-detail-480w-1x-039058c6f2c0.webp",
      "catalog/source-observations/tcgdex/en/swsh3-136/catalog-detail-960w-2x-039058c6f2c0.webp",
    ]);
    expect(storedAssets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          contentType: "image/webp",
          cacheControl: "public, max-age=31536000, immutable",
        }),
      ]),
    );
    expect(observations[0]?.normalized.productAssetSet?.variants).toHaveLength(6);
    expect(observations[0]?.sourceRecordHash).toHaveLength(64);
    expect(observations[0]?.sourcePayload).not.toHaveProperty("pricing");
  });

  it("keeps source hashes stable when the owned asset host changes", async () => {
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
          image: "https://assets.tcgdex.net/en/swsh/swsh3/136",
          category: "Pokemon",
          set: { id: "swsh3", name: "Darkness Ablaze" },
        },
      ],
    ]);
    const fetcher: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      if (url === "https://assets.tcgdex.net/en/swsh/swsh3/136/high.webp") {
        return new Response(new Uint8Array([1]), {
          status: 200,
          headers: { "content-type": "image/webp" },
        });
      }
      const response = responses.get(url);
      return response
        ? new Response(JSON.stringify(response), { status: 200 })
        : new Response(null, { status: 404 });
    };

    const firstImport = await fetchTcgdexSetObservations({
      languageCode: "en",
      setId: "swsh3",
      fetch: fetcher,
      assetStorage: {
        async putObject(input) {
          return {
            key: input.key,
            publicUrl: `https://assets-a.chasesets.test/${input.key}`,
          };
        },
      },
      imageProcessor: testImageProcessor,
    });
    const secondImport = await fetchTcgdexSetObservations({
      languageCode: "en",
      setId: "swsh3",
      fetch: fetcher,
      assetStorage: {
        async putObject(input) {
          return {
            key: input.key,
            publicUrl: `https://assets-b.chasesets.test/${input.key}`,
          };
        },
      },
      imageProcessor: testImageProcessor,
    });

    expect(firstImport[0]?.sourceRecordHash).toBe(secondImport[0]?.sourceRecordHash);
    expect(firstImport[0]?.normalized.imageUrls).toEqual([
      "https://assets-a.chasesets.test/catalog/source-observations/tcgdex/en/swsh3-136/catalog-detail-480w-1x-4bf5122f3445.webp",
    ]);
    expect(secondImport[0]?.normalized.imageUrls).toEqual([
      "https://assets-b.chasesets.test/catalog/source-observations/tcgdex/en/swsh3-136/catalog-detail-480w-1x-4bf5122f3445.webp",
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
      return response
        ? new Response(JSON.stringify(response), { status: 200 })
        : new Response(null, { status: 404 });
    };

    await expect(
      fetchTcgdexSetObservations({
        languageCode: "en",
        setId: "swsh3",
        fetch: fetcher,
      }),
    ).resolves.toMatchObject([
      {
        normalized: {
          imageBaseUrl: null,
          imageUrls: [],
          productAssetSet: null,
        },
      },
    ]);
  });

  it("fails observations when a declared high quality asset cannot be mirrored", async () => {
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
          image: "https://assets.tcgdex.net/en/swsh/swsh3/136",
          category: "Pokemon",
          set: { id: "swsh3", name: "Darkness Ablaze" },
        },
      ],
    ]);

    const fetcher: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      if (url === "https://assets.tcgdex.net/en/swsh/swsh3/136/high.webp") {
        return new Response(null, { status: 502 });
      }
      const response = responses.get(url);
      return response
        ? new Response(JSON.stringify(response), { status: 200 })
        : new Response(null, { status: 404 });
    };

    await expect(
      fetchTcgdexSetObservations({
        languageCode: "en",
        setId: "swsh3",
        fetch: fetcher,
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
