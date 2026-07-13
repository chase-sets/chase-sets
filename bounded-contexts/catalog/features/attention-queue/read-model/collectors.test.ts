import { describe, expect, it } from "vitest";
import type { CatalogAliasCandidateRow } from "../../alias-equivalence/read-model/queries";
import type { ProviderScopeMappingRow } from "../../provider-scope-mapping/read-model/queries";
import type { CatalogScopeRecordRow } from "../../scope-registry/read-model/queries";
import type { CatalogMergeCandidateListRow } from "../../source-observations/read-model/queries";
import type { CatalogIntegrationControlPlaneUnitReadiness } from "../../source-observations/api/runtime";
import type { CatalogIntegrationUnitActivity } from "../../source-observations/api/admin-control-plane-overview";
import {
  collectAliasCandidateItems,
  collectImportJobItems,
  collectMergeConflictItems,
  collectProviderHealthItems,
  collectStaleScopeSyncItems,
  collectUnmappedScopeItems,
} from "./collectors";

function scopeMapping(overrides: Partial<ProviderScopeMappingRow>): ProviderScopeMappingRow {
  return {
    mapping_id: "map-1",
    scope_record_id: "scope-1",
    provider_key: "tcgplayer",
    unit_key: "pokemon-sealed",
    product_line_id: null,
    series_id: null,
    set_id: "sv1",
    set_name: "Scarlet & Violet",
    language_coordinates: {},
    confidence: "candidate",
    review_status: "proposed",
    provenance: {},
    evidence: {},
    last_actor: null,
    last_reason: null,
    policy_version: "v1",
    proposed_at: "2026-07-01T00:00:00.000Z",
    reviewed_at: null,
    updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("collectUnmappedScopeItems", () => {
  it("surfaces only proposed mappings as warning items", () => {
    const items = collectUnmappedScopeItems([
      scopeMapping({ mapping_id: "m1", review_status: "proposed" }),
      scopeMapping({ mapping_id: "m2", review_status: "accepted" }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]!.itemKey).toBe("unmapped-scope:m1");
    expect(items[0]!.severity).toBe("warning");
    expect(items[0]!.resolution.mode).toBe("drawer");
  });
});

function mergeCandidate(overrides: Partial<CatalogMergeCandidateListRow>): CatalogMergeCandidateListRow {
  return {
    candidate_id: "cand-1",
    identity_fingerprint: "fp",
    sync_run_ids_json: [],
    status: "has-conflicts",
    status_reason: null,
    identity_json: {} as CatalogMergeCandidateListRow["identity_json"],
    matched_catalog_item_id: null,
    matched_product_ids_json: [],
    proposed_catalog_item_facts_json: {},
    proposed_external_catalog_item_references_json: [],
    proposed_external_product_references_json: [],
    conflicts_json: [],
    warnings_json: [],
    field_provenance_json: [],
    membership_json: [],
    promotion_intent: "create" as CatalogMergeCandidateListRow["promotion_intent"],
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-02T00:00:00.000Z",
    stale_at: null,
    observation_count: 3,
    ...overrides,
  };
}

describe("collectMergeConflictItems", () => {
  it("maps has-conflicts to critical and stale to warning; skips resolved statuses", () => {
    const items = collectMergeConflictItems([
      mergeCandidate({
        candidate_id: "c1",
        status: "has-conflicts",
        conflicts_json: [{ severity: "blocking" } as CatalogMergeCandidateListRow["conflicts_json"][number]],
      }),
      mergeCandidate({ candidate_id: "c2", status: "stale", stale_at: "2026-07-03T00:00:00.000Z" }),
      mergeCandidate({ candidate_id: "c3", status: "ready" }),
      mergeCandidate({ candidate_id: "c4", status: "promoted" }),
    ]);
    expect(items.map((entry) => entry.itemKey)).toEqual(["merge-conflict:c1", "merge-conflict:c2"]);
    expect(items[0]!.severity).toBe("critical");
    expect(items[1]!.severity).toBe("warning");
    expect(items[1]!.observedAt).toBe("2026-07-03T00:00:00.000Z");
  });
});

function unitReadiness(
  overrides: Partial<CatalogIntegrationControlPlaneUnitReadiness>,
): CatalogIntegrationControlPlaneUnitReadiness {
  return {
    unitKey: "pokemon-sealed",
    providerKey: "tcgplayer",
    displayName: "Pokémon Sealed",
    productDomain: "pokemon",
    productForm: "sealed",
    ingestionPurpose: null,
    profileVersion: "v1",
    semanticReadiness: "ready",
    credentialReadiness: "ready",
    credentialReadinessState: "configured",
    credentialRequirement: "required",
    credentialDiagnosticCode: null,
    transportReadiness: "ready",
    fixtureValidationStatus: "ready",
    dryRunStatus: "completed",
    observationFacts: 0,
    diagnosticCounts: { info: 0, warning: 0, error: 0 },
    diagnostics: [],
    latestDiagnosticText: null,
    dryRunEvidence: [],
    ...overrides,
  };
}

describe("collectProviderHealthItems", () => {
  it("flags blocked / error-severity units as critical and ignores ready units", () => {
    const items = collectProviderHealthItems(
      [
        unitReadiness({ unitKey: "u1", credentialReadiness: "blocked", credentialReadinessState: "expired" }),
        unitReadiness({ unitKey: "u2", transportReadiness: "blocked" }),
        unitReadiness({ unitKey: "u3", diagnosticCounts: { info: 0, warning: 0, error: 2 } }),
        unitReadiness({ unitKey: "u4" }),
      ],
      { generatedAt: "2026-07-09T00:00:00.000Z" },
    );
    expect(items.map((entry) => entry.detailParams.blocker)).toEqual(["credential", "transport", "diagnostic"]);
    expect(items.every((entry) => entry.severity === "critical")).toBe(true);
  });
});

function unitActivity(
  overrides: Partial<CatalogIntegrationUnitActivity["recentJobs"][number]>,
): CatalogIntegrationUnitActivity {
  return {
    unitKey: "pokemon-sealed" as CatalogIntegrationUnitActivity["unitKey"],
    recentJobs: [
      {
        jobId: "job-1",
        action: "import",
        operatorStatus: "failed",
        phase: "failed",
        completed: 0,
        total: 10,
        unitKey: "pokemon-sealed" as CatalogIntegrationUnitActivity["unitKey"],
        providerKey: "tcgplayer",
        importScope: "en:pokemon:sv1",
        profileVersion: "v1",
        profileSnapshot: null,
        reapplyProfileMode: null,
        result: null,
        startedAt: "2026-07-08T00:00:00.000Z",
        createdAt: "2026-07-08T00:00:00.000Z",
        summary: "failed import",
        ...overrides,
      },
    ],
  };
}

describe("collectImportJobItems", () => {
  it("maps failed jobs to critical and partial/stale to warning; skips completed", () => {
    const items = collectImportJobItems([
      unitActivity({ jobId: "j-failed", operatorStatus: "failed" }),
      unitActivity({ jobId: "j-partial", operatorStatus: "partial" }),
      unitActivity({ jobId: "j-stale", operatorStatus: "stale" }),
      unitActivity({ jobId: "j-ok", operatorStatus: "completed" }),
    ]);
    expect(items.map((entry) => `${entry.itemKey}:${entry.severity}`)).toEqual([
      "import-job:j-failed:critical",
      "import-job:j-partial:warning",
      "import-job:j-stale:warning",
    ]);
  });
});

function aliasCandidate(overrides: Partial<CatalogAliasCandidateRow>): CatalogAliasCandidateRow {
  return {
    alias_hash: "hash-1",
    target_kind: "catalog-item",
    target_id: "item-1",
    target_key: "item-1",
    alias_text: "Charizard",
    normalized_alias_text: "charizard",
    alias_language_code: "en",
    source_language_code: null,
    alias_type: "printed-name" as CatalogAliasCandidateRow["alias_type"],
    confidence: "candidate",
    review_status: "pending",
    provider_key: "tcgplayer",
    observation_id: null,
    source_category: "import",
    source_profile_key: "profile",
    source_profile_version: "v1",
    mapping_fingerprint: "fp",
    evidence: {},
    first_observed_at: "2026-07-06T00:00:00.000Z",
    updated_at: "2026-07-06T00:00:00.000Z",
    ...overrides,
  };
}

describe("collectAliasCandidateItems", () => {
  it("surfaces pending candidates as info with inline accept + reject", () => {
    const items = collectAliasCandidateItems([
      aliasCandidate({ alias_hash: "h1", review_status: "pending" }),
      aliasCandidate({ alias_hash: "h2", review_status: "auto-accepted" }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]!.severity).toBe("info");
    expect(items[0]!.resolution.intent).toBe("accept");
    expect(items[0]!.secondaryResolutions[0]!.intent).toBe("reject");
    expect(items[0]!.secondaryResolutions[0]!.requiresReason).toBe(true);
  });
});

function scopeRecord(overrides: Partial<CatalogScopeRecordRow>): CatalogScopeRecordRow {
  return {
    scope_record_id: "scope-1",
    product_domain: "pokemon",
    scope_kind: "set",
    reference_type_key: "pokemon-set",
    reference_record_id: "ref-1",
    reference_record_key: "sv1",
    name_i18n: {},
    name: "Scarlet & Violet",
    parent_scope_record_id: null,
    product_line_scope_record_id: null,
    series_scope_record_id: null,
    release_date: null,
    official_set_code: null,
    language_editions: [],
    attributes: {},
    relationships: [],
    lifecycle_status: "active",
    updated_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("collectStaleScopeSyncItems", () => {
  it("flags active scope records past the freshness window", () => {
    const items = collectStaleScopeSyncItems(
      [
        scopeRecord({ scope_record_id: "s-old", updated_at: "2026-06-01T00:00:00.000Z", lifecycle_status: "active" }),
        scopeRecord({ scope_record_id: "s-fresh", updated_at: "2026-07-09T00:00:00.000Z", lifecycle_status: "active" }),
        scopeRecord({ scope_record_id: "s-draft", updated_at: "2026-06-01T00:00:00.000Z", lifecycle_status: "draft" }),
      ],
      { now: "2026-07-09T00:00:00.000Z", stalenessThresholdMs: 7 * 24 * 60 * 60 * 1000 },
    );
    expect(items.map((entry) => entry.itemKey)).toEqual(["stale-scope-sync:s-old"]);
    expect(items[0]!.severity).toBe("warning");
  });
});
