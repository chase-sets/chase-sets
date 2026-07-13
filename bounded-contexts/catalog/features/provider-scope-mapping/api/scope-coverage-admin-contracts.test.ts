import { describe, expect, it } from "vitest";
import {
  buildScopeCoverageMatrix,
  buildUnmappedScopeInboxReadModel,
  computeScopeCoverageState,
  mapProviderScopeMappingCandidate,
} from "./scope-coverage-admin-contracts";
import type { ProviderScopeMappingWithScopeRow } from "../read-model/scope-coverage-queries";
import type { ProviderScopeMappingRow } from "../read-model/queries";

function candidateRow(overrides: Partial<ProviderScopeMappingRow> = {}): ProviderScopeMappingRow {
  return {
    mapping_id: "map_1",
    scope_record_id: "ref_expansion_paldean_fates",
    provider_key: "tcgdex",
    unit_key: "pokemon-card-import",
    product_line_id: null,
    series_id: null,
    set_id: "sv4-5",
    set_name: "Paldean Fates",
    language_coordinates: { languageCode: "en" },
    confidence: "exact",
    review_status: "proposed",
    provenance: {
      source: "option-sync",
      sourceId: null,
      sourceProfileKey: null,
      sourceProfileVersion: null,
      mappingFingerprint: null,
    },
    evidence: {},
    last_actor: null,
    last_reason: null,
    policy_version: "provider-scope-mapping-v1",
    proposed_at: "2026-07-01T00:00:00.000Z",
    reviewed_at: null,
    updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function inboxRow(overrides: Partial<ProviderScopeMappingWithScopeRow> = {}): ProviderScopeMappingWithScopeRow {
  const base = candidateRow(overrides);
  return {
    ...base,
    scope_product_domain: "pokemon",
    scope_kind: "expansion",
    scope_name: "Paldean Fates",
    scope_official_set_code: "PAF",
    scope_release_date: "2024-01-26",
    scope_lifecycle_status: "active",
    ...overrides,
  };
}

describe("mapProviderScopeMappingCandidate", () => {
  it("flags exact/high confidence as high-confidence and proposed as reviewable", () => {
    const summary = mapProviderScopeMappingCandidate(candidateRow({ confidence: "exact", review_status: "proposed" }));
    expect(summary.highConfidence).toBe(true);
    expect(summary.reviewable).toBe(true);
    expect(summary.coordinates.setId).toBe("sv4-5");
  });

  it("does not flag candidate/generated confidence as high-confidence", () => {
    const summary = mapProviderScopeMappingCandidate(candidateRow({ confidence: "candidate" }));
    expect(summary.highConfidence).toBe(false);
  });

  it("marks accepted mappings as no longer reviewable", () => {
    const summary = mapProviderScopeMappingCandidate(candidateRow({ review_status: "accepted" }));
    expect(summary.reviewable).toBe(false);
  });
});

describe("buildUnmappedScopeInboxReadModel", () => {
  it("groups proposals by scope record and counts high-confidence candidates", () => {
    const rows = [
      inboxRow({ mapping_id: "map_1", provider_key: "tcgdex", confidence: "exact" }),
      inboxRow({ mapping_id: "map_2", provider_key: "scrydex", confidence: "candidate" }),
      inboxRow({
        mapping_id: "map_3",
        scope_record_id: "ref_expansion_temporal_forces",
        scope_name: "Temporal Forces",
        provider_key: "tcgdex",
        confidence: "high",
      }),
    ];

    const model = buildUnmappedScopeInboxReadModel({ generatedAt: "2026-07-13T00:00:00.000Z", rows });

    expect(model.counts.totalGroups).toBe(2);
    expect(model.counts.totalCandidates).toBe(3);
    expect(model.counts.highConfidenceCandidates).toBe(2);

    const paldeanFates = model.groups.find((group) => group.scopeRecordId === "ref_expansion_paldean_fates");
    expect(paldeanFates?.candidates).toHaveLength(2);
    expect(paldeanFates?.counts).toEqual({ total: 2, highConfidence: 1 });
  });

  it("marks a group as a draft canonical record pending confirmation", () => {
    const rows = [inboxRow({ scope_lifecycle_status: "draft" })];
    const model = buildUnmappedScopeInboxReadModel({ generatedAt: "2026-07-13T00:00:00.000Z", rows });
    expect(model.groups[0]?.isDraftCanonicalRecord).toBe(true);
  });

  it("returns an empty read model for no pending proposals", () => {
    const model = buildUnmappedScopeInboxReadModel({ generatedAt: "2026-07-13T00:00:00.000Z", rows: [] });
    expect(model.groups).toEqual([]);
    expect(model.counts).toEqual({ totalGroups: 0, totalCandidates: 0, highConfidenceCandidates: 0 });
  });
});

describe("computeScopeCoverageState", () => {
  const proposed = mapProviderScopeMappingCandidate(candidateRow({ review_status: "proposed" }));
  const accepted = mapProviderScopeMappingCandidate(candidateRow({ review_status: "accepted" }));
  const autoAccepted = mapProviderScopeMappingCandidate(candidateRow({ review_status: "auto-accepted" }));
  const rejected = mapProviderScopeMappingCandidate(candidateRow({ review_status: "rejected" }));

  it("is not-offered with no mapping at all", () => {
    expect(computeScopeCoverageState({ mapping: null, syncedObservations: 0, promotedObservations: 0 })).toBe(
      "not-offered",
    );
  });

  it("is not-offered when the only mapping was rejected", () => {
    expect(computeScopeCoverageState({ mapping: rejected, syncedObservations: 0, promotedObservations: 0 })).toBe(
      "not-offered",
    );
  });

  it("is available when a mapping is proposed but not accepted", () => {
    expect(computeScopeCoverageState({ mapping: proposed, syncedObservations: 0, promotedObservations: 0 })).toBe(
      "available",
    );
  });

  it("is mapped when accepted with no sync yet", () => {
    expect(computeScopeCoverageState({ mapping: accepted, syncedObservations: 0, promotedObservations: 0 })).toBe(
      "mapped",
    );
  });

  it("is synced when accepted and observations exist but none are promoted", () => {
    expect(computeScopeCoverageState({ mapping: accepted, syncedObservations: 12, promotedObservations: 0 })).toBe(
      "synced",
    );
  });

  it("is settled when at least one observation has been promoted", () => {
    expect(computeScopeCoverageState({ mapping: autoAccepted, syncedObservations: 12, promotedObservations: 3 })).toBe(
      "settled",
    );
  });
});

describe("buildScopeCoverageMatrix", () => {
  it("computes one row per provider using the accepted mapping when one exists, else the latest", async () => {
    const scope = {
      scope_record_id: "ref_expansion_paldean_fates",
      product_domain: "pokemon" as const,
      scope_kind: "expansion" as const,
      name: "Paldean Fates",
      official_set_code: "PAF",
      release_date: "2024-01-26",
      lifecycle_status: "active" as const,
    };
    const mappingRows: ProviderScopeMappingWithScopeRow[] = [
      inboxRow({ mapping_id: "map_1", provider_key: "tcgdex", review_status: "accepted" }),
      inboxRow({ mapping_id: "map_2", provider_key: "scrydex", review_status: "proposed" }),
      inboxRow({ mapping_id: "map_3", provider_key: "scryfall", review_status: "rejected" }),
    ];

    const matrix = await buildScopeCoverageMatrix({
      generatedAt: "2026-07-13T00:00:00.000Z",
      scope,
      mappingRows,
      loadSyncStatus: async (row) =>
        row.provider_key === "tcgdex"
          ? { totalObservations: 5, promotedObservations: 2 }
          : { totalObservations: 0, promotedObservations: 0 },
    });

    expect(matrix.providers).toHaveLength(3);
    const byProvider = Object.fromEntries(matrix.providers.map((row) => [row.providerKey, row]));
    expect(byProvider.tcgdex?.state).toBe("settled");
    expect(byProvider.scrydex?.state).toBe("available");
    expect(byProvider.scryfall?.state).toBe("not-offered");
  });

  it("returns an empty provider list when no mapping row exists for the scope", async () => {
    const scope = {
      scope_record_id: "ref_expansion_paldean_fates",
      product_domain: "pokemon" as const,
      scope_kind: "expansion" as const,
      name: "Paldean Fates",
      official_set_code: "PAF",
      release_date: "2024-01-26",
      lifecycle_status: "active" as const,
    };

    const matrix = await buildScopeCoverageMatrix({
      generatedAt: "2026-07-13T00:00:00.000Z",
      scope,
      mappingRows: [],
      loadSyncStatus: async () => ({ totalObservations: 0, promotedObservations: 0 }),
    });

    expect(matrix.providers).toEqual([]);
  });
});
