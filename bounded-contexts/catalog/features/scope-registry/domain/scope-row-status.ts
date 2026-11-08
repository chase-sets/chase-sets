// ---------------------------------------------------------------------------
// Scope Record row status
//
// The two row facts the scope-first Catalog Home and Scope Detail show for a
// canonical Scope Record, derived once by the Catalog API from the record
// itself: its promotion posture (from the lifecycle status) and an age-based
// sync-freshness proxy (from the projection's `updatedAt`). The attention queue
// flags stale scope syncs with the same window. Superseded by the
// scope-sync-state model when it lands.
// ---------------------------------------------------------------------------

// A scope whose projection has not advanced in two weeks reads as a stale sync.
// Two weeks keeps steady-state catalogs quiet while flagging abandoned syncs.
export const CATALOG_SCOPE_STALE_SYNC_MS = 14 * 24 * 60 * 60 * 1000;

export type CatalogScopePromotionReadiness = "unpublished" | "live" | "deprecated" | "archived";

export type CatalogScopeSyncFreshness = "fresh" | "stale";

export function catalogScopePromotionReadiness(lifecycleStatus: string): CatalogScopePromotionReadiness {
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

// Fresh only when `updatedAt` parses and is no more than the stale window before
// the generation time. An unparseable timestamp reads as stale so it surfaces
// for review rather than falsely reading as fresh.
export function catalogScopeSyncFreshness(updatedAt: string, generatedAt: string): CatalogScopeSyncFreshness {
  const updatedMs = Date.parse(updatedAt);
  const generatedMs = Date.parse(generatedAt);
  if (!Number.isFinite(updatedMs) || !Number.isFinite(generatedMs)) {
    return "stale";
  }
  return generatedMs - updatedMs <= CATALOG_SCOPE_STALE_SYNC_MS ? "fresh" : "stale";
}
