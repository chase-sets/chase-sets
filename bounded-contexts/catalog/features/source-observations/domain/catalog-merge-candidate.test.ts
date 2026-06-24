import { describe, expect, it } from "vitest";
import {
  decideCatalogMergeCandidate,
  evolveCatalogMergeCandidate,
  initialCatalogMergeCandidateState,
  type CatalogMergeCandidateObservationMember,
  type CatalogMergeCandidateReviewSnapshot,
} from "./catalog-merge-candidate";

describe("Catalog Merge Candidate domain", () => {
  it("creates one reviewable candidate from multiple provider observations", () => {
    const event = decideCatalogMergeCandidate(initialCatalogMergeCandidateState, {
      type: "CreateCatalogMergeCandidate",
      candidateId: "cand_pokemon_en_base1_043_standard",
      snapshot: candidateSnapshot(),
      createdAt: "2026-06-24T10:00:00.000Z",
    })[0];

    expect(event).toMatchObject({
      type: "catalog.merge-candidate.created",
      data: {
        candidateId: "cand_pokemon_en_base1_043_standard",
        status: "ready",
        snapshot: {
          identity: {
            productLineName: "Pokemon TCG",
            printedProductName: "Abra",
            collectorNumber: "43",
            languageCode: "en",
          },
          membership: [
            { observationId: "obs_tcgplayer_base1_43", providerKey: "tcgplayer" },
            { observationId: "obs_tcgdex_base1_43", providerKey: "tcgdex" },
          ].sort((left, right) => left.observationId.localeCompare(right.observationId)),
        },
      },
    });

    const state = evolveCatalogMergeCandidate(initialCatalogMergeCandidateState, event);
    expect(state.status).toBe("ready");
    expect(state.snapshot?.membership).toHaveLength(2);
    expect(state.snapshot?.proposedExternalCatalogItemReferences).toEqual([
      { providerKey: "tcgdex", externalKey: "base1-43" },
      { providerKey: "tcgplayer", externalKey: "product:42382" },
    ]);
    expect(state.snapshot?.fieldProvenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fieldPath: "catalogItem.name",
          observationId: "obs_tcgdex_base1_43",
          providerKey: "tcgdex",
        }),
      ]),
    );
  });

  it("refreshes a candidate with conflicts without losing replayable provenance", () => {
    const created = decideCatalogMergeCandidate(initialCatalogMergeCandidateState, {
      type: "CreateCatalogMergeCandidate",
      candidateId: "cand_pokemon_en_base1_043_standard",
      snapshot: candidateSnapshot(),
      createdAt: "2026-06-24T10:00:00.000Z",
    })[0];
    const state = evolveCatalogMergeCandidate(initialCatalogMergeCandidateState, created);

    const refreshed = decideCatalogMergeCandidate(state, {
      type: "RefreshCatalogMergeCandidate",
      refreshedAt: "2026-06-24T10:05:00.000Z",
      snapshot: candidateSnapshot({
        proposedCatalogItemFacts: {
          name: "Abra",
          expansionName: "Base Set",
          rarity: "Uncommon",
        },
        conflicts: [
          {
            code: "rarity-mismatch",
            severity: "blocking",
            message: "Provider observations disagree about rarity.",
            fieldPath: "catalogItem.rarity",
            observationIds: ["obs_tcgdex_base1_43", "obs_tcgplayer_base1_43"],
            existingValue: null,
            proposedValue: "Uncommon",
          },
        ],
        fieldProvenance: [
          ...candidateSnapshot().fieldProvenance,
          {
            fieldPath: "catalogItem.rarity",
            value: "Uncommon",
            observationId: "obs_tcgplayer_base1_43",
            providerKey: "tcgplayer",
            sourceProfileKey: "tcgplayer-pokemon-card",
            sourceProfileVersion: "2026.06.24",
            confidence: "candidate",
            evidence: { sourceField: "rarity" },
          },
        ],
      }),
    })[0];

    const refreshedState = evolveCatalogMergeCandidate(state, refreshed);
    expect(refreshed).toMatchObject({
      type: "catalog.merge-candidate.refreshed",
      data: {
        status: "has-conflicts",
      },
    });
    expect(refreshedState.status).toBe("has-conflicts");
    expect(refreshedState.snapshot?.conflicts).toEqual([
      expect.objectContaining({
        code: "rarity-mismatch",
        observationIds: ["obs_tcgdex_base1_43", "obs_tcgplayer_base1_43"],
      }),
    ]);
    expect(refreshedState.snapshot?.fieldProvenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fieldPath: "catalogItem.rarity",
          observationId: "obs_tcgplayer_base1_43",
        }),
      ]),
    );
  });

  it("marks a candidate stale when source evidence changes underneath it", () => {
    const created = decideCatalogMergeCandidate(initialCatalogMergeCandidateState, {
      type: "CreateCatalogMergeCandidate",
      candidateId: "cand_pokemon_en_base1_043_standard",
      snapshot: candidateSnapshot(),
      createdAt: "2026-06-24T10:00:00.000Z",
    })[0];
    const state = evolveCatalogMergeCandidate(initialCatalogMergeCandidateState, created);

    const stale = decideCatalogMergeCandidate(state, {
      type: "MarkCatalogMergeCandidateStale",
      staleAt: "2026-06-24T10:07:00.000Z",
      reason: "Source Observation obs_tcgplayer_base1_43 was refreshed.",
      triggeredByObservationIds: ["obs_tcgplayer_base1_43"],
    })[0];

    expect(stale).toMatchObject({
      type: "catalog.merge-candidate.marked-stale",
      data: {
        reason: "Source Observation obs_tcgplayer_base1_43 was refreshed.",
        triggeredByObservationIds: ["obs_tcgplayer_base1_43"],
      },
    });
    expect(evolveCatalogMergeCandidate(state, stale)).toMatchObject({
      status: "stale",
      statusReason: "Source Observation obs_tcgplayer_base1_43 was refreshed.",
      staleAt: "2026-06-24T10:07:00.000Z",
    });
  });

  it("removes one observation from candidate membership without deleting the observation", () => {
    const created = decideCatalogMergeCandidate(initialCatalogMergeCandidateState, {
      type: "CreateCatalogMergeCandidate",
      candidateId: "cand_pokemon_en_base1_043_standard",
      snapshot: candidateSnapshot(),
      createdAt: "2026-06-24T10:00:00.000Z",
    })[0];
    const state = evolveCatalogMergeCandidate(initialCatalogMergeCandidateState, created);

    const removed = decideCatalogMergeCandidate(state, {
      type: "RemoveObservationFromCatalogMergeCandidate",
      observationId: "obs_tcgplayer_base1_43",
      reason: "Different variant.",
      removedAt: "2026-06-24T10:10:00.000Z",
    })[0];
    const updated = evolveCatalogMergeCandidate(state, removed);

    expect(removed).toMatchObject({
      type: "catalog.merge-candidate.observation-removed",
      data: {
        observationId: "obs_tcgplayer_base1_43",
        reason: "Different variant.",
      },
    });
    expect(updated.snapshot?.membership).toEqual([expect.objectContaining({ observationId: "obs_tcgdex_base1_43" })]);
    expect(updated).toMatchObject({
      status: "stale",
      statusReason: "Source Observation membership changed: Different variant.",
      staleAt: "2026-06-24T10:10:00.000Z",
    });
  });

  it("adds a new observation member and marks the candidate stale until refreshed", () => {
    const created = decideCatalogMergeCandidate(initialCatalogMergeCandidateState, {
      type: "CreateCatalogMergeCandidate",
      candidateId: "cand_pokemon_en_base1_043_standard",
      snapshot: candidateSnapshot({
        membership: [observationMember("obs_tcgdex_base1_43", "tcgdex", "base1-43")],
      }),
      createdAt: "2026-06-24T10:00:00.000Z",
    })[0];
    const state = evolveCatalogMergeCandidate(initialCatalogMergeCandidateState, created);

    const added = decideCatalogMergeCandidate(state, {
      type: "AddObservationToCatalogMergeCandidate",
      member: observationMember("obs_tcgplayer_base1_43", "tcgplayer", "product:42382"),
      updatedAt: "2026-06-24T10:12:00.000Z",
    })[0];
    const updated = evolveCatalogMergeCandidate(state, added);

    expect(updated).toMatchObject({
      status: "stale",
      statusReason: "Source Observation membership changed; refresh candidate before review.",
      staleAt: "2026-06-24T10:12:00.000Z",
    });
    expect(updated.snapshot?.membership.map((member) => member.observationId)).toEqual([
      "obs_tcgdex_base1_43",
      "obs_tcgplayer_base1_43",
    ]);
  });
});

