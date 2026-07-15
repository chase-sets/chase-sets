// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CatalogScopeDetailPage } from "./scope-detail-page";
import type {
  CatalogAliasReviewCandidateSummary,
  CatalogAliasReviewReadModel,
} from "../../../../alias-equivalence/api/alias-review-admin-contracts";
import type { CatalogScopeRecordDetail } from "../../../../scope-registry/ui/contracts";

afterEach(cleanup);

const ACTION_HREF = "/admin/catalog/scopes/scope_expansion_paldean_fates";

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

// Fixed clock 11 days after the scope's updatedAt so sync-freshness is "fresh"
// (inside the two-week stale threshold) regardless of the real wall clock.
const NOW = "2026-07-14T12:00:00.000Z";

describe("CatalogScopeDetailPage", () => {
  it("shows the scope header and the language-editions section for a scope imported in en+ja", () => {
    render(
      <CatalogScopeDetailPage
        scope={paldeanFatesScope()}
        languageEditionAliasReview={aliasReview([candidate()])}
        actionHref={ACTION_HREF}
        now={NOW}
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
        now={NOW}
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
        now={NOW}
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
        now={NOW}
        loading
      />,
    );

    expect(screen.getByText("Loading the scope journey…")).toBeTruthy();
  });

  it("omits the language-editions section for a single-edition scope", () => {
    render(
      <CatalogScopeDetailPage
        scope={paldeanFatesScope({ languageEditions: ["en"] })}
        languageEditionAliasReview={aliasReview([])}
        actionHref={ACTION_HREF}
        now={NOW}
      />,
    );

    // The section title (exact case) only renders when the panel mounts; the
    // page description also mentions "language editions" in prose, so an exact
    // match avoids a false positive against that unrelated text.
    expect(screen.queryByText("Language editions")).toBeNull();
  });
});
