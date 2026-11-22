import { describe, expect, it, vi } from "vitest";
import type {
  CatalogAliasReviewCandidateSummary,
  CatalogAliasReviewReadModel,
} from "../../alias-equivalence/api/alias-review-admin-contracts";
import type {
  CatalogScopeJourneyStageKey,
  CatalogScopeJourneyStageStatus,
  CatalogScopeLanguageEditionReviewReadModel,
  CatalogScopeLanguageEditionSummary,
  CatalogScopeRecordDetail,
} from "../ui/contracts";
import {
  buildCatalogScopeJourneyOverviewReadModel,
  buildCatalogScopeLanguageEditionReviewReadModel,
  catalogScopeHasLanguageEditionsToReview,
  readCatalogScopeJourney,
} from "./scope-journey";

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
  it("excludes unresolved reference aliases from every edition's commands", () => {
    const readModel = buildCatalogScopeLanguageEditionReviewReadModel({
      scope: paldeanFatesScope,
      candidates: [candidate({ targetId: null, reviewable: false, availableActions: [] })],
    });
    expect(
      readModel.editions.flatMap((edition) => [...edition.pendingCandidates, ...edition.acceptedCandidates]),
    ).toEqual([]);
  });

  it("shows both editions for a scope imported in en+ja, canonical en linked with no aliases needed", () => {
    const readModel = buildCatalogScopeLanguageEditionReviewReadModel({
      scope: paldeanFatesScope,
      candidates: [candidate()],
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
      candidates: [candidate()],
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
      candidates: [candidate({ reviewStatus: "accepted" })],
    });

    const japaneseEdition = readModel.editions[1];
    expect(japaneseEdition.linkState).toBe("linked");
    expect(japaneseEdition.acceptedAliasCount).toBe(1);
    expect(japaneseEdition.pendingCandidates).toEqual([]);
  });

  it("keeps a rejected pair out of pending review (fingerprint idempotency: rejected pairs do not resurrect)", () => {
    const readModel = buildCatalogScopeLanguageEditionReviewReadModel({
      scope: paldeanFatesScope,
      candidates: [candidate({ reviewStatus: "rejected", availableActions: ["alias.accept"] })],
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
      candidates: [otherScopeCandidate],
    });

    expect(readModel.editions.flatMap((edition) => edition.pendingCandidates)).toEqual([]);
  });

  it("orders editions with the canonical language first, then alphabetically", () => {
    const readModel = buildCatalogScopeLanguageEditionReviewReadModel({
      scope: { ...paldeanFatesScope, languageEditions: ["fr", "en", "de"] },
      candidates: [],
    });

    expect(readModel.editions.map((edition) => edition.languageCode)).toEqual(["en", "de", "fr"]);
  });
});

function scope(overrides: Partial<CatalogScopeRecordDetail> = {}): CatalogScopeRecordDetail {
  return {
    scopeRecordId: "scope_expansion_paldean_fates",
    productDomain: "pokemon",
    scopeKind: "expansion",
    referenceTypeKey: "expansion",
    referenceRecordId: "ref_expansion_paldean_fates",
    referenceRecordKey: "paldean-fates",
    name: "Paldean Fates",
    parentScopeRecordId: null,
    productLineScopeRecordId: null,
    seriesScopeRecordId: null,
    releaseDate: "2024-01-26",
    officialSetCode: "PAF",
    languageEditions: ["en", "ja"],
    lifecycleStatus: "active",
    updatedAt: "2026-07-03T12:00:00.000Z",
    // The Catalog API derives both row facts; the overview reads them as given.
    promotionReadiness: "live",
    syncFreshness: "fresh",
    ...overrides,
  };
}

function edition(overrides: Partial<CatalogScopeLanguageEditionSummary>): CatalogScopeLanguageEditionSummary {
  return {
    languageCode: "ja",
    isCanonical: false,
    linkState: "linked",
    acceptedAliasCount: 1,
    pendingCandidates: [],
    acceptedCandidates: [],
    ...overrides,
  };
}