function candidateSnapshot(
  overrides: Partial<CatalogMergeCandidateReviewSnapshot> = {},
): CatalogMergeCandidateReviewSnapshot {
  return {
    identityFingerprint: "sha256:pokemon:en:base1:43:standard",
    identity: {
      tcg: "pokemon",
      productLineName: "Pokemon TCG",
      setName: "Base Set",
      printedProductName: "Abra",
      collectorNumber: "43",
      languageCode: "en",
      productForm: "single-card",
      variantKey: "standard",
      barcode: null,
    },
    membership: [
      observationMember("obs_tcgdex_base1_43", "tcgdex", "base1-43"),
      observationMember("obs_tcgplayer_base1_43", "tcgplayer", "product:42382"),
    ],
    matches: {
      catalogItemId: null,
      productIds: [],
    },
    proposedCatalogItemFacts: {
      name: "Abra",
      expansionName: "Base Set",
      collectorNumber: "43",
    },
    proposedExternalCatalogItemReferences: [
      { providerKey: "tcgdex", externalKey: "base1-43" },
      { providerKey: "tcgplayer", externalKey: "product:42382" },
    ],
    proposedExternalProductReferences: [
      {
        providerKey: "tcgplayer",
        externalKey: "sku:114090",
        selectedOptions: [{ dimensionId: "dim_condition", optionId: "opt_near_mint" }],
        reviewEvidence: { providerVariantName: "Near Mint" },
      },
    ],
    conflicts: [],
    warnings: [
      {
        code: "image-source-differs",
        message: "Provider image URLs differ.",
        fieldPath: "catalogItem.imageUrls",
        observationIds: ["obs_tcgdex_base1_43", "obs_tcgplayer_base1_43"],
      },
    ],
    fieldProvenance: [
      {
        fieldPath: "catalogItem.name",
        value: "Abra",
        observationId: "obs_tcgdex_base1_43",
        providerKey: "tcgdex",
        sourceProfileKey: "pokemon-tcg",
        sourceProfileVersion: "2026.06.24",
        confidence: "exact",
        evidence: { sourceField: "name" },
      },
    ],
    promotionIntent: "create-catalog-item",
    ...overrides,
  };
}

function observationMember(
  observationId: string,
  providerKey: string,
  externalKey: string,
): CatalogMergeCandidateObservationMember {
  return {
    observationId,
    providerKey,
    externalKey,
    sourceRecordHash: `${observationId}-hash`,
    sourceProfileKey: providerKey === "tcgdex" ? "pokemon-tcg" : "tcgplayer-pokemon-card",
    sourceProfileVersion: "2026.06.24",
    sourceMappingFingerprint: `${providerKey}-mapping`,
    observedAt: "2026-06-24T09:50:00.000Z",
    addedAt: "2026-06-24T10:00:00.000Z",
  };
}
