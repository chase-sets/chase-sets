// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { assembleCatalogAttentionQueue, type CatalogAttentionQueueSources } from "../api/contracts";
import type { CatalogAliasCandidateAttentionRow } from "../../alias-equivalence/read-model/queries";
import type { ProviderScopeMappingAttentionRow } from "../../provider-scope-mapping/read-model/queries";
import type { CatalogIntegrationControlPlaneUnitReadiness } from "../../source-observations/api/runtime";
import type { CatalogIntegrationUnitActivity } from "../../source-observations/api/admin-control-plane-overview";
import { CATALOG_ATTENTION_SUMMARY_WINDOW, type CatalogAttentionQueueWindow } from "../read-model/attention-item";
import { CatalogAttentionQueuePanel } from "./attention-queue-panel";

afterEach(cleanup);

const GENERATED_AT = "2026-07-09T12:00:00.000Z";

function scopeMappingRow(mappingId: string): ProviderScopeMappingAttentionRow {
  return {
    mapping_id: mappingId,
    scope_record_id: "s1",
    provider_key: "tcgplayer",
    unit_key: "u",
    set_id: "sv1",
    set_name: "SV",
    confidence: "candidate",
    review_status: "proposed",
    proposed_at: "2026-07-01T00:00:00.000Z",
  };
}

// One item of every source kind — the AC4 e2e seed, exercised at the render tier.
function oneOfEachKindSources(): CatalogAttentionQueueSources {
  return {
    proposedScopeMappings: { total: 1, rows: [scopeMappingRow("m1")] },
    mergeCandidates: {
      conflictTotal: 1,
      staleTotal: 0,
      rows: [
        {
          candidate_id: "c1",
          scope_record_id: "s-merge",
          status: "has-conflicts",
          status_reason: null,
          blocking_conflict_count: 1,
          observation_count: 2,
          created_at: "2026-07-02T00:00:00.000Z",
          updated_at: "2026-07-02T00:00:00.000Z",
          stale_at: null,
        },
      ],
    },
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
    importJobs: {
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
      completeness: "complete",
    },
    pendingAliasCandidates: {
      total: 1,
      rows: [
        {
          alias_hash: "h1",
          target_kind: "catalog-item",
          target_id: "i1",
          target_key: "i1",
          alias_text: "Charizard",
          alias_type: "printed-name" as CatalogAliasCandidateAttentionRow["alias_type"],
          confidence: "candidate",
          review_status: "pending",
          provider_key: "tcgplayer",
          first_observed_at: "2026-07-06T00:00:00.000Z",
        },
      ],
    },
    staleScopeRecords: {
      total: 1,
      rows: [
        {
          scope_record_id: "s-stale",
          product_domain: "pokemon",
          scope_kind: "set",
          name: "SV",
          lifecycle_status: "active",
          updated_at: "2026-06-01T00:00:00.000Z",
        },
      ],
    },
  };
}

function emptySources(completeness: "complete" | "incomplete"): CatalogAttentionQueueSources {
  return {
    proposedScopeMappings: { total: 0, rows: [] },
    mergeCandidates: { conflictTotal: 0, staleTotal: 0, rows: [] },
    unitReadiness: [],
    importJobs: { unitActivity: [], completeness },
    pendingAliasCandidates: { total: 0, rows: [] },
    staleScopeRecords: { total: 0, rows: [] },
  };
}

// 5,027 proposed mappings with one window of rows, plus one pending alias.
function largeCohortSources(window: CatalogAttentionQueueWindow): CatalogAttentionQueueSources {
  const mappingWindow = window.kind === null || window.kind === "unmapped-scope" ? window : { offset: 0, limit: 0 };
  const returned = Math.max(0, Math.min(mappingWindow.limit, 5027 - mappingWindow.offset));
  return {
    ...emptySources("complete"),
    proposedScopeMappings: {
      total: 5027,
      rows: Array.from({ length: returned }, (_, index) =>
        scopeMappingRow(`m${String(mappingWindow.offset + index).padStart(5, "0")}`),
      ),
    },
    pendingAliasCandidates: {
      total: 1,
      rows: window.kind === null ? oneOfEachKindSources().pendingAliasCandidates.rows : [],
    },
  };
}

function assemble(sources: CatalogAttentionQueueSources, window = CATALOG_ATTENTION_SUMMARY_WINDOW) {
  return assembleCatalogAttentionQueue(sources, {
    generatedAt: GENERATED_AT,
    parkedObservedItemKeys: new Set(),
    window,
  });
}

