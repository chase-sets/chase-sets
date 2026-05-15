import { describe, expect, it } from "vitest";
import { fetchTcgdexSetObservations } from "./tcgdex-client";

describe("TCGdex client", () => {
  it("maps a set card into a source observation with deterministic identity and webp assets", async () => {
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
          "https://assets.tcgdex.net/en/swsh/swsh3/136/low.webp",
          "https://assets.tcgdex.net/en/swsh/swsh3/136/high.webp",
        ],
      },
    });
    expect(observations[0]?.sourceRecordHash).toHaveLength(64);
    expect(observations[0]?.sourcePayload).not.toHaveProperty("pricing");
  });
});
