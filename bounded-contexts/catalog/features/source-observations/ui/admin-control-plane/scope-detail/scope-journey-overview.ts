import type { CatalogScopeRecordDetail } from "../../../../scope-registry/ui/contracts";
import type { CatalogScopeLanguageEditionReviewReadModel } from "./language-editions/language-edition-review";

// ---------------------------------------------------------------------------
// Scope Detail — journey overview
//
// A pure composer that turns one scope's canonical record plus its
// language-edition review model into the ordered journey a scope travels from
// "appears in the registry" to "promoted draft Catalog Items": coverage → sync
// → live jobs → candidate review → promotion. It computes each stage's status
// and the single condition the whole journey is in right now, so the scope
// detail page frames the work in place instead of a per-provider-unit surface.
//
// This overview reads only from data already resolved for the page (the scope
// record and the reference-record-scoped alias review), so it never fans out to
// another API. The interactive per-stage commands (run a sync, promote) reach
// the operator through their own sections; this model answers "where is this
// scope in its journey, and what is blocking it?".
// ---------------------------------------------------------------------------

// Mirror the landing model's stale-sync threshold (which itself mirrors the
// attention-queue runtime): a scope whose projection has not advanced in two
// weeks reads as a lagging sync on both scope surfaces.
export const SCOPE_JOURNEY_STALE_SYNC_MS = 14 * 24 * 60 * 60 * 1000;

export type CatalogScopeJourneyStageKey = "coverage" | "sync" | "jobs" | "candidates" | "promotion";

export type CatalogScopeJourneyStageStatus = "complete" | "current" | "upcoming" | "blocked";

export type CatalogScopeJourneyPromotionReadiness = "unpublished" | "live" | "deprecated" | "archived";

export type CatalogScopeJourneySyncFreshness = "fresh" | "stale";

// The single condition the whole journey is in. `loading` is a page-owned
// transient (it is not derivable from a resolved read model), so it is not part
// of this union — the panel renders it from a prop. The remaining conditions are
// mutually exclusive and ordered by precedence in `journeyCondition`.
export type CatalogScopeJourneyCondition =
  | "empty"
  | "partial-failure"
  | "blocked"
  | "conflict"
  | "projection-lag"
  | "ready";

export type CatalogScopeJourneyStage = Readonly<{
  key: CatalogScopeJourneyStageKey;
  status: CatalogScopeJourneyStageStatus;
}>;

export type CatalogScopeJourneyOverviewReadModel = Readonly<{
  scopeRecordId: string;
  condition: CatalogScopeJourneyCondition;
  stages: readonly CatalogScopeJourneyStage[];
  editionCount: number;
  linkedEditionCount: number;
  pendingCandidateCount: number;
  promotionReadiness: CatalogScopeJourneyPromotionReadiness;
  syncFreshness: CatalogScopeJourneySyncFreshness;
}>;

export function buildCatalogScopeJourneyOverviewReadModel(input: {
  scope: CatalogScopeRecordDetail;
  // Already scoped to this scope's reference record. Null when the scope has a
  // single edition and therefore no sibling editions to review.
  languageEditionReview: CatalogScopeLanguageEditionReviewReadModel | null;
  // True when the supplementary alias-review load failed and the section is
  // rendering a degraded (empty) review model rather than the real candidates.
  languageEditionReviewFailed: boolean;
  generatedAt: string;
}): CatalogScopeJourneyOverviewReadModel {
  const { scope, languageEditionReview, languageEditionReviewFailed } = input;

  const editionCount = scope.languageEditions.length;
  const { linkedEditionCount, pendingCandidateCount } = editionCoverage(languageEditionReview, editionCount);
  const promotionReadiness = promotionReadinessFromLifecycle(scope.lifecycleStatus);
  const syncFreshness = syncFreshnessFromUpdatedAt(scope.updatedAt, Date.parse(input.generatedAt));

  const condition = journeyCondition({
    editionCount,
    languageEditionReviewFailed,
    promotionReadiness,
    pendingCandidateCount,
    syncFreshness,
  });

  return {
    scopeRecordId: scope.scopeRecordId,
    condition,
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
  promotionReadiness: CatalogScopeJourneyPromotionReadiness;
  pendingCandidateCount: number;
  syncFreshness: CatalogScopeJourneySyncFreshness;
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
  syncFreshness: CatalogScopeJourneySyncFreshness;
  pendingCandidateCount: number;
  promotionReadiness: CatalogScopeJourneyPromotionReadiness;
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

function promotionStageStatus(readiness: CatalogScopeJourneyPromotionReadiness): CatalogScopeJourneyStageStatus {
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

function promotionReadinessFromLifecycle(lifecycleStatus: string): CatalogScopeJourneyPromotionReadiness {
  switch (lifecycleStatus) {
    case "active":
      return "live";
    case "deprecated":
      return "deprecated";
    case "archived":
      return "archived";
    default:
      return "unpublished";
  }
}

function syncFreshnessFromUpdatedAt(updatedAt: string, generatedAtMs: number): CatalogScopeJourneySyncFreshness {
  const updatedMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedMs) || !Number.isFinite(generatedAtMs)) {
    // An unparseable timestamp reads as stale so it surfaces for review rather
    // than falsely reading as fresh.
    return "stale";
  }
  return generatedAtMs - updatedMs <= SCOPE_JOURNEY_STALE_SYNC_MS ? "fresh" : "stale";
}
