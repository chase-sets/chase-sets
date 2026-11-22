import type {
  CatalogAliasReviewCandidateSummary,
  CatalogAliasReviewReadModel,
} from "../../alias-equivalence/api/alias-review-admin-contracts";
import type {
  CatalogScopeJourneyCondition,
  CatalogScopeJourneyOverviewReadModel,
  CatalogScopeJourneyResponse,
  CatalogScopeJourneyStage,
  CatalogScopeJourneyStageStatus,
  CatalogScopeLanguageEditionLinkState,
  CatalogScopeLanguageEditionReviewReadModel,
  CatalogScopeLanguageEditionSummary,
  CatalogScopePromotionReadiness,
  CatalogScopeRecordDetail,
  CatalogScopeSyncFreshness,
} from "../ui/contracts";

// ---------------------------------------------------------------------------
// Scope journey
//
// One scope's language editions and the journey it travels from "appears in the
// registry" to "promoted draft Catalog Items": coverage, sync, live jobs,
// candidate review, promotion.
//
// The canonical edition (the language the Reference Record's own name and
// identity are recorded in: English, per the alias source-governance policy)
// needs no alias to be linked; it already is the Reference Record. Every other
// edition links via an accepted or auto-accepted alias of this scope's Reference
// Record in that language.
// ---------------------------------------------------------------------------

export const CATALOG_SCOPE_CANONICAL_LANGUAGE_CODE = "en";

type CatalogScopeAliasReviewReader = (input: {
  generatedAt: string;
  filter?: Partial<CatalogAliasReviewReadModel["filter"]>;
}) => Promise<CatalogAliasReviewReadModel>;

/**
 * Reads the alias review of the scope's Reference Record when the scope has
 * sibling editions, and composes the editions and journey. A failed alias read
 * degrades to editions without candidates and a partial-failure journey.
 */
export async function readCatalogScopeJourney(input: {
  scope: CatalogScopeRecordDetail;
  generatedAt: string;
  getAliasReview: CatalogScopeAliasReviewReader | undefined;
}): Promise<CatalogScopeJourneyResponse> {
  const { scope, generatedAt, getAliasReview } = input;
  let candidates: readonly CatalogAliasReviewCandidateSummary[] = [];
  let languageEditionReviewFailed = false;
  const hasEditionsToReview = catalogScopeHasLanguageEditionsToReview(scope);
  if (hasEditionsToReview) {
    try {
      if (!getAliasReview) {
        throw new Error("The alias review is unavailable.");
      }
      const review = await getAliasReview({
        generatedAt,
        filter: { targetKind: "reference-record", targetId: scope.referenceRecordId },
      });
      candidates = review.candidates;
    } catch {
      languageEditionReviewFailed = true;
    }
  }
  const languageEditions = hasEditionsToReview
    ? buildCatalogScopeLanguageEditionReviewReadModel({ scope, candidates })
    : null;
  return {
    generatedAt,
    scope,
    languageEditions,
    languageEditionReviewFailed,
    overview: buildCatalogScopeJourneyOverviewReadModel({
      scope,
      languageEditionReview: languageEditions,
      languageEditionReviewFailed,
    }),
  };
}

/** True when the scope has sibling language editions to review. */
export function catalogScopeHasLanguageEditionsToReview(
  scope: Pick<CatalogScopeRecordDetail, "languageEditions">,
): boolean {
  return scope.languageEditions.length > 1;
}

export function buildCatalogScopeLanguageEditionReviewReadModel(input: {
  scope: Pick<CatalogScopeRecordDetail, "scopeRecordId" | "referenceRecordId" | "languageEditions">;
  /** Alias candidates; only this scope's Reference Record's count. */
  candidates: readonly CatalogAliasReviewCandidateSummary[];
}): CatalogScopeLanguageEditionReviewReadModel {
  const { scope, candidates } = input;
  return {
    scopeRecordId: scope.scopeRecordId,
    referenceRecordId: scope.referenceRecordId,
    editions: orderLanguageEditions(scope.languageEditions).map((languageCode) =>
      buildEditionSummary({ languageCode, referenceRecordId: scope.referenceRecordId, candidates }),
    ),
  };
}

function buildEditionSummary(input: {
  languageCode: string;
  referenceRecordId: string;
  candidates: readonly CatalogAliasReviewCandidateSummary[];
}): CatalogScopeLanguageEditionSummary {
  const { languageCode, referenceRecordId } = input;
  const isCanonical = languageCode === CATALOG_SCOPE_CANONICAL_LANGUAGE_CODE;
  const candidatesForEdition = input.candidates.filter(
    (candidate) =>
      candidate.targetKind === "reference-record" &&
      candidate.targetId === referenceRecordId &&
      candidate.aliasLanguageCode === languageCode,
  );
  const pendingCandidates = candidatesForEdition.filter((candidate) => candidate.reviewStatus === "pending");
  const acceptedCandidates = candidatesForEdition.filter(
    (candidate) => candidate.reviewStatus === "accepted" || candidate.reviewStatus === "auto-accepted",
  );
  return {
    languageCode,
    isCanonical,
    linkState: linkStateFor({
      isCanonical,
      acceptedAliasCount: acceptedCandidates.length,
      pendingCandidateCount: pendingCandidates.length,
    }),
    acceptedAliasCount: acceptedCandidates.length,
    pendingCandidates,
    acceptedCandidates,
  };
}