function review(editions: readonly CatalogScopeLanguageEditionSummary[]): CatalogScopeLanguageEditionReviewReadModel {
  return {
    scopeRecordId: "scope_expansion_paldean_fates",
    referenceRecordId: "ref_expansion_paldean_fates",
    editions,
  };
}

const linkedReview = review([
  edition({ languageCode: "en", isCanonical: true }),
  edition({ languageCode: "ja", linkState: "linked" }),
]);

function stageStatus(
  stages: readonly { key: CatalogScopeJourneyStageKey; status: CatalogScopeJourneyStageStatus }[],
  key: CatalogScopeJourneyStageKey,
): CatalogScopeJourneyStageStatus | undefined {
  return stages.find((stage) => stage.key === key)?.status;
}

describe("buildCatalogScopeJourneyOverviewReadModel", () => {
  it("is ready when coverage is fresh, all editions linked, and the scope is live", () => {
    const model = buildCatalogScopeJourneyOverviewReadModel({
      scope: scope(),
      languageEditionReview: linkedReview,
      languageEditionReviewFailed: false,
    });

    expect(model.condition).toBe("ready");
    expect(model.editionCount).toBe(2);
    expect(model.linkedEditionCount).toBe(2);
    expect(model.pendingCandidateCount).toBe(0);
    expect(stageStatus(model.stages, "coverage")).toBe("complete");
    expect(stageStatus(model.stages, "sync")).toBe("complete");
    expect(stageStatus(model.stages, "jobs")).toBe("complete");
    expect(stageStatus(model.stages, "candidates")).toBe("complete");
    expect(stageStatus(model.stages, "promotion")).toBe("complete");
  });

  it("is a conflict with pending candidates and marks the candidates stage current", () => {
    const model = buildCatalogScopeJourneyOverviewReadModel({
      scope: scope(),
      languageEditionReview: review([
        edition({ languageCode: "en", isCanonical: true }),
        edition({
          languageCode: "ja",
          linkState: "pending-review",
          acceptedAliasCount: 0,
          // The shape of the candidate does not matter here — only the count.
          pendingCandidates: [{} as never, {} as never],
        }),
      ]),
      languageEditionReviewFailed: false,
    });

    expect(model.condition).toBe("conflict");
    expect(model.pendingCandidateCount).toBe(2);
    expect(stageStatus(model.stages, "candidates")).toBe("current");
  });

  it("reports projection-lag and a current sync stage when the projection is stale", () => {
    const model = buildCatalogScopeJourneyOverviewReadModel({
      scope: scope({ updatedAt: "2026-01-01T00:00:00.000Z", syncFreshness: "stale" }),
      languageEditionReview: linkedReview,
      languageEditionReviewFailed: false,
    });

    expect(model.condition).toBe("projection-lag");
    expect(model.syncFreshness).toBe("stale");
    expect(stageStatus(model.stages, "sync")).toBe("current");
    expect(stageStatus(model.stages, "jobs")).toBe("upcoming");
  });

  it("blocks promotion for a deprecated or archived scope", () => {
    for (const lifecycleStatus of ["deprecated", "archived"] as const) {
      const model = buildCatalogScopeJourneyOverviewReadModel({
        scope: scope({ lifecycleStatus, promotionReadiness: lifecycleStatus }),
        languageEditionReview: linkedReview,
        languageEditionReviewFailed: false,
      });

      expect(model.condition).toBe("blocked");
      expect(stageStatus(model.stages, "promotion")).toBe("blocked");
    }
  });

  it("marks promotion upcoming for an unpublished draft scope", () => {
    const model = buildCatalogScopeJourneyOverviewReadModel({
      scope: scope({ lifecycleStatus: "draft", promotionReadiness: "unpublished" }),
      languageEditionReview: linkedReview,
      languageEditionReviewFailed: false,
    });

    expect(model.promotionReadiness).toBe("unpublished");
    expect(stageStatus(model.stages, "promotion")).toBe("upcoming");
  });

  it("surfaces partial-failure ahead of a stale sync when the alias review degraded", () => {
    const model = buildCatalogScopeJourneyOverviewReadModel({
      scope: scope({ updatedAt: "2026-01-01T00:00:00.000Z", syncFreshness: "stale" }),
      languageEditionReview: linkedReview,
      languageEditionReviewFailed: true,
    });

    expect(model.condition).toBe("partial-failure");
  });

  it("treats a single-edition scope as its own linked canonical edition", () => {
    const model = buildCatalogScopeJourneyOverviewReadModel({
      scope: scope({ languageEditions: ["en"] }),
      languageEditionReview: null,
      languageEditionReviewFailed: false,
    });

    expect(model.condition).toBe("ready");
    expect(model.editionCount).toBe(1);
    expect(model.linkedEditionCount).toBe(1);
    expect(model.pendingCandidateCount).toBe(0);
  });

  it("reports empty when a scope has no language editions recorded", () => {
    const model = buildCatalogScopeJourneyOverviewReadModel({
      scope: scope({ languageEditions: [] }),
      languageEditionReview: null,
      languageEditionReviewFailed: false,
    });

    expect(model.condition).toBe("empty");
    expect(stageStatus(model.stages, "coverage")).toBe("current");
  });
});

