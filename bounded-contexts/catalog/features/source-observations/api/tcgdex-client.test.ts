import { describe, expect, it } from "vitest";
import { fetchTcgdexSetObservations } from "./tcgdex-client";

describe("TCGdex client", () => {
  it("mirrors only the high quality set card asset into owned storage", async () => {
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
        seriesName: "Sword & Shield",
        rarity: "Uncommon",
        illustrator: "tetsuya koizumi",
        releaseYear: 2020,
        imageUrls: [
          "https://assets.chasesets.test/catalog/source-observations/tcgdex/en/swsh3-136/high.webp",
        ],
      },
    });
    expect(storedAssets).toEqual([
      {
        key: "catalog/source-observations/tcgdex/en/swsh3-136/high.webp",
        body: new Uint8Array([1, 2, 3]),
        contentType: "image/webp",
        cacheControl: "public, max-age=31536000, immutable",
      },
    ]);
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
    });

    expect(firstImport[0]?.sourceRecordHash).toBe(secondImport[0]?.sourceRecordHash);
    expect(firstImport[0]?.normalized.imageUrls).toEqual([
      "https://assets-a.chasesets.test/catalog/source-observations/tcgdex/en/swsh3-136/high.webp",
    ]);
    expect(secondImport[0]?.normalized.imageUrls).toEqual([
      "https://assets-b.chasesets.test/catalog/source-observations/tcgdex/en/swsh3-136/high.webp",
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
