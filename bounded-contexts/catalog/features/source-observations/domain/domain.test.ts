import { normalizedObservation } from "../../../support/test-support/source-observation-fixtures";
import { describe, expect, it } from "vitest";
import { EVENT_STORE_MAX_PAYLOAD_BYTES } from "@chase-sets/event-core-postgres";
import {
  decideSourceObservation,
  evolveSourceObservation,
  initialSourceObservationState,
  type SourceObservationNormalized,
} from "./domain";

const normalized = normalizedObservation({
  parallelSet: true,
  cardVariantKey: "reverse-holo",
  cardVariantLabel: "Parallel Set - Reverse Foil",
  cardVariantSourceKey: "reverse",
  cardVariantIsPrimaryImage: false,
  imageDisclaimer:
    "TCGDex provides one image for this card number. This Catalog Item represents the Parallel Set - Reverse Foil variant, so the image may not show the exact foil or pattern.",
  variants: { normal: true, reverse: true },
});

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
    sourceProfileKey: "pokemon-tcg",
    sourceProfileVersion: "2026.06.03",
    sourceMappingFingerprint: "mapping-fingerprint",
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
      promotionProfileKey: "pokemon-tcg",
      promotionProfileVersion: "2026.06.03",
      promotionPlanFingerprint: "plan-fingerprint",
    });

    expect(evolveSourceObservation(state, promoted[0])).toMatchObject({
      status: "promoted",
      promotedCatalogItemId: "cat_1",
    });
  });

  it("splits oversized provider evidence into replay-deterministic bounded events", () => {
    const sourcePayload = {
      code: "5DN",
      cards: Array.from({ length: 8_000 }, (_, index) => ({
        uuid: `fifth-dawn-card-${index}`,
        name: `Fifth Dawn Card ${index} λ`,
        text: "Deterministic provider evidence ".repeat(4),
      })),
    };
    expect(Buffer.byteLength(JSON.stringify(sourcePayload), "utf8")).toBeGreaterThan(1_000_000);

    const events = decideSourceObservation(initialSourceObservationState, {
      ...recordCommand,
      observationId: "mtgjson_set_en_5DN",
      providerKey: "mtgjson",
      externalKey: "set:5DN",
      sourceUrl: "https://mtgjson.com/api/v5/5DN.json",
      sourceRecordHash: "fifth-dawn-hash",
      sourceProfileKey: "mtg-set-reference-data",
      sourceProfileVersion: "2026.06.19",
      normalized: {
        kind: "magic-set-reference",
        tcg: "magic",
        languageCode: "en",
        name: "Fifth Dawn",
        cardNumber: null,
        setCode: "5DN",
        setName: "Fifth Dawn",
        expansionName: "Fifth Dawn",
        setId: "00000000-0000-0000-0000-0000000005dn",
        releaseDate: "2004-06-04",
        releaseYear: 2004,
        cardCount: 165,
        productLineName: "Magic: The Gathering",
        imageUrls: [],
      },
      sourcePayload,
    });

    expect(events[0]).toMatchObject({
      type: "catalog.source-observation.recorded",
      data: { sourcePayloadEncoding: "json-utf8-base64-v1" },
    });
    expect(
      events.slice(1).every((event) => event.type === "catalog.source-observation.source-payload-chunk-recorded"),
    ).toBe(true);
    expect(
      events.every((event) => Buffer.byteLength(JSON.stringify(event.data), "utf8") <= EVENT_STORE_MAX_PAYLOAD_BYTES),
    ).toBe(true);

    const replayed = events.reduce(evolveSourceObservation, initialSourceObservationState);
    expect(replayed.sourcePayload).toEqual(sourcePayload);
    expect(replayed.pendingSourcePayloadChunks).toBeNull();
    expect(replayed.pendingSourcePayloadChunkCount).toBeNull();
  });

  it("records Magic normalized observation kinds as first-class source evidence", () => {
    const magicNormalized: SourceObservationNormalized = {
      kind: "magic-card-print",
      tcg: "magic",
      languageCode: "EN-us",
      name: "Fury Sliver",
      cardNumber: " 0157 ",
      setCode: " TSP ",
      setName: "Time Spiral",
      expansionName: "Time Spiral",
      setId: null,
      oracleId: "44623693-51d6-49ad-8cd7-140505caf02f",
      rarity: "Rare",
      illustrator: "Paolo Parente",
      releaseDate: "2006-10-06",
      releaseYear: 2006,
      cardVariantKey: "standard",
      cardVariantLabel: "Standard",
      imageUrls: ["https://cards.scryfall.io/normal/front/fury-sliver.jpg"],
      mergeIdentity: {
        tcg: "magic",
        productLineName: "Magic: The Gathering",
        setName: "Time Spiral",
        printedProductName: "Fury Sliver",
        collectorNumber: " 0157 ",
        languageCode: "EN-us",
        productForm: "magic-card-print",
      },
    };

    const recorded = decideSourceObservation(initialSourceObservationState, {
      ...recordCommand,
      observationId: "scrydex_en_0000579f",
      languageCode: "EN-us",
      providerKey: "scrydex",
      externalKey: "scryfall:0000579f",
      sourceUrl: "https://scryfall.com/card/tsp/157/fury-sliver",
      sourceRecordHash: "magic-hash",
      sourceProfileKey: "scryfall-card-fixture",
      normalized: magicNormalized,
      sourcePayload: { id: "0000579f" },
    });

    expect(evolveSourceObservation(initialSourceObservationState, recorded[0]).normalized).toMatchObject({
      kind: "magic-card-print",
      setName: "Time Spiral",
      cardNumber: "157",
      setCode: "tsp",
      languageCode: "en-US",
      mergeIdentity: {
        collectorNumber: "157",
        languageCode: "en-US",
      },
    });
  });

  it("promotes Magic set reference observations to Reference Records", () => {
    const recorded = decideSourceObservation(initialSourceObservationState, {
      ...recordCommand,
      observationId: "mtgjson_en_tsp",
      providerKey: "mtgjson",
      externalKey: "set:TSP",
      sourceUrl: "https://mtgjson.com/api/v5/TSP.json",
      sourceProfileKey: "mtg-set-reference-data",
      sourceProfileVersion: "2026.06.19",
      normalized: {
        kind: "magic-set-reference",
        tcg: "magic",
        languageCode: "en",
        name: "Time Spiral",
        cardNumber: null,
        setCode: "TSP",
        setName: "Time Spiral",
        expansionName: "Time Spiral",
        setId: "00000000-0000-0000-0000-000000000tsp",
        releaseDate: "2006-10-06",
        releaseYear: 2006,
        cardCount: 301,
        productLineName: "Magic: The Gathering",
        imageUrls: [],
      },
      sourcePayload: { code: "TSP" },
    });
    const observed = evolveSourceObservation(initialSourceObservationState, recorded[0]);

    const promoted = decideSourceObservation(observed, {
      type: "PromoteSourceObservationReference",
      referenceRecordId: "ref_mtgjson_set_tsp",
      promotedAt: "2026-06-19T10:00:00.000Z",
      promotionProfileKey: "mtg-set-reference-data",
      promotionProfileVersion: "2026.06.19",
      promotionPlanFingerprint: "sha256:reference",
    });

    expect(evolveSourceObservation(observed, promoted[0])).toMatchObject({
      status: "promoted",
      promotedCatalogItemId: null,
      promotedReferenceRecordId: "ref_mtgjson_set_tsp",
      promotionProfileKey: "mtg-set-reference-data",
      promotionProfileVersion: "2026.06.19",
    });
  });

  it("rejects retired legacy profile markers instead of recording fallback metadata", () => {
    expect(() =>
      decideSourceObservation(initialSourceObservationState, {
        ...recordCommand,
        sourceProfileVersion: "legacy",
      }),
    ).toThrow("Source observation source profile version cannot use the retired legacy marker.");
  });

  it("rejects retired legacy promotion markers", () => {
    const recorded = decideSourceObservation(initialSourceObservationState, recordCommand);
    const state = evolveSourceObservation(initialSourceObservationState, recorded[0]);

    expect(() =>
      decideSourceObservation(state, {
        type: "PromoteSourceObservation",
        catalogItemId: "cat_1",
        promotedAt: "2026-05-15T00:01:00.000Z",
        promotionProfileKey: "pokemon-tcg",
        promotionProfileVersion: "legacy",
        promotionPlanFingerprint: "plan-fingerprint",
      }),
    ).toThrow("Promotion profile version cannot use the retired legacy marker.");
  });

  it("records same-hash refreshes while preserving observed review state", () => {
    const recorded = decideSourceObservation(initialSourceObservationState, recordCommand);
    const observed = evolveSourceObservation(initialSourceObservationState, recorded[0]);

    const refreshedEvent = decideSourceObservation(observed, {
      ...recordCommand,
      observedAt: "2026-05-15T00:05:00.000Z",
    })[0];

    expect(refreshedEvent).toMatchObject({
      type: "catalog.source-observation.refreshed",
      data: {
        observationId: "tcgdex_en_swsh3_136",
        status: "observed",
        statusReason: null,
        promotedCatalogItemId: null,
        promotedAt: null,
      },
    });
    expect(evolveSourceObservation(observed, refreshedEvent)).toMatchObject({
      status: "observed",
      observedAt: "2026-05-15T00:05:00.000Z",
      promotedCatalogItemId: null,
    });
  });

  it("records same-hash refreshes while preserving promoted review state", () => {
    const recorded = decideSourceObservation(initialSourceObservationState, recordCommand);
    const observed = evolveSourceObservation(initialSourceObservationState, recorded[0]);
    const promotedEvent = decideSourceObservation(observed, {
      type: "PromoteSourceObservation",
      catalogItemId: "cat_1",
      promotedAt: "2026-05-15T00:01:00.000Z",
      promotionProfileKey: "pokemon-tcg",
      promotionProfileVersion: "2026.06.03",
      promotionPlanFingerprint: "plan-fingerprint",
    })[0];
    const promoted = evolveSourceObservation(observed, promotedEvent);

    const refreshedEvent = decideSourceObservation(promoted, {
      ...recordCommand,
      observedAt: "2026-05-15T00:05:00.000Z",
    })[0];

    expect(refreshedEvent).toMatchObject({
      type: "catalog.source-observation.refreshed",
      data: {
        status: "promoted",
        statusReason: null,
        promotedCatalogItemId: "cat_1",
        promotedAt: "2026-05-15T00:01:00.000Z",
      },
    });
    expect(evolveSourceObservation(promoted, refreshedEvent)).toMatchObject({
      status: "promoted",
      observedAt: "2026-05-15T00:05:00.000Z",
      promotedCatalogItemId: "cat_1",
      promotedAt: "2026-05-15T00:01:00.000Z",
    });
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
        promotionProfileKey: "pokemon-tcg",
        promotionProfileVersion: "2026.06.03",
        promotionPlanFingerprint: "plan-fingerprint",
      }),
    ).toThrow("Only observed or changed source observations can be promoted.");
  });

  it("defers reviewable observations while keeping them in the review queue", () => {
    const recorded = decideSourceObservation(initialSourceObservationState, recordCommand);
    const observed = evolveSourceObservation(initialSourceObservationState, recorded[0]);

    const deferredEvent = decideSourceObservation(observed, {
      type: "DeferSourceObservation",
      deferredAt: "2026-05-15T00:02:00.000Z",
      reason: " Needs better provider evidence. ",
    })[0];

    expect(deferredEvent).toMatchObject({
      type: "catalog.source-observation.deferred",
      data: {
        deferredAt: "2026-05-15T00:02:00.000Z",
        reason: "Needs better provider evidence.",
        reviewStatus: "observed",
      },
    });
    expect(evolveSourceObservation(observed, deferredEvent)).toMatchObject({
      status: "observed",
      statusReason: "Needs better provider evidence.",
    });
  });

  it("does not allow terminal observations to be deferred", () => {
    const recorded = decideSourceObservation(initialSourceObservationState, recordCommand);
    const observed = evolveSourceObservation(initialSourceObservationState, recorded[0]);
    const rejectedEvent = decideSourceObservation(observed, {
      type: "RejectSourceObservation",
      reason: "Duplicate",
    })[0];
    const rejected = evolveSourceObservation(observed, rejectedEvent);

    expect(() =>
      decideSourceObservation(rejected, {
        type: "DeferSourceObservation",
        deferredAt: "2026-05-15T00:02:00.000Z",
        reason: "Needs better provider evidence.",
      }),
    ).toThrow("Only observed or changed source observations can be deferred.");
  });

  it("marks changed promoted records for review without losing the Catalog Item link", () => {
    const recorded = decideSourceObservation(initialSourceObservationState, recordCommand);
    const observed = evolveSourceObservation(initialSourceObservationState, recorded[0]);
    const promotedEvent = decideSourceObservation(observed, {
      type: "PromoteSourceObservation",
      catalogItemId: "cat_1",
      promotedAt: "2026-05-15T00:01:00.000Z",
      promotionProfileKey: "pokemon-tcg",
      promotionProfileVersion: "2026.06.03",
      promotionPlanFingerprint: "plan-fingerprint",
    })[0];
    const promoted = evolveSourceObservation(observed, promotedEvent);

    const changedEvent = decideSourceObservation(promoted, {
      ...recordCommand,
      sourceRecordHash: "new-hash",
      observedAt: "2026-05-15T00:05:00.000Z",
      normalized: { ...normalized, rarity: "Rare" },
    })[0];
    const changed = evolveSourceObservation(promoted, changedEvent);

    expect(changed).toMatchObject({
      status: "changed",
      sourceRecordHash: "new-hash",
      promotedCatalogItemId: "cat_1",
      normalized: expect.objectContaining({ rarity: "Rare" }),
    });

    const refreshedPromotion = decideSourceObservation(changed, {
      type: "PromoteSourceObservation",
      catalogItemId: "cat_1",
      promotedAt: "2026-05-15T00:10:00.000Z",
      promotionProfileKey: "pokemon-tcg",
      promotionProfileVersion: "2026.06.03",
      promotionPlanFingerprint: "plan-fingerprint-2",
    })[0];

    expect(evolveSourceObservation(changed, refreshedPromotion)).toMatchObject({
      status: "promoted",
      promotedCatalogItemId: "cat_1",
      promotedAt: "2026-05-15T00:10:00.000Z",
    });
  });
});