function linkStateFor(input: {
  isCanonical: boolean;
  acceptedAliasCount: number;
  pendingCandidateCount: number;
}): CatalogScopeLanguageEditionLinkState {
  if (input.isCanonical || input.acceptedAliasCount > 0) {
    return "linked";
  }
  if (input.pendingCandidateCount > 0) {
    return "pending-review";
  }
  return "not-yet-observed";
}

/** Canonical edition first, then the rest alphabetically for a stable operator order. */
function orderLanguageEditions(languageEditions: readonly string[]): readonly string[] {
  return [...new Set(languageEditions)].sort((left, right) => {
    if (left === CATALOG_SCOPE_CANONICAL_LANGUAGE_CODE) return -1;
    if (right === CATALOG_SCOPE_CANONICAL_LANGUAGE_CODE) return 1;
    return left.localeCompare(right);
  });
}

export function buildCatalogScopeJourneyOverviewReadModel(input: {
  scope: CatalogScopeRecordDetail;
  // Null when the scope has a single edition and therefore no sibling editions to review.
  languageEditionReview: CatalogScopeLanguageEditionReviewReadModel | null;
  // True when the alias review read failed and the editions carry no candidates.
  languageEditionReviewFailed: boolean;
}): CatalogScopeJourneyOverviewReadModel {
  const { scope, languageEditionReview, languageEditionReviewFailed } = input;
  const editionCount = scope.languageEditions.length;
  const { linkedEditionCount, pendingCandidateCount } = editionCoverage(languageEditionReview, editionCount);
  const { promotionReadiness, syncFreshness } = scope;
  return {
    scopeRecordId: scope.scopeRecordId,
    condition: journeyCondition({
      editionCount,
      languageEditionReviewFailed,
      promotionReadiness,
      pendingCandidateCount,
      syncFreshness,
    }),
    stages: journeyStages({ editionCount, syncFreshness, pendingCandidateCount, promotionReadiness }),
    editionCount,
    linkedEditionCount,
    pendingCandidateCount,
    promotionReadiness,
    syncFreshness,
  };
}

function editionCoverage(
  languageEditionReview: CatalogScopeLanguageEditionReviewReadModel | null,
  editionCount: number,
): Readonly<{ linkedEditionCount: number; pendingCandidateCount: number }> {
  if (!languageEditionReview) {
    // A single-edition scope is its own canonical identity: the edition is
    // linked with nothing to review.
    return { linkedEditionCount: editionCount, pendingCandidateCount: 0 };
  }
  return {
    linkedEditionCount: languageEditionReview.editions.filter((edition) => edition.linkState === "linked").length,
    pendingCandidateCount: languageEditionReview.editions.reduce(
      (sum, edition) => sum + edition.pendingCandidates.length,
      0,
    ),
  };
}

function journeyCondition(input: {
  editionCount: number;
  languageEditionReviewFailed: boolean;
  promotionReadiness: CatalogScopePromotionReadiness;
  pendingCandidateCount: number;
  syncFreshness: CatalogScopeSyncFreshness;
}): CatalogScopeJourneyCondition {
  if (input.editionCount === 0) {
    return "empty";
  }
  if (input.languageEditionReviewFailed) {
    return "partial-failure";
  }
  if (input.promotionReadiness === "deprecated" || input.promotionReadiness === "archived") {
    return "blocked";
  }
  if (input.pendingCandidateCount > 0) {
    return "conflict";
  }
  if (input.syncFreshness === "stale") {
    return "projection-lag";
  }
  return "ready";
}

function journeyStages(input: {
  editionCount: number;
  syncFreshness: CatalogScopeSyncFreshness;
  pendingCandidateCount: number;
  promotionReadiness: CatalogScopePromotionReadiness;
}): readonly CatalogScopeJourneyStage[] {
  const syncFresh = input.syncFreshness === "fresh";
  return [
    { key: "coverage", status: input.editionCount > 0 ? "complete" : "current" },
    { key: "sync", status: syncFresh ? "complete" : "current" },
    // Live child jobs are spawned by a sync; a fresh scope implies a recent run,
    // a stale one is waiting on the next sync.
    { key: "jobs", status: syncFresh ? "complete" : "upcoming" },
    { key: "candidates", status: input.pendingCandidateCount > 0 ? "current" : "complete" },
    { key: "promotion", status: promotionStageStatus(input.promotionReadiness) },
  ];
}

function promotionStageStatus(readiness: CatalogScopePromotionReadiness): CatalogScopeJourneyStageStatus {
  switch (readiness) {
    case "live":
      return "complete";
    case "deprecated":
    case "archived":
      return "blocked";
    case "unpublished":
      return "upcoming";
  }
}
