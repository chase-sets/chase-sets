// Durable, storage-backed working set for Source Observation review selection.
//
// The prior mechanism round-tripped `selectedObservationIds` through the URL on
// every checkbox toggle (a client GET navigation), which meant a 500-row bulk
// selection inflated the address bar on every click and, per the Catalog Control
// Plane v2 blueprint, selection is durable PAGE STATE, not a URL detour. This
// module makes the working set live in `sessionStorage` instead: it survives a
// reload or an in-tab navigation for the scope it belongs to, and it never grows
// the URL no matter how large the selection gets. Bulk command forms read the
// working set directly (via the hook in `use-import-to-promotion-workspace.ts`),
// not the URL.
//
// `sessionStorage` (not `localStorage`) is deliberate: a review working set is
// tab-scoped operator state, not a cross-session preference, so it should not
// silently resurrect a stale selection days later in a different tab.

const STORAGE_PREFIX = "catalog.primaryWorkbench.observationSelection.";

function storageKeyFor(scopeKey: string): string {
  return `${STORAGE_PREFIX}${scopeKey}`;
}

function sessionStorageOrNull(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    // Storage access can throw (privacy mode, disabled storage); fail closed to
    // an ephemeral, in-memory-only selection rather than crashing the workbench.
    return null;
  }
}

// A stable key for the review scope a selection belongs to, so switching
// provider/unit/import-scope/profile never leaks one scope's selection into
// another's working set.
export function observationSelectionScopeKey(scope: {
  providerKey: string | null;
  unitKey: string | null;
  importScope: string | null;
  profileVersion: string | null;
}): string {
  return [
    scope.providerKey ?? "none",
    scope.unitKey ?? "none",
    scope.importScope ?? "none",
    scope.profileVersion ?? "none",
  ]
    .map((segment) => segment.replace(/[^A-Za-z0-9_.:-]+/g, "_"))
    .join("|");
}

export function readPersistedObservationSelection(scopeKey: string): readonly string[] {
  const storage = sessionStorageOrNull();
  if (!storage) {
    return [];
  }
  try {
    const raw = storage.getItem(storageKeyFor(scopeKey));
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

export function writePersistedObservationSelection(scopeKey: string, observationIds: readonly string[]): void {
  const storage = sessionStorageOrNull();
  if (!storage) {
    return;
  }
  try {
    if (observationIds.length === 0) {
      storage.removeItem(storageKeyFor(scopeKey));
      return;
    }
    storage.setItem(storageKeyFor(scopeKey), JSON.stringify(observationIds));
  } catch {
    // Storage can be full or unavailable mid-session; the in-memory Set the
    // caller already holds remains the source of truth for this render, so a
    // failed persist degrades to "not durable this reload" rather than failing
    // the selection itself.
  }
}
