import type { CatalogAliasReviewCandidateSummary } from "../../alias-equivalence/api/alias-review-admin-contracts";
import type { CatalogScopePromotionReadiness, CatalogScopeSyncFreshness } from "../domain/scope-row-status";

export type { CatalogScopePromotionReadiness, CatalogScopeSyncFreshness };

// Client-facing Scope Record contract. The API returns this camelCase shape
// (see `../api/route.ts#scopeRecordDetailFromRow`); this file is the browser
// side of that same contract so route loaders and UI components share one
// type without importing server-only modules.
export interface CatalogScopeRecordDetail {
  scopeRecordId: string;
  productDomain: string;
  scopeKind: string;
  referenceTypeKey: string;
  referenceRecordId: string;
  referenceRecordKey: string;
  name: string;
  parentScopeRecordId: string | null;
  productLineScopeRecordId: string | null;
  seriesScopeRecordId: string | null;
  releaseDate: string | null;
  officialSetCode: string | null;
  languageEditions: readonly string[];
  lifecycleStatus: string;
  updatedAt: string;
  /** API-owned: the promotion posture of the record's lifecycle status. */
  promotionReadiness: CatalogScopePromotionReadiness;
  /** API-owned: whether `updatedAt` is within the stale-sync window of the response. */
  syncFreshness: CatalogScopeSyncFreshness;
}

export interface CatalogScopeRecordListResponse {
  /** When the API derived each row's promotion readiness and sync freshness. */
  generatedAt?: string;
  items: readonly CatalogScopeRecordDetail[];
  total: number;
  count: number;
  facets?: Readonly<{
    languageEditions: readonly string[];
  }>;
}

// A scope's language editions and journey, as `GET /scope-records/:id/journey`
// returns them. The Catalog API owns both rules (which edition is canonical,
// how an edition links, and the journey's condition precedence); clients render
// them as given.

export type CatalogScopeLanguageEditionLinkState = "linked" | "pending-review" | "not-yet-observed";

export type CatalogScopeLanguageEditionSummary = Readonly<{
  languageCode: string;
  isCanonical: boolean;
  linkState: CatalogScopeLanguageEditionLinkState;
  acceptedAliasCount: number;
  /** Pending set-equivalent/series-equivalent candidates for this edition, this scope only. */
  pendingCandidates: readonly CatalogAliasReviewCandidateSummary[];
  /** Accepted/auto-accepted candidates for this edition, so a linked edition can still be revoked inline. */
  acceptedCandidates: readonly CatalogAliasReviewCandidateSummary[];
}>;

export type CatalogScopeLanguageEditionReviewReadModel = Readonly<{
  scopeRecordId: string;
  referenceRecordId: string;
  editions: readonly CatalogScopeLanguageEditionSummary[];
}>;

export type CatalogScopeJourneyStageKey = "coverage" | "sync" | "jobs" | "candidates" | "promotion";

export type CatalogScopeJourneyStageStatus = "complete" | "current" | "upcoming" | "blocked";

// The single condition the whole journey is in, most pressing first. `loading`
// is a page-owned transient, so it is not part of this union.
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
  promotionReadiness: CatalogScopePromotionReadiness;
  syncFreshness: CatalogScopeSyncFreshness;
}>;

export type CatalogScopeJourneyResponse = Readonly<{
  generatedAt: string;
  scope: CatalogScopeRecordDetail;
  /** The editions to review; null when the scope has one edition or none. */
  languageEditions: CatalogScopeLanguageEditionReviewReadModel | null;
  /** True when the alias review could not be read, so the editions show no candidates. */
  languageEditionReviewFailed: boolean;
  overview: CatalogScopeJourneyOverviewReadModel;
}>;
