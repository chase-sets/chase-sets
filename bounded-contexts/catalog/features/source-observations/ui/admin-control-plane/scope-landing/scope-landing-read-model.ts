import type {
  CatalogScopePromotionReadiness,
  CatalogScopeRecordDetail,
  CatalogScopeRecordListResponse,
  CatalogScopeSyncFreshness,
} from "../../../../scope-registry/ui/contracts";

// ---------------------------------------------------------------------------
// Scope-first landing read model (Catalog control-plane v2 `catalog-home`).
//
// Pure transform from the canonical Scope Record list into the rows and facets
// the scope-first landing renders. This is the "canonical scope record list"
// entry point: every scope, its coverage breadth, promotion posture, and sync
// freshness, filterable and each opening its own Scope Detail journey.
//
// Sync freshness and promotion readiness come from the Catalog API
// (`GET /scope-records`), which derives both once from the canonical record:
// its lifecycle status and projection recency, the same freshness window the
// attention queue uses. This read model passes them through unchanged. No
// per-scope aggregate is fabricated here.
// ---------------------------------------------------------------------------

export type CatalogScopeLandingFilters = Readonly<{
  search: string;
  productDomain: string;
  languageEdition: string;
  lifecycleStatus: string;
}>;

export type { CatalogScopePromotionReadiness, CatalogScopeSyncFreshness };

export type CatalogScopeLandingRow = Readonly<{
  scopeRecordId: string;
  name: string;
  officialSetCode: string | null;
  productDomain: string;
  scopeKind: string;
  languageEditions: readonly string[];
  languageEditionCount: number;
  lifecycleStatus: string;
  promotionReadiness: CatalogScopePromotionReadiness;
  syncFreshness: CatalogScopeSyncFreshness;
  updatedAt: string;
  /** Deep-link into this scope's own Scope Detail journey. */
  detailHref: string;
}>;

export type CatalogScopeLandingReadModel = Readonly<{
  generatedAt: string;
  rows: readonly CatalogScopeLandingRow[];
  counts: Readonly<{
    /** Total matching the server-side filters (product domain / status / search). */
    total: number;
    /** Rows returned by the API after the server-side language filter. */
    shown: number;
  }>;
  facets: Readonly<{
    /** Language editions observed across the complete filtered cohort. */
    languageEditions: readonly string[];
  }>;
  filters: CatalogScopeLandingFilters;
}>;

export const EMPTY_SCOPE_LANDING_FILTERS: CatalogScopeLandingFilters = {
  search: "",
  productDomain: "",
  languageEdition: "",
  lifecycleStatus: "",
};

export function scopeDetailHref(scopeRecordId: string): string {
  return `/scopes/${encodeURIComponent(scopeRecordId)}`;
}

export function buildCatalogScopeLandingReadModel(input: {
  scopes: CatalogScopeRecordListResponse;
  filters: CatalogScopeLandingFilters;
  generatedAt: string;
}): CatalogScopeLandingReadModel {
  const rows = input.scopes.items.map(toLandingRow);
  const languageEditions = new Set(
    input.scopes.facets?.languageEditions ?? input.scopes.items.flatMap((scope) => scope.languageEditions),
  );
  const languageFilter = input.filters.languageEdition.trim();
  if (languageFilter) languageEditions.add(languageFilter);

  return {
    generatedAt: input.generatedAt,
    rows,
    counts: {
      total: input.scopes.total,
      shown: rows.length,
    },
    facets: {
      languageEditions: [...languageEditions].sort((left, right) => left.localeCompare(right)),
    },
    filters: input.filters,
  };
}

function toLandingRow(scope: CatalogScopeRecordDetail): CatalogScopeLandingRow {
  return {
    scopeRecordId: scope.scopeRecordId,
    name: scope.name,
    officialSetCode: scope.officialSetCode,
    productDomain: scope.productDomain,
    scopeKind: scope.scopeKind,
    languageEditions: scope.languageEditions,
    languageEditionCount: scope.languageEditions.length,
    lifecycleStatus: scope.lifecycleStatus,
    promotionReadiness: scope.promotionReadiness,
    syncFreshness: scope.syncFreshness,
    updatedAt: scope.updatedAt,
    detailHref: scopeDetailHref(scope.scopeRecordId),
  };
}
