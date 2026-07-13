import type { ListResponse } from "@chase-sets/http/responses";
import type { CatalogScopeRecordDetail } from "../../../../scope-registry/ui/contracts";

// ---------------------------------------------------------------------------
// Scope-first landing read model (Catalog control-plane v2 `catalog-home`).
//
// Pure transform from the canonical Scope Record list into the rows and facets
// the scope-first landing renders. This is the "canonical scope record list"
// entry point: every scope, its coverage breadth, promotion posture, and sync
// freshness, filterable and each opening its own Scope Detail journey.
//
// Sync freshness and promotion readiness are honest proxies derived from the
// canonical record itself (its language-edition coverage, lifecycle status, and
// projection recency) — the same freshness proxy the attention queue uses —
// until the dedicated scope-sync-state model lands. No per-scope
// aggregate is fabricated here.
// ---------------------------------------------------------------------------

// Mirrors `CATALOG_ATTENTION_STALE_SCOPE_SYNC_MS` (attention-queue runtime): a
// scope whose projection has not advanced in two weeks reads as a stale sync.
// Kept as a local constant so this browser read model never imports the
// DB-backed attention-queue runtime module.
export const SCOPE_LANDING_STALE_SYNC_MS = 14 * 24 * 60 * 60 * 1000;

export type CatalogScopeLandingFilters = Readonly<{
  search: string;
  productDomain: string;
  languageEdition: string;
  lifecycleStatus: string;
}>;

export type CatalogScopePromotionReadiness = "unpublished" | "live" | "deprecated" | "archived";

export type CatalogScopeSyncFreshness = "fresh" | "stale";

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
    /** Rows shown after the client-side language-edition facet is applied. */
    shown: number;
  }>;
  facets: Readonly<{
    /** Language editions present across the loaded page, plus the active one. */
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
  scopes: ListResponse<CatalogScopeRecordDetail>;
  filters: CatalogScopeLandingFilters;
  generatedAt: string;
}): CatalogScopeLandingReadModel {
  const generatedAtMs = Date.parse(input.generatedAt);
  const languageFilter = input.filters.languageEdition.trim();

  const allRows = input.scopes.items.map((scope) => toLandingRow(scope, generatedAtMs));
  const rows = languageFilter ? allRows.filter((row) => row.languageEditions.includes(languageFilter)) : allRows;

  const languageEditions = new Set<string>();
  for (const row of allRows) {
    for (const edition of row.languageEditions) {
      languageEditions.add(edition);
    }
  }
  if (languageFilter) {
    languageEditions.add(languageFilter);
  }

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

function toLandingRow(scope: CatalogScopeRecordDetail, generatedAtMs: number): CatalogScopeLandingRow {
  return {
    scopeRecordId: scope.scopeRecordId,
    name: scope.name,
    officialSetCode: scope.officialSetCode,
    productDomain: scope.productDomain,
    scopeKind: scope.scopeKind,
    languageEditions: scope.languageEditions,
    languageEditionCount: scope.languageEditions.length,
    lifecycleStatus: scope.lifecycleStatus,
    promotionReadiness: promotionReadinessFromLifecycle(scope.lifecycleStatus),
    syncFreshness: syncFreshnessFromUpdatedAt(scope.updatedAt, generatedAtMs),
    updatedAt: scope.updatedAt,
    detailHref: scopeDetailHref(scope.scopeRecordId),
  };
}

function promotionReadinessFromLifecycle(lifecycleStatus: string): CatalogScopePromotionReadiness {
  switch (lifecycleStatus) {
    case "active":
      return "live";
    case "deprecated":
      return "deprecated";
    case "archived":
      return "archived";
    default:
      // draft (or any not-yet-published state): the canonical record still
      // needs confirming before its scope can promote Catalog Items.
      return "unpublished";
  }
}

function syncFreshnessFromUpdatedAt(updatedAt: string, generatedAtMs: number): CatalogScopeSyncFreshness {
  const updatedMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedMs) || !Number.isFinite(generatedAtMs)) {
    // An unparseable timestamp is treated as stale so it surfaces for review
    // rather than falsely reading as fresh.
    return "stale";
  }
  return generatedAtMs - updatedMs <= SCOPE_LANDING_STALE_SYNC_MS ? "fresh" : "stale";
}
