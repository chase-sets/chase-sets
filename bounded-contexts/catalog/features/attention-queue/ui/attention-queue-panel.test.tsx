// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
        scope_record_id: "s-merge",
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
    const acceptForm = document.querySelector('[data-attention-resolution="alias.accept"]');
    const rejectForm = document.querySelector('[data-attention-resolution="alias.reject"]');
    expect(acceptForm?.getAttribute("action")).toBe("/admin/integrations");
    expect(rejectForm).not.toBeNull();
    expect((acceptForm?.querySelector('input[name="_intent"]') as HTMLInputElement)?.value).toBe("alias.accept");
    expect((rejectForm?.querySelector('input[name="_intent"]') as HTMLInputElement)?.value).toBe("alias.reject");

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

  it("opens every drawer and exposes its exact destination or unavailable state", async () => {
    const user = userEvent.setup();
    const readModel = assembleCatalogAttentionQueue(oneOfEachKindSources(), {
      generatedAt: GENERATED_AT,
      dismissedItemKeys: new Set(),
    });
    render(<CatalogAttentionQueuePanel readModel={readModel} actionHref="/catalog/scopes" />);

    const cases = [
      ["Review mapping", "/catalog/scopes/s1"],
      ["Resolve conflict", "/catalog/scopes/s-merge"],
      ["Review health", "/catalog/providers/tcgplayer?unitKey=u"],
      ["Review job", "/catalog/providers/tcgplayer?jobId=j1"],
      ["Review scope", "/catalog/scopes/s-stale"],
    ] as const;
    for (const [label, href] of cases) {
      const triggers = screen.getAllByRole("button", { name: label });
      await user.click(triggers[triggers.length - 1]!);
      const destination = document.querySelector('[data-attention-destination="true"]') as HTMLAnchorElement | null;
      expect(destination?.getAttribute("href")).toBe(href);
      await user.click(screen.getByRole("button", { name: "Close" }));
    }

    const aliasTriggers = screen.getAllByRole("button", { name: "Accept" });
    await user.click(aliasTriggers[aliasTriggers.length - 1]!);
    expect(document.querySelector('[data-attention-destination="unavailable"]')).toBeNull();
    for (const [key, value] of Object.entries({ targetKind: "catalog-item", targetId: "i1", targetKey: "i1" })) {
      expect(screen.getByText(key).nextElementSibling?.textContent).toBe(value);
    }
  });

  it("mounts the generated conflict with no scope identity as unavailable instead of inventing a destination", async () => {
    const user = userEvent.setup();
    const sources = oneOfEachKindSources();
    const readModel = assembleCatalogAttentionQueue(
      { ...sources, mergeCandidates: sources.mergeCandidates.map((row) => ({ ...row, scope_record_id: undefined })) },
      { generatedAt: GENERATED_AT, dismissedItemKeys: new Set() },
    );
    render(<CatalogAttentionQueuePanel readModel={readModel} actionHref="/catalog/scopes" />);
    await user.click(screen.getAllByRole("button", { name: "Resolve conflict" }).at(-1)!);
    expect(screen.getByText(/Resolution unavailable/i)).toBeTruthy();
    expect(document.querySelector('[data-attention-destination="true"]')).toBeNull();
  });

  it.each([
    ["unmapped-scope", "Review mapping"],
    ["provider-health", "Review health"],
    ["import-job", "Review job"],
    ["stale-scope-sync", "Review scope"],
  ] as const)("mounts %s with absent destination identity as unavailable", async (kind, label) => {
    const user = userEvent.setup();
    const sources = oneOfEachKindSources();
    const readModel = assembleCatalogAttentionQueue(
      {
        ...sources,
        proposedScopeMappings:
          kind === "unmapped-scope"
            ? sources.proposedScopeMappings.map((row) => ({ ...row, scope_record_id: "" }))
            : sources.proposedScopeMappings,
        unitReadiness:
          kind === "provider-health"
            ? sources.unitReadiness.map((row) => ({ ...row, providerKey: "" }))
            : sources.unitReadiness,
        unitActivity:
          kind === "import-job"
            ? sources.unitActivity.map((unit) => ({
                ...unit,
                recentJobs: unit.recentJobs.map((job) => ({ ...job, providerKey: "" })),
              }))
            : sources.unitActivity,
        staleScopeRecords:
          kind === "stale-scope-sync"
            ? sources.staleScopeRecords.map((row) => ({ ...row, scope_record_id: "" }))
            : sources.staleScopeRecords,
      },
      { generatedAt: GENERATED_AT, dismissedItemKeys: new Set() },
    );
    expect(readModel.items.find((item) => item.kind === kind)?.resolution.unavailable).toBe(true);
    render(<CatalogAttentionQueuePanel readModel={readModel} actionHref="/catalog/scopes" />);
    await user.click(screen.getAllByRole("button", { name: label }).at(-1)!);
    expect(screen.getByText(/Resolution unavailable/i)).toBeTruthy();
    expect(document.querySelector('[data-attention-destination="true"]')).toBeNull();
  });

  it.each(["catalog-item", "reference-record"] as const)(
    "disables resolution for an alias with an absent %s target identity",
    async (targetKind) => {
      const user = userEvent.setup();
      const sources = oneOfEachKindSources();
      const readModel = assembleCatalogAttentionQueue(
        {
          ...sources,
          pendingAliasCandidates: sources.pendingAliasCandidates.map((row) => ({
            ...row,
            target_kind: targetKind,
            target_id: null,
          })),
        },
        { generatedAt: GENERATED_AT, dismissedItemKeys: new Set() },
      );
      render(<CatalogAttentionQueuePanel readModel={readModel} actionHref="/catalog/scopes" />);
      const forms = document.querySelectorAll<HTMLFormElement>("[data-attention-resolution]");
      expect(forms.length).toBeGreaterThan(0);
      for (const form of forms) expect(form.querySelector("button")?.disabled).toBe(true);
      await user.click(
        screen.getAllByRole("button", { name: "Accept" }).find((button) => !button.hasAttribute("disabled"))!,
      );
      expect(screen.getByText(/Resolution unavailable/i)).toBeTruthy();
      expect(document.querySelector('[data-attention-destination="true"]')).toBeNull();
    },
  );
});
