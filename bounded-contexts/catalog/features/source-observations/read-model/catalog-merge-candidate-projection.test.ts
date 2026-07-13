import { describe, expect, it, vi } from "vitest";
import type {
  CatalogMergeCandidateObservationMember,
  CatalogMergeCandidateReviewSnapshot,
} from "../domain/catalog-merge-candidate";
import { buildCatalogMergeCandidateProjectionHandlers } from "./catalog-merge-candidate-projection";

describe("Catalog Merge Candidate projections", () => {
  it("projects candidate snapshots for admin review and promotion planning", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] }));
    const handlers = buildCatalogMergeCandidateProjectionHandlers({ query });

    await handlers["catalog.merge-candidate.created"]?.({
      streamId: "catalog.merge-candidate-cand_pokemon_en_base1_043_standard",
      data: {
        candidateId: "cand_pokemon_en_base1_043_standard",
        status: "ready",
        snapshot: candidateSnapshot(),
        createdAt: "2026-06-24T10:00:00.000Z",
      },
      timing: { recordedAt: "2026-06-24T10:00:01.000Z" },
    } as never);

    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining("INSERT INTO catalog_merge_candidates"), [
      "cand_pokemon_en_base1_043_standard",
      "scope_base_set",
      "sha256:pokemon:en:base1:43:standard",
      JSON.stringify(candidateSnapshot().syncRunIds),
      "ready",
      null,
      JSON.stringify(candidateSnapshot().identity),
      null,
      JSON.stringify([]),
      JSON.stringify(candidateSnapshot().proposedCatalogItemFacts),
      JSON.stringify(candidateSnapshot().proposedExternalCatalogItemReferences),
      JSON.stringify(candidateSnapshot().proposedExternalProductReferences),
      JSON.stringify([]),
      JSON.stringify(candidateSnapshot().warnings),
      JSON.stringify(candidateSnapshot().fieldProvenance),
      "create-catalog-item",
      "2026-06-24T10:00:00.000Z",
      "2026-06-24T10:00:01.000Z",
      null,
    ]);
    expect(query.mock.calls[0]?.[0]).toContain("ON CONFLICT (candidate_id) DO UPDATE");
    expect(query.mock.calls[1]).toEqual([
      expect.stringContaining("DELETE FROM catalog_merge_candidate_observations WHERE candidate_id = $1"),
      ["cand_pokemon_en_base1_043_standard"],
    ]);
    expect(query.mock.calls[2]?.[0]).toContain("INSERT INTO catalog_merge_candidate_observations");
    expect(query.mock.calls[3]?.[0]).toContain("INSERT INTO catalog_merge_candidate_observations");
  });

  it("refreshes conflict and provenance display data", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] }));
    const handlers = buildCatalogMergeCandidateProjectionHandlers({ query });
    const snapshot = candidateSnapshot({
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
    });

    await handlers["catalog.merge-candidate.refreshed"]?.({
      streamId: "catalog.merge-candidate-cand_pokemon_en_base1_043_standard",
      data: {
        status: "has-conflicts",
        snapshot,
        refreshedAt: "2026-06-24T10:05:00.000Z",
      },
      timing: { recordedAt: "2026-06-24T10:05:01.000Z" },
    } as never);

    expect(query.mock.calls[0]?.[0]).toContain("INSERT INTO catalog_merge_candidates");
    expect(query.mock.calls[0]?.[1]?.[0]).toBe("cand_pokemon_en_base1_043_standard");
    expect(query.mock.calls[0]?.[1]?.[4]).toBe("has-conflicts");
    expect(query.mock.calls[0]?.[1]?.[12]).toBe(JSON.stringify(snapshot.conflicts));
    expect(query.mock.calls[0]?.[1]?.[14]).toBe(JSON.stringify(snapshot.fieldProvenance));
  });

  it("marks stale candidates without changing Source Observation rows", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] }));
    const handlers = buildCatalogMergeCandidateProjectionHandlers({ query });

    await handlers["catalog.merge-candidate.marked-stale"]?.({
      streamId: "catalog.merge-candidate-cand_pokemon_en_base1_043_standard",
      data: {
        reason: "Source Observation obs_tcgplayer_base1_43 was refreshed.",
        staleAt: "2026-06-24T10:07:00.000Z",
        triggeredByObservationIds: ["obs_tcgplayer_base1_43"],
      },
      timing: { recordedAt: "2026-06-24T10:07:01.000Z" },
    } as never);

    expect(query).toHaveBeenCalledWith(expect.stringContaining("SET status = 'stale'"), [
      "cand_pokemon_en_base1_043_standard",
      "Source Observation obs_tcgplayer_base1_43 was refreshed.",
      "2026-06-24T10:07:00.000Z",
      "2026-06-24T10:07:01.000Z",
    ]);
    expect(query.mock.calls[0]?.[0]).not.toContain("catalog_source_observations");
  });

  it("removes candidate membership without deleting the observation record", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] }));
    const handlers = buildCatalogMergeCandidateProjectionHandlers({ query });

    await handlers["catalog.merge-candidate.observation-removed"]?.({
      streamId: "catalog.merge-candidate-cand_pokemon_en_base1_043_standard",
      data: {
        observationId: "obs_tcgplayer_base1_43",
        reason: "Different variant.",
        removedAt: "2026-06-24T10:10:00.000Z",
      },
      timing: { recordedAt: "2026-06-24T10:10:01.000Z" },
    } as never);

    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("DELETE FROM catalog_merge_candidate_observations"),
      ["cand_pokemon_en_base1_043_standard", "obs_tcgplayer_base1_43"],
    );
    expect(query.mock.calls[0]?.[0]).not.toContain("catalog_source_observations");
    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining("SET status = 'stale'"), [
      "cand_pokemon_en_base1_043_standard",
      "Source Observation membership changed: Different variant.",
      "2026-06-24T10:10:00.000Z",
      "2026-06-24T10:10:01.000Z",
    ]);
  });

  it("projects candidate review actions without mutating Source Observations", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] }));
    const handlers = buildCatalogMergeCandidateProjectionHandlers({ query });

    await handlers["catalog.merge-candidate.ignored"]?.({
      streamId: "catalog.merge-candidate-cand_pokemon_en_base1_043_standard",
      data: {
        audit: {
          reason: "Provider grouping is not a Catalog Item.",
        },
        ignoredAt: "2026-06-24T10:45:00.000Z",
      },
      timing: { recordedAt: "2026-06-24T10:45:01.000Z" },
    } as never);
    await handlers["catalog.merge-candidate.deferred"]?.({
      streamId: "catalog.merge-candidate-cand_pokemon_en_base1_043_standard",
      data: {
        audit: {
          reason: "Waiting for SKU evidence.",
        },
        deferredAt: "2026-06-24T10:50:00.000Z",
      },
      timing: { recordedAt: "2026-06-24T10:50:01.000Z" },
    } as never);

    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining("SET status = $2"), [
      "cand_pokemon_en_base1_043_standard",
      "rejected",
      "Candidate ignored: Provider grouping is not a Catalog Item.",
      "2026-06-24T10:45:01.000Z",
    ]);
    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining("SET status = $2"), [
      "cand_pokemon_en_base1_043_standard",
      "deferred",
      "Waiting for SKU evidence.",
      "2026-06-24T10:50:01.000Z",
    ]);
    expect(query.mock.calls.flatMap((call) => call[0])).not.toContain("catalog_source_observations");
  });

  it("projects split candidates as separate review rows with separate memberships", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] }));
    const handlers = buildCatalogMergeCandidateProjectionHandlers({ query });
    const remainingSnapshot = candidateSnapshot({
      membership: [observationMember("obs_tcgdex_base1_43", "tcgdex", "base1-43")],
      proposedExternalCatalogItemReferences: [{ providerKey: "tcgdex", externalKey: "base1-43" }],
      proposedExternalProductReferences: [],
    });
    const splitSnapshot = candidateSnapshot({
      identityFingerprint: "sha256:pokemon:en:base1:43:tcgplayer",
      membership: [observationMember("obs_tcgplayer_base1_43", "tcgplayer", "product:42382")],
      proposedExternalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: "product:42382" }],
    });

    await handlers["catalog.merge-candidate.split"]?.({
      streamId: "catalog.merge-candidate-cand_pokemon_en_base1_043_standard",
      data: {
        status: "ready",
        remainingSnapshot,
        splitCandidateId: "cand_pokemon_en_base1_043_tcgplayer",
        splitSnapshot,
        audit: {
          reason: "Different variant.",
        },
        splitAt: "2026-06-24T10:30:00.000Z",
      },
      timing: { recordedAt: "2026-06-24T10:30:01.000Z" },
    } as never);

    expect(query.mock.calls[0]?.[0]).toContain("INSERT INTO catalog_merge_candidates");
    expect(query.mock.calls[0]?.[1]?.[0]).toBe("cand_pokemon_en_base1_043_standard");
    expect(query.mock.calls[0]?.[1]?.[5]).toBe("Candidate split: Different variant.");
    expect(query.mock.calls[3]?.[0]).toContain("INSERT INTO catalog_merge_candidates");
    expect(query.mock.calls[3]?.[1]?.[0]).toBe("cand_pokemon_en_base1_043_tcgplayer");
    expect(query.mock.calls[3]?.[1]?.[5]).toBe(
      "Candidate split from cand_pokemon_en_base1_043_standard: Different variant.",
    );
    expect(query.mock.calls[2]?.[1]?.[1]).toBe("obs_tcgdex_base1_43");
    expect(query.mock.calls[5]?.[1]?.[1]).toBe("obs_tcgplayer_base1_43");
  });
});

function candidateSnapshot(
  overrides: Partial<CatalogMergeCandidateReviewSnapshot> = {},
): CatalogMergeCandidateReviewSnapshot {
  return {
    identityFingerprint: "sha256:pokemon:en:base1:43:standard",
    syncRunIds: ["job_sync_base1"],
    identity: {
      scopeRecordId: "scope_base_set",
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
    syncRunId: "job_sync_base1",
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
