import { describe, expect, it } from "vitest";
import type { CatalogScopeRecordDetail } from "../../../../scope-registry/ui/contracts";
import type {
  CatalogScopeLanguageEditionReviewReadModel,
  CatalogScopeLanguageEditionSummary,
} from "./language-editions/language-edition-review";
import {
  buildCatalogScopeJourneyOverviewReadModel,
  type CatalogScopeJourneyStageKey,
  type CatalogScopeJourneyStageStatus,
} from "./scope-journey-overview";

const NOW = "2026-07-14T12:00:00.000Z";

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
    // 11 days before NOW → fresh (inside the two-week stale threshold).
    updatedAt: "2026-07-03T12:00:00.000Z",
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
      generatedAt: NOW,
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
      generatedAt: NOW,
    });

    expect(model.condition).toBe("conflict");
    expect(model.pendingCandidateCount).toBe(2);
    expect(stageStatus(model.stages, "candidates")).toBe("current");
  });

  it("reports projection-lag and a current sync stage when the projection is stale", () => {
    const model = buildCatalogScopeJourneyOverviewReadModel({
      scope: scope({ updatedAt: "2026-01-01T00:00:00.000Z" }),
      languageEditionReview: linkedReview,
      languageEditionReviewFailed: false,
      generatedAt: NOW,
    });

    expect(model.condition).toBe("projection-lag");
    expect(model.syncFreshness).toBe("stale");
    expect(stageStatus(model.stages, "sync")).toBe("current");
    expect(stageStatus(model.stages, "jobs")).toBe("upcoming");
  });

  it("blocks promotion for a deprecated or archived scope", () => {
    for (const lifecycleStatus of ["deprecated", "archived"]) {
      const model = buildCatalogScopeJourneyOverviewReadModel({
        scope: scope({ lifecycleStatus }),
        languageEditionReview: linkedReview,
        languageEditionReviewFailed: false,
        generatedAt: NOW,
      });

      expect(model.condition).toBe("blocked");
      expect(stageStatus(model.stages, "promotion")).toBe("blocked");
    }
  });

  it("marks promotion upcoming for an unpublished draft scope", () => {
    const model = buildCatalogScopeJourneyOverviewReadModel({
      scope: scope({ lifecycleStatus: "draft" }),
      languageEditionReview: linkedReview,
      languageEditionReviewFailed: false,
      generatedAt: NOW,
    });

    expect(model.promotionReadiness).toBe("unpublished");
    expect(stageStatus(model.stages, "promotion")).toBe("upcoming");
  });

  it("surfaces partial-failure ahead of a stale sync when the alias review degraded", () => {
    const model = buildCatalogScopeJourneyOverviewReadModel({
      scope: scope({ updatedAt: "2026-01-01T00:00:00.000Z" }),
      languageEditionReview: linkedReview,
      languageEditionReviewFailed: true,
      generatedAt: NOW,
    });

    expect(model.condition).toBe("partial-failure");
  });

  it("treats a single-edition scope as its own linked canonical edition", () => {
    const model = buildCatalogScopeJourneyOverviewReadModel({
      scope: scope({ languageEditions: ["en"] }),
      languageEditionReview: null,
      languageEditionReviewFailed: false,
      generatedAt: NOW,
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
      generatedAt: NOW,
    });

    expect(model.condition).toBe("empty");
    expect(stageStatus(model.stages, "coverage")).toBe("current");
  });
});
