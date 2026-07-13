// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { assembleCatalogAttentionQueue, type CatalogAttentionQueueSources } from "../api/contracts";
import type { CatalogAliasCandidateRow } from "../../alias-equivalence/read-model/queries";
import type { ProviderScopeMappingRow } from "../../provider-scope-mapping/read-model/queries";
import type { CatalogScopeRecordRow } from "../../scope-registry/read-model/queries";
import type { CatalogMergeCandidateListRow } from "../../source-observations/read-model/queries";
import type { CatalogIntegrationControlPlaneUnitReadiness } from "../../source-observations/api/runtime";
import type { CatalogIntegrationUnitActivity } from "../../source-observations/api/admin-control-plane-overview";
import { CatalogAttentionQueuePanel } from "./attention-queue-panel";

afterEach(cleanup);

const GENERATED_AT = "2026-07-09T12:00:00.000Z";

// One item of every source kind — the AC4 e2e seed, exercised at the render tier.
function oneOfEachKindSources(): CatalogAttentionQueueSources {
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

describe("CatalogAttentionQueuePanel", () => {
  it("renders one row of every source kind with an inline resolution control", () => {
    const readModel = assembleCatalogAttentionQueue(oneOfEachKindSources(), {
      generatedAt: GENERATED_AT,
      dismissedItemKeys: new Set(),
    });
    render(<CatalogAttentionQueuePanel readModel={readModel} actionHref="/admin/integrations" />);

    // Every kind label badge is present — all six sources rendered in one queue.
    for (const label of [
      "Unmapped scope",
      "Merge conflict",
      "Provider health",
      "Import job",
      "Alias candidate",
      "Stale scope sync",
    ]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }

    // Alias candidates carry an inline accept + reject that POST to the daily
    // action (no navigation to another surface).
    const acceptForm = document.querySelector('[data-attention-resolution="accept"]');
    const rejectForm = document.querySelector('[data-attention-resolution="reject"]');
    expect(acceptForm?.getAttribute("action")).toBe("/admin/integrations");
    expect(rejectForm).not.toBeNull();

    // Every item exposes an inline drawer trigger (evidence + park), so each is
    // resolvable without leaving the home surface.
    const table = screen.getByRole("table");
    const rows = within(table)
      .getAllByRole("row")
      .filter((row) => within(row).queryAllByRole("button").length > 0);
    expect(rows.length).toBe(readModel.items.length);
  });

  it("shows the first-class zero-state when the queue is empty", () => {
    const readModel = assembleCatalogAttentionQueue(
      {
        proposedScopeMappings: [],
        mergeCandidates: [],
        unitReadiness: [],
        unitActivity: [],
        pendingAliasCandidates: [],
        staleScopeRecords: [],
      },
      { generatedAt: GENERATED_AT, dismissedItemKeys: new Set() },
    );
    render(<CatalogAttentionQueuePanel readModel={readModel} actionHref="/admin/integrations" />);
    expect(screen.getByText(/running itself/i)).toBeTruthy();
  });
});
