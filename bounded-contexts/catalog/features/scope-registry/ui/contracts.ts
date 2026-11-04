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