function coverageRow(kind: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`[data-attention-coverage-kind="${kind}"]`);
  expect(row).not.toBeNull();
  return row!;
}

function pageLinks(): Array<Readonly<{ page: string | null; href: string | null }>> {
  return [...document.querySelectorAll("[data-attention-page]")].map((link) => ({
    page: link.getAttribute("data-attention-page"),
    href: link.getAttribute("href"),
  }));
}

const SCOPES_NAVIGATION = { pathname: "/catalog/scopes", search: "productDomain=pokemon&page=3" } as const;

describe("CatalogAttentionQueuePanel", () => {
  it("renders one row of every source kind with an inline resolution control", () => {
    const readModel = assemble(oneOfEachKindSources());
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
    // The one-click intents are unchanged (the table renders each row once per layout).
    expect(
      new Set(
        [...document.querySelectorAll("[data-attention-resolution]")].map((form) =>
          form.getAttribute("data-attention-resolution"),
        ),
      ),
    ).toEqual(new Set(["alias.accept", "alias.reject"]));

    // Every item exposes an inline drawer trigger (evidence + park), so each is
    // resolvable without leaving the home surface.
    const table = screen.getByRole("table");
    const rows = within(table)
      .getAllByRole("row")
      .filter((row) => within(row).queryAllByRole("button").length > 0);
    expect(rows.length).toBe(readModel.items.length);
    expect(screen.getByText("6 need you")).toBeTruthy();
  });

  it("shows the first-class zero-state only when the queue is a complete zero", () => {
    render(
      <CatalogAttentionQueuePanel readModel={assemble(emptySources("complete"))} actionHref="/admin/integrations" />,
    );
    expect(screen.getByText(/running itself/i)).toBeTruthy();
    expect(document.querySelector('[data-attention-incomplete="true"]')).toBeNull();
  });

  it("shows unknown work instead of the empty state when the job snapshot was incomplete", () => {
    render(
      <CatalogAttentionQueuePanel readModel={assemble(emptySources("incomplete"))} actionHref="/admin/integrations" />,
    );
    expect(screen.queryByText(/running itself/i)).toBeNull();
    expect(screen.getByText("At least 0 need you")).toBeTruthy();
    const incomplete = document.querySelector('[data-attention-incomplete="true"]');
    expect(incomplete?.textContent).toContain("Some import jobs could not be checked.");
  });

  it("labels an exact cohort beside its window: showing 20 of 5,027", () => {
    render(
      <CatalogAttentionQueuePanel
        readModel={assemble(largeCohortSources(CATALOG_ATTENTION_SUMMARY_WINDOW))}
        actionHref="/admin/integrations"
      />,
    );
    expect(screen.getByText("5,028 need you")).toBeTruthy();
    expect(within(coverageRow("unmapped-scope")).getByText("Showing 20 of 5,027")).toBeTruthy();
    expect(within(coverageRow("alias-candidate")).getByText("Showing 1 of 1")).toBeTruthy();
    expect(document.querySelector('[data-attention-coverage-kind="merge-conflict"]')).toBeNull();
    expect(screen.getAllByText("5,027").length).toBeGreaterThan(0);
    expect(screen.queryByText(/at least/i)).toBeNull();
  });

  it("labels lower-bound totals as at least N", () => {
    const sources = oneOfEachKindSources();
    const readModel = assemble({ ...sources, importJobs: { ...sources.importJobs, completeness: "incomplete" } });
    render(<CatalogAttentionQueuePanel readModel={readModel} actionHref="/admin/integrations" />);

    expect(screen.getByText("At least 6 need you")).toBeTruthy();
    expect(within(coverageRow("import-job")).getByText("Showing 1 of at least 1")).toBeTruthy();
    expect(within(coverageRow("import-job")).getByText("Some import jobs could not be checked.")).toBeTruthy();
    // Jobs can be critical or warning, so both bands become lower bounds; queued stays exact.
    expect(screen.getByText("At least 2")).toBeTruthy();
    expect(screen.getByText("At least 3")).toBeTruthy();
    expect(within(coverageRow("alias-candidate")).getByText("Showing 1 of 1")).toBeTruthy();
  });

  it("shows no page links on a mount without navigation", () => {
    render(
      <CatalogAttentionQueuePanel
        readModel={assemble(largeCohortSources(CATALOG_ATTENTION_SUMMARY_WINDOW))}
        actionHref="/admin/integrations"
      />,
    );
    expect(within(coverageRow("unmapped-scope")).getByText("Showing 20 of 5,027")).toBeTruthy();
    expect(pageLinks()).toEqual([]);
  });

  it("links the next page of a kind while keeping the host page's own parameters", () => {
    render(
      <CatalogAttentionQueuePanel
        readModel={assemble(largeCohortSources(CATALOG_ATTENTION_SUMMARY_WINDOW))}
        actionHref="/catalog/scopes"
        navigation={SCOPES_NAVIGATION}
      />,
    );
    expect(pageLinks()).toEqual([
      {
        page: "next",
        href: "/catalog/scopes?productDomain=pokemon&page=3&attentionKind=unmapped-scope&attentionOffset=20",
      },
    ]);
  });

  it("pages one kind with previous, next, show and summary links", () => {
    const window = { kind: "unmapped-scope", offset: 20, limit: 20 } as const;
    render(
      <CatalogAttentionQueuePanel
        readModel={assemble(largeCohortSources(window), window)}
        actionHref="/catalog/scopes"
        navigation={SCOPES_NAVIGATION}
      />,
    );
    expect(within(coverageRow("unmapped-scope")).getByText("Showing 21 to 40 of 5,027")).toBeTruthy();
    expect(within(coverageRow("alias-candidate")).getByText("None of 1 on this page")).toBeTruthy();
    expect(screen.getAllByRole("row").length).toBeGreaterThan(20);
    expect(pageLinks()).toEqual([
      { page: "previous", href: "/catalog/scopes?productDomain=pokemon&page=3&attentionKind=unmapped-scope" },
      {
        page: "next",
        href: "/catalog/scopes?productDomain=pokemon&page=3&attentionKind=unmapped-scope&attentionOffset=40",
      },
      { page: "show", href: "/catalog/scopes?productDomain=pokemon&page=3&attentionKind=alias-candidate" },
      { page: "summary", href: "/catalog/scopes?productDomain=pokemon&page=3" },
    ]);
  });

  it("explains an empty page past the end of a kind and links back", () => {
    const window = { kind: "unmapped-scope", offset: 6000, limit: 20 } as const;
    render(
      <CatalogAttentionQueuePanel
        readModel={assemble(largeCohortSources(window), window)}
        actionHref="/catalog/scopes"
        navigation={SCOPES_NAVIGATION}
      />,
    );
    expect(within(coverageRow("unmapped-scope")).getByText("None of 5,027 on this page")).toBeTruthy();
    expect(screen.getByText("Nothing on this page")).toBeTruthy();
    expect(screen.queryByText(/running itself/i)).toBeNull();
    expect(pageLinks()).toContainEqual({
      page: "previous",
      href: "/catalog/scopes?productDomain=pokemon&page=3&attentionKind=unmapped-scope&attentionOffset=5980",
    });
  });

  it("opens every drawer and exposes its exact destination or unavailable state", async () => {
    const user = userEvent.setup();
    render(<CatalogAttentionQueuePanel readModel={assemble(oneOfEachKindSources())} actionHref="/catalog/scopes" />);

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
    const readModel = assemble({
      ...sources,
      mergeCandidates: {
        ...sources.mergeCandidates,
        rows: sources.mergeCandidates.rows.map((row) => ({ ...row, scope_record_id: null })),
      },
    });
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
    const readModel = assemble({
      ...sources,
      proposedScopeMappings:
        kind === "unmapped-scope"
          ? {
              ...sources.proposedScopeMappings,
              rows: sources.proposedScopeMappings.rows.map((row) => ({ ...row, scope_record_id: "" })),
            }
          : sources.proposedScopeMappings,
      unitReadiness:
        kind === "provider-health"
          ? sources.unitReadiness.map((row) => ({ ...row, providerKey: "" }))
          : sources.unitReadiness,
      importJobs:
        kind === "import-job"
          ? {
              ...sources.importJobs,
              unitActivity: sources.importJobs.unitActivity.map((unit) => ({
                ...unit,
                recentJobs: unit.recentJobs.map((job) => ({ ...job, providerKey: "" })),
              })),
            }
          : sources.importJobs,
      staleScopeRecords:
        kind === "stale-scope-sync"
          ? {
              ...sources.staleScopeRecords,
              rows: sources.staleScopeRecords.rows.map((row) => ({ ...row, scope_record_id: "" })),
            }
          : sources.staleScopeRecords,
    });
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
      const readModel = assemble({
        ...sources,
        pendingAliasCandidates: {
          ...sources.pendingAliasCandidates,
          rows: sources.pendingAliasCandidates.rows.map((row) => ({
            ...row,
            target_kind: targetKind,
            target_id: null,
          })),
        },
      });
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
