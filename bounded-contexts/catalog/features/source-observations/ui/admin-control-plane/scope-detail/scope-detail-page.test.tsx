// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "@chase-sets/localization";
import { CatalogScopeDetailPage } from "./scope-detail-page";
import { buildCatalogPrimaryWorkbenchReadModelForSurface } from "../../primary-workbench-read-model";
import {
  catalogMergeCandidateListItem,
  controlPlaneOverview,
  integrationJobSummary,
  profileReview,
  sourceObservationListItem,
  sourceObservationScope,
} from "../../primary-workbench-test-fixtures";
import type {
  CatalogAliasReviewCandidateSummary,
  CatalogAliasReviewReadModel,
} from "../../../../alias-equivalence/api/alias-review-admin-contracts";
import type { CatalogScopeRecordDetail } from "../../../../scope-registry/ui/contracts";

vi.mock("../import-to-promotion/import-to-promotion-workspace", () => ({
  CatalogIntegrationImportToPromotionWorkspace: (props: {
    commandActionPath?: string;
    showSourceScopeWorkset?: boolean;
  }) => (
    <div
      data-testid="scope-journey-workspace"
      data-action-path={props.commandActionPath}
      data-show-source-workset={String(props.showSourceScopeWorkset)}
    >
      Sync, live jobs, candidate review, and promotion
    </div>
  ),
}));

afterEach(cleanup);

it.each([true, false])(
  "preserves Scope-member health and job guidance with manage permission %s",
  (canManageCatalog) => {
    const scope = paldeanFatesScope();
    const requestUrl = `https://admin.example/catalog/scopes/${scope.scopeRecordId}?scopeRecordId=${scope.scopeRecordId}&providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1`;
    const overview = controlPlaneOverview();
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("daily", {
      requestUrl,
      scopes: {
        items: [sourceObservationScope(), sourceObservationScope({ expansion_id: "base2" })],
        total: 2,
        count: 2,
      },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: {
        ...overview,
        unitActivity: {
          ...overview.unitActivity,
          units: [
            {
              unitKey: overview.readiness.units[0]!.unitKey,
              recentJobs: [
                integrationJobSummary({ jobId: "scope-member-job", summary: "Member progress facts" }),
                integrationJobSummary({
                  jobId: "same-provider-other-scope",
                  importScope: "en:3:base:base2",
                  summary: "Foreign progress facts",
                }),
              ],
            },
          ],
        },
      },
      canManageCatalog,
    });
    render(
      <CatalogScopeDetailPage
        scope={scope}
        actionHref={ACTION_HREF}
        languageEditionAliasReview={aliasReview([])}
        journey={{ requestUrl, readModel }}
      />,
    );
    const health = document.querySelector<HTMLElement>("[data-catalog-scope-health]")!;
    expect(health.textContent).toContain("TCGdex Pokemon cards");
    expect(health.textContent).toContain(
      t("catalog.features.sourceObservations.ui.primaryWorkbench.health.primaryAction.reviewSourceObservations"),
    );
    expect(health.textContent).toContain(readModel.healthTriage.units[0]!.nextAction);
    expect(health.textContent).toContain("Member progress facts");
    expect(health.textContent).toContain("catalog.integration.job.active");
    expect(health.textContent).not.toContain("Foreign progress facts");
    expect(health.textContent).not.toContain("same-provider-other-scope");
    expect(health.textContent).toContain("import-job-progress-summary");
    expect(health.textContent).toContain(readModel.healthTriage.recentJobs[0]!.progressLabel);
    expect(health.textContent).toContain(readModel.healthTriage.recentJobs[0]!.nextAction);
    expect(within(health).getByRole("link", { name: "Provider setup: tcgdex" }).getAttribute("href")).toContain(
      "/catalog/providers/tcgdex",
    );
    const cancel = within(health).getByRole<HTMLButtonElement>("button", { name: /Cancel/ });
    expect(cancel.disabled).toBe(!canManageCatalog);
    expect(cancel.closest("form")?.getAttribute("action")).toBe(ACTION_HREF);
  },
);

const ACTION_HREF = "/admin/catalog/scopes/scope_expansion_paldean_fates";

