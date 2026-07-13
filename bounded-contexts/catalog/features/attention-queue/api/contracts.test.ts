import { describe, expect, it } from "vitest";
import type { CatalogAliasCandidateRow } from "../../alias-equivalence/read-model/queries";
import type { ProviderScopeMappingRow } from "../../provider-scope-mapping/read-model/queries";
import type { CatalogScopeRecordRow } from "../../scope-registry/read-model/queries";
import type { CatalogMergeCandidateListRow } from "../../source-observations/read-model/queries";
import type { CatalogIntegrationControlPlaneUnitReadiness } from "../../source-observations/api/runtime";
import type { CatalogIntegrationUnitActivity } from "../../source-observations/api/admin-control-plane-overview";
import { assembleCatalogAttentionQueue, type CatalogAttentionQueueSources } from "./contracts";

const GENERATED_AT = "2026-07-09T12:00:00.000Z";

// One item of every kind so the assembler exercises all six collectors at once.
function sourcesWithOneOfEachKind(): CatalogAttentionQueueSources {
  return {
    proposedScopeMappings: [
      {
        mapping_id: "m1",
        scope_record_id: "s1",
        provider_key: "tcgplayer",
        unit_key: "u",
        set_id: "sv1",
        set_name: "SV",
        confidence: "candidate",
        review_status: "proposed",
        policy_version: "v1",
        proposed_at: "2026-07-01T00:00:00.000Z",
        updated_at: "2026-07-01T00:00:00.000Z",
        product_line_id: null,
        series_id: null,
        language_coordinates: {},
        provenance: {},
        evidence: {},
        last_actor: null,
        last_reason: null,
        reviewed_at: null,
      } satisfies ProviderScopeMappingRow,
    ],
    mergeCandidates: [
      {
        candidate_id: "c1",
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
        conflicts_json: [{ severity: "blocking" } as CatalogMergeCandidateListRow["conflicts_json"][number]],
        warnings_json: [],
        field_provenance_json: [],
        membership_json: [],
        promotion_intent: "create" as CatalogMergeCandidateListRow["promotion_intent"],
        created_at: "2026-07-02T00:00:00.000Z",
        updated_at: "2026-07-02T00:00:00.000Z",
        stale_at: null,
        observation_count: 2,
      },
    ],
    unitReadiness: [
      {
        unitKey: "u",
        providerKey: "tcgplayer",
        displayName: "Unit",
        productDomain: "pokemon",
        productForm: "sealed",
        ingestionPurpose: null,
        profileVersion: "v1",
        semanticReadiness: "ready",
        credentialReadiness: "blocked",
        credentialReadinessState: "expired",
        credentialRequirement: "required",
        credentialDiagnosticCode: "cred.expired",
        transportReadiness: "ready",
        fixtureValidationStatus: "ready",
        dryRunStatus: "completed",
        observationFacts: 0,
        diagnosticCounts: { info: 0, warning: 0, error: 1 },
        diagnostics: [],
        latestDiagnosticText: null,
        dryRunEvidence: [],
      } satisfies CatalogIntegrationControlPlaneUnitReadiness,
    ],
    unitActivity: [
      {
        unitKey: "u" as CatalogIntegrationUnitActivity["unitKey"],
        recentJobs: [
          {
            jobId: "j1",
            action: "import",
            operatorStatus: "failed",
            phase: "failed",
            completed: 0,
            total: 5,
            unitKey: "u" as CatalogIntegrationUnitActivity["unitKey"],
            providerKey: "tcgplayer",
            importScope: "en:pokemon:sv1",
            profileVersion: "v1",
            profileSnapshot: null,
            reapplyProfileMode: null,
            result: null,
            startedAt: "2026-07-08T00:00:00.000Z",
            createdAt: "2026-07-08T00:00:00.000Z",
            summary: "failed",
          },
        ],
      },
    ],
    pendingAliasCandidates: [
      {
        alias_hash: "h1",
        target_kind: "catalog-item",
        target_id: "i1",
        target_key: "i1",
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
        source_profile_key: "p",
        source_profile_version: "v1",
        mapping_fingerprint: "fp",
        evidence: {},
        first_observed_at: "2026-07-06T00:00:00.000Z",
        updated_at: "2026-07-06T00:00:00.000Z",
      } satisfies CatalogAliasCandidateRow,
    ],
    staleScopeRecords: [
      {
        scope_record_id: "s-stale",
        product_domain: "pokemon",
        scope_kind: "set",
        reference_type_key: "pokemon-set",
        reference_record_id: "r",
        reference_record_key: "sv1",
        name_i18n: {},
        name: "SV",
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
      } satisfies CatalogScopeRecordRow,
    ],
  };
}

describe("assembleCatalogAttentionQueue", () => {
  it("projects one item of every source kind into one severity-ordered queue", () => {
    const queue = assembleCatalogAttentionQueue(sourcesWithOneOfEachKind(), {
      generatedAt: GENERATED_AT,
      dismissedItemKeys: new Set(),
    });

    expect(queue.empty).toBe(false);
    expect(queue.counts.total).toBe(6);
    expect(new Set(queue.items.map((item) => item.kind))).toEqual(
      new Set([
        "unmapped-scope",
        "merge-conflict",
        "provider-health",
        "import-job",
        "alias-candidate",
        "stale-scope-sync",
      ]),
    );
    // Critical (merge-conflict, provider-health) sort ahead of warning ahead of info.
    expect(queue.items[0]!.severity).toBe("critical");
    expect(queue.items.at(-1)!.severity).toBe("info");
  });

  it("counts always match the rendered list length", () => {
    const queue = assembleCatalogAttentionQueue(sourcesWithOneOfEachKind(), {
      generatedAt: GENERATED_AT,
      dismissedItemKeys: new Set(),
    });
    const summed = queue.counts.bySeverity.critical + queue.counts.bySeverity.warning + queue.counts.bySeverity.info;
    expect(summed).toBe(queue.items.length);
    expect(queue.counts.total).toBe(queue.items.length);
  });

  it("excludes dismissed / deferred item keys and re-derives empty + counts", () => {
    const sources = sourcesWithOneOfEachKind();
    const all = assembleCatalogAttentionQueue(sources, { generatedAt: GENERATED_AT, dismissedItemKeys: new Set() });
    const parked = new Set(all.items.map((item) => item.itemKey));
    const queue = assembleCatalogAttentionQueue(sources, { generatedAt: GENERATED_AT, dismissedItemKeys: parked });
    expect(queue.empty).toBe(true);
    expect(queue.items).toHaveLength(0);
    expect(queue.counts.total).toBe(0);
  });

  it("labels freshness with the generation time and the observed-at bracket", () => {
    const queue = assembleCatalogAttentionQueue(sourcesWithOneOfEachKind(), {
      generatedAt: GENERATED_AT,
      dismissedItemKeys: new Set(),
    });
    expect(queue.freshness.generatedAt).toBe(GENERATED_AT);
    expect(queue.freshness.oldestObservedAt).toBe("2026-06-01T00:00:00.000Z");
    expect(queue.freshness.newestObservedAt).toBe(GENERATED_AT);
  });
});
