import { describe, expect, it, vi } from "vitest";
import type { SourceObservationNormalized } from "../domain/domain";
import { buildSourceObservationProjectionHandlers } from "./projection";

const normalized: SourceObservationNormalized = {
  kind: "pokemon-card",
  tcg: "pokemon",
  languageCode: "en",
  name: "Abra",
  cardNumber: "43",
  setId: "base1",
  setName: "Base Set",
  expansionId: "base1",
  expansionName: "Base Set",
  expansionAbbreviation: "BS",
  expansionCardCount: 102,
  expansionParallelSetCardCount: null,
  seriesId: "base",
  seriesName: "Base",
  rarity: "Common",
  illustrator: null,
  releaseDate: "1999-01-09",
  releaseYear: 1999,
  category: "Pokemon",
  imageBaseUrl: "https://assets.tcgdex.net/en/base/base1/43",
  imageUrls: ["https://assets.tcgdex.net/en/base/base1/43/high.webp"],
  productAssetSet: null,
  parallelSet: false,
  cardVariantKey: "standard-set",
  cardVariantLabel: "Standard Set",
  cardVariantSourceKey: "normal",
  cardVariantIsPrimaryImage: true,
  imageDisclaimer: null,
  variants: { normal: true },
};

describe("Source Observation projections", () => {
  it("repairs missing rows from refreshed unchanged observations", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const handlers = buildSourceObservationProjectionHandlers({ query });

    await handlers["catalog.source-observation.refreshed"]?.({
      streamId: "catalog.source-observation-tcgdex_en_base1_043",
      data: {
        ...observationData(),
        status: "promoted",
        statusReason: null,
        promotedCatalogItemId: "cat_1",
        promotedAt: "2026-05-28T14:00:00.000Z",
      },
      timing: { recordedAt: "2026-05-28T14:05:00.000Z" },
    } as never);

    expect(query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO catalog_source_observations"), [
      "tcgdex_en_base1_043",
      "tcgdex",
      "base1-43",
      "https://api.tcgdex.net/v2/en/cards/base1-43",
      "en",
      "hash",
      null,
      "2026-05-28T14:04:00.000Z",
      JSON.stringify(normalized),
      JSON.stringify({ id: "base1-43" }),
      "promoted",
      null,
      "cat_1",
      "2026-05-28T14:00:00.000Z",
      "2026-05-28T14:05:00.000Z",
    ]);
    expect(query.mock.calls[0]?.[0]).toContain("ON CONFLICT (observation_id) DO UPDATE");
    expect(query.mock.calls[0]?.[0]).toContain("promoted_catalog_item_id = EXCLUDED.promoted_catalog_item_id");
  });

  it("upserts changed observations so a new change can repair a missing row", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const handlers = buildSourceObservationProjectionHandlers({ query });

    await handlers["catalog.source-observation.changed"]?.({
      streamId: "catalog.source-observation-tcgdex_en_base1_043",
      data: observationData({ sourceRecordHash: "new-hash" }),
      timing: { recordedAt: "2026-05-28T14:05:00.000Z" },
    } as never);

    expect(query.mock.calls[0]?.[0]).toContain("INSERT INTO catalog_source_observations");
    expect(query.mock.calls[0]?.[0]).toContain("ON CONFLICT (observation_id) DO UPDATE");
    expect(query.mock.calls[0]?.[0]).not.toContain("promoted_catalog_item_id = EXCLUDED.promoted_catalog_item_id");
    expect(query.mock.calls[0]?.[1]?.[10]).toBe("changed");
  });
});

function observationData(overrides: Partial<{ sourceRecordHash: string }> = {}) {
  return {
    observationId: "tcgdex_en_base1_043",
    providerKey: "tcgdex",
    externalKey: "base1-43",
    sourceUrl: "https://api.tcgdex.net/v2/en/cards/base1-43",
    languageCode: "en",
    sourceRecordHash: "hash",
    sourceUpdatedAt: null,
    observedAt: "2026-05-28T14:04:00.000Z",
    normalized,
    sourcePayload: { id: "base1-43" },
    ...overrides,
  };
}