it.each([false, true])("keeps missing Scope unit/job selections unavailable while loading is %s", (loading) => {
  const journey = journeyFixture();
  const model = {
    ...journey.readModel,
    sourceScopeWorkset: { ...journey.readModel.sourceScopeWorkset, units: [] },
    healthTriage: { ...journey.readModel.healthTriage, status: "unavailable" as const, units: [], recentJobs: [] },
    routeContext: {
      ...journey.readModel.routeContext,
      jobId: "missing-job",
      unitKey: controlPlaneOverview().readiness.units[0]!.unitKey,
    },
  };
  render(
    <CatalogScopeDetailPage
      scope={paldeanFatesScope()}
      actionHref={ACTION_HREF}
      loading={loading}
      languageEditionAliasReview={aliasReview([])}
      journey={{ ...journey, readModel: model }}
    />,
  );
  const health = document.querySelector<HTMLElement>("[data-catalog-scope-health]")!;
  expect(health.textContent?.toLowerCase()).toContain("unavailable");
  expect(within(health).queryAllByRole("button")).toHaveLength(0);
  expect(within(health).queryAllByRole("link")).toHaveLength(0);
});

function journeyFixture(open = false) {
  const requestUrl = `https://admin.example/catalog/scopes/scope_expansion_paldean_fates?scopeRecordId=scope_expansion_paldean_fates${open ? "&evidenceRef=source-observation/obs_001" : ""}`;
  const candidate = catalogMergeCandidateListItem();
  return {
    requestUrl,
    readModel: buildCatalogPrimaryWorkbenchReadModelForSurface("daily", {
      requestUrl,
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview()], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview(),
      reviewObservations: { items: [sourceObservationListItem()], total: 1, count: 1 },
      mergeCandidates: {
        items: [
          {
            ...candidate,
            identity_json: { ...candidate.identity_json, scopeRecordId: "scope_expansion_paldean_fates" },
          },
        ],
        total: 1,
        count: 1,
      },
      canManageCatalog: true,
    }),
  };
}

function paldeanFatesScope(overrides: Partial<CatalogScopeRecordDetail> = {}): CatalogScopeRecordDetail {
  return {
    scopeRecordId: "scope_expansion_paldean_fates",
    productDomain: "pokemon",
    scopeKind: "expansion",
    referenceTypeKey: "expansion",
    referenceRecordId: "ref_expansion_paldean_fates",
    referenceRecordKey: "paldean-fates",
    name: "Paldean Fates",
    parentScopeRecordId: "ref_series_scarlet_violet",
    productLineScopeRecordId: "ref_product_line_pokemon",
    seriesScopeRecordId: "ref_series_scarlet_violet",
    releaseDate: "2024-01-26",
    officialSetCode: "PAF",
    languageEditions: ["en", "ja"],
    lifecycleStatus: "active",
    updatedAt: "2026-07-03T12:00:00.000Z",
    promotionReadiness: "live",
    syncFreshness: "fresh",
    ...overrides,
  };
}

function candidate(overrides: Partial<CatalogAliasReviewCandidateSummary> = {}): CatalogAliasReviewCandidateSummary {
  return {
    aliasHash: "hash_ja_set_equivalent",
    targetKind: "reference-record",
    targetId: "ref_expansion_paldean_fates",
    targetKey: "expansion",
    nativePrintedName: "シャイニートレジャーex",
    nativeLanguageCode: "ja",
    proposedAlias: "シャイニートレジャーex",
    aliasLanguageCode: "ja",
    aliasType: "set-equivalent",
    confidence: "high",
    reviewStatus: "pending",
    sourceCategory: "provider-same-id-localized-endpoint",
    providerKey: "tcgdex",
    observationId: "obs_paldean_fates_ja",
    sourceProfileKey: "pokemon-tcg",
    sourceProfileVersion: "2026.06.03",
    evidence: [],
    warnings: [],
    autoAccept: {
      eligible: false,
      governedReviewState: "pending",
      official: false,
      policyVersion: "alias-source-governance-v1",
      reasons: ["Provider same-id localized endpoint requires operator review before becoming official."],
    },
    reviewable: true,
    availableActions: ["alias.accept", "alias.reject", "alias.defer"],
    firstObservedAt: "2026-06-16T00:00:00.000Z",
    updatedAt: "2026-06-16T00:00:00.000Z",
    ...overrides,
  };
}

function aliasReview(candidates: readonly CatalogAliasReviewCandidateSummary[]): CatalogAliasReviewReadModel {
  return {
    schemaVersion: "catalog-alias-review-v1",
    generatedAt: "2026-06-16T00:00:00.000Z",
    filter: {
      providerKey: null,
      sourceProfileVersion: null,
      aliasType: null,
      reviewStatuses: [],
      observationId: null,
      targetKind: "reference-record",
      targetId: "ref_expansion_paldean_fates",
    },
    counts: {
      total: candidates.length,
      pending: candidates.length,
      accepted: 0,
      autoAccepted: 0,
      rejected: 0,
      revoked: 0,
      needsReview: candidates.length,
      autoAcceptEligible: 0,
      warned: 0,
    },
    candidates,
    groups: [],
    coverage: {
      cardsWithAcceptedEnglishAlias: 0,
      cardsWithOnlySpeciesAliases: 0,
      cardsNeedingReview: 0,
      expansionsAndSeriesNeedingReview: 0,
      cards: [],
      referenceScopes: [],
    },
  };
}

