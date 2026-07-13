// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CatalogIntegrationLanguageEditionsPanel } from "./language-editions-panel";
import { buildCatalogScopeLanguageEditionReviewReadModel } from "./language-edition-review";
import type {
  CatalogAliasReviewCandidateSummary,
  CatalogAliasReviewReadModel,
} from "../../../../../alias-equivalence/api/alias-review-admin-contracts";

afterEach(cleanup);

const ACTION_HREF = "/admin/catalog/scopes/scope_expansion_paldean_fates";
const REFERENCE_RECORD_ID = "ref_expansion_paldean_fates";

function candidate(overrides: Partial<CatalogAliasReviewCandidateSummary> = {}): CatalogAliasReviewCandidateSummary {
  return {
    aliasHash: "hash_ja_set_equivalent",
    targetKind: "reference-record",
    targetId: REFERENCE_RECORD_ID,
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
      targetId: REFERENCE_RECORD_ID,
    },
    counts: {
      total: candidates.length,
      pending: candidates.filter((c) => c.reviewStatus === "pending").length,
      accepted: 0,
      autoAccepted: 0,
      rejected: 0,
      revoked: 0,
      needsReview: candidates.filter((c) => c.reviewStatus === "pending").length,
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

const scope = {
  scopeRecordId: "scope_expansion_paldean_fates",
  referenceRecordId: REFERENCE_RECORD_ID,
  languageEditions: ["en", "ja"],
};

describe("CatalogIntegrationLanguageEditionsPanel", () => {
  it("shows both editions for a scope imported in en+ja, with the pending ja candidate visible", () => {
    const readModel = buildCatalogScopeLanguageEditionReviewReadModel({
      scope,
      aliasReview: aliasReview([candidate()]),
    });

    render(<CatalogIntegrationLanguageEditionsPanel readModel={readModel} actionHref={ACTION_HREF} />);

    expect(screen.getByText(/EN/)).toBeTruthy();
    expect(screen.getByText(/JA/)).toBeTruthy();
    expect(screen.getByText("シャイニートレジャーex")).toBeTruthy();
    // Auto-accept posture surfaced.
    expect(
      screen.getByText("Provider same-id localized endpoint requires operator review before becoming official."),
    ).toBeTruthy();
  });

  it("posts the accept intent with the candidate's alias hash to the supplied action href", () => {
    const readModel = buildCatalogScopeLanguageEditionReviewReadModel({
      scope,
      aliasReview: aliasReview([candidate()]),
    });

    render(<CatalogIntegrationLanguageEditionsPanel readModel={readModel} actionHref={ACTION_HREF} />);

    const acceptForm = document.querySelector('form[data-language-edition-command="alias.accept"]');
    expect(acceptForm).not.toBeNull();
    expect(acceptForm?.getAttribute("action")).toBe(ACTION_HREF);
    const hiddenIntent = acceptForm?.querySelector('input[name="_intent"]');
    expect(hiddenIntent?.getAttribute("value")).toBe("alias.accept");
    const hiddenHashes = acceptForm?.querySelector('input[name="aliasHashes"]');
    expect(hiddenHashes?.getAttribute("value")).toBe("hash_ja_set_equivalent");
  });

  it("requires a reason for reject and revoke actions", () => {
    const readModel = buildCatalogScopeLanguageEditionReviewReadModel({
      scope,
      aliasReview: aliasReview([candidate()]),
    });

    render(<CatalogIntegrationLanguageEditionsPanel readModel={readModel} actionHref={ACTION_HREF} />);

    const rejectForm = document.querySelector('form[data-language-edition-command="alias.reject"]');
    const reasonInput = rejectForm?.querySelector('input[name="reason"]');
    expect(reasonInput?.hasAttribute("required")).toBe(true);
  });

  it("offers revoke for an already-linked (accepted) edition candidate", () => {
    const readModel = buildCatalogScopeLanguageEditionReviewReadModel({
      scope,
      aliasReview: aliasReview([candidate({ reviewStatus: "accepted", availableActions: ["alias.revoke"] })]),
    });

    render(<CatalogIntegrationLanguageEditionsPanel readModel={readModel} actionHref={ACTION_HREF} />);

    expect(document.querySelector('form[data-language-edition-command="alias.revoke"]')).not.toBeNull();
  });

  it("disables actions when the operator cannot manage aliases", () => {
    const readModel = buildCatalogScopeLanguageEditionReviewReadModel({
      scope,
      aliasReview: aliasReview([candidate()]),
    });

    render(
      <CatalogIntegrationLanguageEditionsPanel
        readModel={readModel}
        actionHref={ACTION_HREF}
        canManageAliases={false}
      />,
    );

    const acceptButton = within(
      document.querySelector('form[data-language-edition-command="alias.accept"]') as HTMLElement,
    ).getByRole("button") as HTMLButtonElement;
    expect(acceptButton.disabled).toBe(true);
  });

  it("renders no alias forms for the canonical english edition", () => {
    const readModel = buildCatalogScopeLanguageEditionReviewReadModel({
      scope,
      aliasReview: aliasReview([]),
    });

    render(<CatalogIntegrationLanguageEditionsPanel readModel={readModel} actionHref={ACTION_HREF} />);

    expect(document.querySelectorAll("form").length).toBe(0);
  });
});