describe("readCatalogScopeJourney", () => {
  const generatedAt = "2026-07-14T12:00:00.000Z";

  function aliasReview(candidates: readonly CatalogAliasReviewCandidateSummary[]): CatalogAliasReviewReadModel {
    return { candidates } as unknown as CatalogAliasReviewReadModel;
  }

  it("reads the alias review of the scope's Reference Record and composes the editions and journey", async () => {
    const getAliasReview = vi.fn().mockResolvedValue(aliasReview([candidate()]));
    const result = await readCatalogScopeJourney({ scope: scope(), generatedAt, getAliasReview });

    expect(getAliasReview).toHaveBeenCalledExactlyOnceWith({
      generatedAt,
      filter: { targetKind: "reference-record", targetId: "ref_expansion_paldean_fates" },
    });
    expect(result.generatedAt).toBe(generatedAt);
    expect(result.scope.scopeRecordId).toBe("scope_expansion_paldean_fates");
    expect(result.languageEditionReviewFailed).toBe(false);
    expect(result.languageEditions?.editions.map((edition) => [edition.languageCode, edition.linkState])).toEqual([
      ["en", "linked"],
      ["ja", "pending-review"],
    ]);
    expect(result.overview.condition).toBe("conflict");
    expect(result.overview.pendingCandidateCount).toBe(1);
  });

  it("reports a failed alias review as a partial failure with editions but no candidates", async () => {
    const getAliasReview = vi.fn().mockRejectedValue(new Error("alias review down"));
    const result = await readCatalogScopeJourney({ scope: scope(), generatedAt, getAliasReview });

    expect(result.languageEditionReviewFailed).toBe(true);
    expect(result.languageEditions?.editions.map((edition) => [edition.languageCode, edition.linkState])).toEqual([
      ["en", "linked"],
      ["ja", "not-yet-observed"],
    ]);
    expect(result.overview.condition).toBe("partial-failure");
  });

  it("reports a missing alias review reader as a partial failure", async () => {
    const result = await readCatalogScopeJourney({ scope: scope(), generatedAt, getAliasReview: undefined });

    expect(result.languageEditionReviewFailed).toBe(true);
    expect(result.overview.condition).toBe("partial-failure");
  });

  it("skips the alias review for a single-edition scope", async () => {
    const getAliasReview = vi.fn();
    const result = await readCatalogScopeJourney({
      scope: scope({ languageEditions: ["en"] }),
      generatedAt,
      getAliasReview,
    });

    expect(getAliasReview).not.toHaveBeenCalled();
    expect(result.languageEditions).toBeNull();
    expect(result.languageEditionReviewFailed).toBe(false);
    expect(result.overview.condition).toBe("ready");
    expect(result.overview.linkedEditionCount).toBe(1);
  });
});