describe("CatalogScopeDetailPage", () => {
  it("launches Scope and typed entity evidence on the current page and mounts a validated deep link", () => {
    const view = render(
      <CatalogScopeDetailPage
        scope={paldeanFatesScope()}
        languageEditionAliasReview={aliasReview([])}
        actionHref={ACTION_HREF}
        journey={journeyFixture()}
      />,
    );
    expect(
      screen.getByRole("link", { name: "Audit timeline: scope_expansion_paldean_fates" }).getAttribute("href"),
    ).toContain("/catalog/scopes/scope_expansion_paldean_fates?");
    expect(screen.getByRole("link", { name: "Audit timeline: obs_001" }).getAttribute("href")).toContain(
      "evidenceRef=source-observation%2Fobs_001",
    );
    expect(screen.getByRole("heading", { name: "Paldean Fates" })).toBeTruthy();
    view.rerender(
      <CatalogScopeDetailPage
        scope={paldeanFatesScope()}
        languageEditionAliasReview={aliasReview([])}
        actionHref={ACTION_HREF}
        journey={journeyFixture(true)}
      />,
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
  it("shows the scope header and the language-editions section for a scope imported in en+ja", () => {
    render(
      <CatalogScopeDetailPage
        scope={paldeanFatesScope()}
        languageEditionAliasReview={aliasReview([candidate()])}
        actionHref={ACTION_HREF}
      />,
    );

    expect(screen.getByRole("heading", { name: "Paldean Fates" })).toBeTruthy();
    expect(screen.getByText("シャイニートレジャーex")).toBeTruthy();
  });

  it("renders the journey overview and flags a pending candidate as needing review", () => {
    render(
      <CatalogScopeDetailPage
        scope={paldeanFatesScope()}
        languageEditionAliasReview={aliasReview([candidate()])}
        actionHref={ACTION_HREF}
      />,
    );

    expect(screen.getByRole("heading", { name: "Scope journey" })).toBeTruthy();
    // One pending set-equivalent candidate → the journey is in the conflict state.
    expect(screen.getByText("Needs review")).toBeTruthy();
    expect(screen.getByText("Candidates need review")).toBeTruthy();
  });

  it("reports a partial-failure state when the alias review degraded", () => {
    render(
      <CatalogScopeDetailPage
        scope={paldeanFatesScope()}
        languageEditionAliasReview={aliasReview([])}
        languageEditionAliasReviewFailed
        actionHref={ACTION_HREF}
      />,
    );

    expect(screen.getByText("Partial data")).toBeTruthy();
  });

  it("shows the loading state while the route revalidates", () => {
    render(
      <CatalogScopeDetailPage
        scope={paldeanFatesScope()}
        languageEditionAliasReview={aliasReview([])}
        actionHref={ACTION_HREF}
        loading
      />,
    );

    expect(screen.getByText("Loading the scope journey…")).toBeTruthy();
  });

  it("composes coverage and the interactive journey on Scope Detail without the unit-first workset", () => {
    render(
      <CatalogScopeDetailPage
        scope={paldeanFatesScope()}
        languageEditionAliasReview={aliasReview([])}
        actionHref={ACTION_HREF}
        coverageMatrix={
          {
            scopeRecordId: "scope_expansion_paldean_fates",
            scopeName: "Paldean Fates",
            providers: [
              {
                providerKey: "tcgdex",
                state: "mapped",
                mapping: null,
                syncedObservations: 0,
                promotedObservations: 0,
              },
            ],
          } as never
        }
        journey={journeyFixture()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Coverage matrix" })).toBeTruthy();
    expect(screen.getAllByText("tcgdex").length).toBeGreaterThan(0);
    const workspace = screen.getByTestId("scope-journey-workspace");
    expect(workspace.getAttribute("data-action-path")).toBe(ACTION_HREF);
    expect(workspace.getAttribute("data-show-source-workset")).toBe("false");
  });

  it("omits the language-editions section for a single-edition scope", () => {
    render(
      <CatalogScopeDetailPage
        scope={paldeanFatesScope({ languageEditions: ["en"] })}
        languageEditionAliasReview={aliasReview([])}
        actionHref={ACTION_HREF}
      />,
    );

    // The section title (exact case) only renders when the panel mounts; the
    // page description also mentions "language editions" in prose, so an exact
    // match avoids a false positive against that unrelated text.
    expect(screen.queryByText("Language editions")).toBeNull();
  });
});
