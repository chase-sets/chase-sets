import { describe, expect, it } from "vitest";
import {
  buildCatalogScopeLanguageEditionReviewReadModel,
  catalogScopeHasLanguageEditionsToReview,
} from "./language-edition-review";
import type {
  CatalogAliasReviewCandidateSummary,
  CatalogAliasReviewReadModel,
} from "../../../../../alias-equivalence/api/alias-review-admin-contracts";

const PALDEAN_FATES_REFERENCE_RECORD_ID = "ref_expansion_paldean_fates";
const PALDEAN_FATES_SCOPE_RECORD_ID = "scope_expansion_paldean_fates";

function candidate(overrides: Partial<CatalogAliasReviewCandidateSummary> = {}): CatalogAliasReviewCandidateSummary {
  return {
    aliasHash: "hash_ja_set_equivalent",
    targetKind: "reference-record",
    targetId: PALDEAN_FATES_REFERENCE_RECORD_ID,
    targetKey: "expansion",
    nativePrintedName: "スカーレット&バイオレット シャイニートレジャーex",
    nativeLanguageCode: "ja",
    proposedAlias: "スカーレット&バイオレット シャイニートレジャーex",
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
      targetId: PALDEAN_FATES_REFERENCE_RECORD_ID,
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

const paldeanFatesScope = {
  scopeRecordId: PALDEAN_FATES_SCOPE_RECORD_ID,
  referenceRecordId: PALDEAN_FATES_REFERENCE_RECORD_ID,
  languageEditions: ["en", "ja"],
};

describe("catalogScopeHasLanguageEditionsToReview", () => {
  it("is false for a scope with only one language edition", () => {
    expect(catalogScopeHasLanguageEditionsToReview({ ...paldeanFatesScope, languageEditions: ["en"] })).toBe(false);
  });

  it("is true for a scope with sibling language editions (Pokemon EN+JA)", () => {
    expect(catalogScopeHasLanguageEditionsToReview(paldeanFatesScope)).toBe(true);
  });
});

describe("buildCatalogScopeLanguageEditionReviewReadModel", () => {
  it("shows both editions for a scope imported in en+ja, canonical en linked with no aliases needed", () => {
    const readModel = buildCatalogScopeLanguageEditionReviewReadModel({
      scope: paldeanFatesScope,
      aliasReview: aliasReview([candidate()]),
    });

    expect(readModel.editions.map((edition) => edition.languageCode)).toEqual(["en", "ja"]);

    const englishEdition = readModel.editions[0];
    expect(englishEdition.isCanonical).toBe(true);
    expect(englishEdition.linkState).toBe("linked");
    expect(englishEdition.pendingCandidates).toEqual([]);
  });

  it("surfaces the pending set-equivalent candidate for the ja edition of this scope only", () => {
    const readModel = buildCatalogScopeLanguageEditionReviewReadModel({
      scope: paldeanFatesScope,
      aliasReview: aliasReview([candidate()]),
    });

    const japaneseEdition = readModel.editions[1];
    expect(japaneseEdition.languageCode).toBe("ja");
    expect(japaneseEdition.isCanonical).toBe(false);
    expect(japaneseEdition.linkState).toBe("pending-review");
    expect(japaneseEdition.pendingCandidates).toHaveLength(1);
    // Surfaces why the candidate did not auto-accept (issue #3821 AC 3).
    expect(japaneseEdition.pendingCandidates[0].autoAccept.eligible).toBe(false);
    expect(japaneseEdition.pendingCandidates[0].autoAccept.reasons.length).toBeGreaterThan(0);
  });

  it("links the ja edition once its set-equivalent candidate is accepted, and the accepted candidate never resurfaces as pending", () => {
    const readModel = buildCatalogScopeLanguageEditionReviewReadModel({
      scope: paldeanFatesScope,
      aliasReview: aliasReview([candidate({ reviewStatus: "accepted" })]),
    });

    const japaneseEdition = readModel.editions[1];
    expect(japaneseEdition.linkState).toBe("linked");
    expect(japaneseEdition.acceptedAliasCount).toBe(1);
    expect(japaneseEdition.pendingCandidates).toEqual([]);
  });

  it("keeps a rejected pair out of pending review (fingerprint idempotency: rejected pairs do not resurrect)", () => {
    const readModel = buildCatalogScopeLanguageEditionReviewReadModel({
      scope: paldeanFatesScope,
      aliasReview: aliasReview([candidate({ reviewStatus: "rejected", availableActions: ["alias.accept"] })]),
    });

    const japaneseEdition = readModel.editions[1];
    expect(japaneseEdition.pendingCandidates).toEqual([]);
    expect(japaneseEdition.linkState).toBe("not-yet-observed");
  });

  it("never mixes candidates from a different scope's reference record into this scope's editions", () => {
    const otherScopeCandidate = candidate({
      aliasHash: "hash_other_scope",
      targetId: "ref_expansion_obsidian_flames",
    });

    const readModel = buildCatalogScopeLanguageEditionReviewReadModel({
      scope: paldeanFatesScope,
      aliasReview: aliasReview([otherScopeCandidate]),
    });

    expect(readModel.editions.flatMap((edition) => edition.pendingCandidates)).toEqual([]);
  });

  it("orders editions with the canonical language first, then alphabetically", () => {
    const readModel = buildCatalogScopeLanguageEditionReviewReadModel({
      scope: { ...paldeanFatesScope, languageEditions: ["fr", "en", "de"] },
      aliasReview: aliasReview([]),
    });

    expect(readModel.editions.map((edition) => edition.languageCode)).toEqual(["en", "de", "fr"]);
  });
});
