import { describe, expect, it } from "vitest";
import {
  decideSourceObservation,
  evolveSourceObservation,
  initialSourceObservationState,
  type SourceObservationNormalized,
} from "./domain";

const normalized: SourceObservationNormalized = {
  kind: "pokemon-card",
  tcg: "pokemon",
  languageCode: "en",
  name: "Furret",
  cardNumber: "136",
  setId: "swsh3",
  setName: "Darkness Ablaze",
  seriesId: "swsh",
  seriesName: "Sword & Shield",
  rarity: "Uncommon",
  illustrator: "tetsuya koizumi",
  releaseDate: "2020-08-14",
  releaseYear: 2020,
  category: "Pokemon",
  imageBaseUrl: "https://assets.tcgdex.net/en/swsh/swsh3/136",
  imageUrls: [
    "https://assets.chasesets.test/catalog/source-observations/tcgdex/en/swsh3-136/high.webp",
  ],
  productAssetSet: null,
  variants: { normal: true, reverse: true },
};

describe("source observation domain", () => {
  const recordCommand = {
    type: "RecordSourceObservation",
    observationId: "tcgdex_en_swsh3_136",
    providerKey: "tcgdex",
    externalKey: "swsh3-136",
    sourceUrl: "https://api.tcgdex.net/v2/en/cards/swsh3-136",
    languageCode: "en",
    sourceRecordHash: "hash",
    sourceUpdatedAt: null,
    observedAt: "2026-05-15T00:00:00.000Z",
    normalized,
    sourcePayload: { id: "swsh3-136" },
  } as const;

  it("records and promotes an observed source record", () => {
    const recorded = decideSourceObservation(initialSourceObservationState, {
      ...recordCommand,
      observationId: "tcgdex_en_swsh3_136",
      providerKey: "TCGdex",
      languageCode: "EN",
    });

    const state = evolveSourceObservation(initialSourceObservationState, recorded[0]);
    expect(state.providerKey).toBe("tcgdex");
    expect(state.languageCode).toBe("en");
    expect(state.status).toBe("observed");

    const promoted = decideSourceObservation(state, {
      type: "PromoteSourceObservation",
      catalogItemId: "cat_1",
      promotedAt: "2026-05-15T00:01:00.000Z",
    });

    expect(evolveSourceObservation(state, promoted[0])).toMatchObject({
      status: "promoted",
      promotedCatalogItemId: "cat_1",
    });
  });

  it("treats same-hash refreshes as idempotent while observed", () => {
    const recorded = decideSourceObservation(initialSourceObservationState, recordCommand);
    const observed = evolveSourceObservation(initialSourceObservationState, recorded[0]);

    expect(
      decideSourceObservation(observed, {
        ...recordCommand,
        observedAt: "2026-05-15T00:05:00.000Z",
      }),
    ).toEqual([]);
  });

  it("refreshes changed observed records", () => {
    const recorded = decideSourceObservation(initialSourceObservationState, recordCommand);
    const observed = evolveSourceObservation(initialSourceObservationState, recorded[0]);

    const refreshed = decideSourceObservation(observed, {
      ...recordCommand,
      sourceRecordHash: "new-hash",
      sourceUpdatedAt: "2026-05-15T01:00:00.000Z",
      observedAt: "2026-05-15T01:00:00.000Z",
      normalized: { ...normalized, name: "Furret Updated" },
    });

    expect(refreshed).toHaveLength(1);
    expect(evolveSourceObservation(observed, refreshed[0])).toMatchObject({
      sourceRecordHash: "new-hash",
      sourceUpdatedAt: "2026-05-15T01:00:00.000Z",
      normalized: expect.objectContaining({ name: "Furret Updated" }),
      status: "observed",
    });
  });

  it("does not allow rejected observations to be promoted", () => {
    const recorded = decideSourceObservation(initialSourceObservationState, recordCommand);
    const observed = evolveSourceObservation(initialSourceObservationState, recorded[0]);
    const rejectedEvent = decideSourceObservation(observed, {
      type: "RejectSourceObservation",
      reason: "Duplicate",
    })[0];
    const rejected = evolveSourceObservation(observed, rejectedEvent);

    expect(() =>
      decideSourceObservation(rejected, {
        type: "PromoteSourceObservation",
        catalogItemId: "cat_1",
        promotedAt: "2026-05-15T00:01:00.000Z",
      }),
    ).toThrow("Only observed source observations can transition.");
  });

  it("does not allow terminal observations to be refreshed in place", () => {
    const recorded = decideSourceObservation(initialSourceObservationState, recordCommand);
    const observed = evolveSourceObservation(initialSourceObservationState, recorded[0]);
    const promotedEvent = decideSourceObservation(observed, {
      type: "PromoteSourceObservation",
      catalogItemId: "cat_1",
      promotedAt: "2026-05-15T00:01:00.000Z",
    })[0];
    const promoted = evolveSourceObservation(observed, promotedEvent);

    expect(() =>
      decideSourceObservation(promoted, {
        ...recordCommand,
        sourceRecordHash: "new-hash",
        observedAt: "2026-05-15T00:05:00.000Z",
      }),
    ).toThrow("Only observed source observations can be refreshed.");
  });
});
