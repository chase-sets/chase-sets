import { createHash } from "node:crypto";

// Durable per-scope sync state tracks a Catalog sync scope's cross-provider
// lifecycle across runs: for each (scope, provider unit) pair, whether the
// last known attempt settled, is still in flight, or needs operator
// attention. It is intentionally decoupled from the CatalogSyncScope v1
// contract's reference shape (kind/id/name/seriesId/seriesName) so this slice
// stays portable if the scope identity contract changes shape later; only
// `computeCatalogSyncScopeKey` knows how to turn that shape into a stable key.
export type CatalogScopeSyncUnitState = "never-synced" | "pending" | "running" | "settled" | "failed" | "stale";

export type CatalogScopeSyncScopeDescriptor = Readonly<{
  productDomain: string;
  productForm: string | null;
  languageCode: string | null;
  referenceKind: string | null;
  referenceId: string | null;
  referenceName: string | null;
}>;

// The observed status of a single provider unit's most recent attempt within
// a sync run, in the vocabulary the durable job store and the sync-run fanout
// already report. This is the "job event" the projection acceptance criteria
// reacts to: every hook site (fanout completion, worker completion/failure,
// retry/resume) narrows what it knows into one of these statuses and calls
// `deriveCatalogScopeSyncUnitState`.
export type CatalogScopeSyncUnitObservedStatus =
  | "queued"
  | "running"
  | "retried"
  | "partial"
  | "completed"
  | "reused-settled-job"
  | "failed"
  | "cancelled"
  | "stale"
  | "enqueue-failed";

// Pure state-transition function: no I/O, no dependency on the durable job
// store shape. Fed a sequence of observed statuses for the same (scope,
// provider unit), it always resolves to the settlement state implied by the
// LATEST status alone — the read model applies it once per hook, so the
// projection is naturally idempotent and out-of-order-safe as long as callers
// only ever record forward job-lifecycle transitions.
export function deriveCatalogScopeSyncUnitState(status: CatalogScopeSyncUnitObservedStatus): CatalogScopeSyncUnitState {
  switch (status) {
    case "completed":
    case "reused-settled-job":
      return "settled";
    case "running":
    case "retried":
    case "partial":
      return "running";
    case "queued":
      return "pending";
    case "stale":
      return "stale";
    case "failed":
    case "cancelled":
    case "enqueue-failed":
      return "failed";
    default:
      return assertNeverStatus(status);
  }
}

// A unit is safe to fast-forward ("Re-running Sync scope on a settled scope
// is a fast no-op") only when its last known attempt settled AND the child
// execution scope the planner would use today still matches the one that
// settled. A mapping change, a language/product-form edit, or a provider
// re-pointing its child scope invalidates the fast-forward automatically
// because the stored childExecutionScope no longer deep-equals the current
// one — no separate staleness signal is required for that case.
export function catalogScopeSyncUnitIsFastForwardable(input: {
  state: CatalogScopeSyncUnitState;
  storedChildExecutionScope: Readonly<Record<string, string>> | null;
  currentChildExecutionScope: Readonly<Record<string, string>> | null;
}): boolean {
  if (input.state !== "settled") {
    return false;
  }
  if (!input.storedChildExecutionScope || !input.currentChildExecutionScope) {
    return false;
  }

  return stableJsonStringify(input.storedChildExecutionScope) === stableJsonStringify(input.currentChildExecutionScope);
}

// Deterministic key for a CatalogSyncScope v1 descriptor. Reference id falls
// back to reference name (mirrors `catalog-sync-scope-planner.ts`'s own
// fallback for expansion/set references that have no persisted id yet), so
// the same operator-facing scope always resolves to the same durable state
// row even before a canonical scope record exists for it.
export function computeCatalogSyncScopeKey(descriptor: CatalogScopeSyncScopeDescriptor): string {
  const normalized = {
    productDomain: normalizeKey(descriptor.productDomain),
    productForm: normalizeKey(descriptor.productForm),
    languageCode: normalizeKey(descriptor.languageCode),
    referenceKind: normalizeKey(descriptor.referenceKind),
    reference: normalizeKey(descriptor.referenceId) ?? normalizeKey(descriptor.referenceName),
  };

  return createHash("sha256").update(stableJsonStringify(normalized)).digest("hex");
}

function normalizeKey(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : null;
}

function stableJsonStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, sortKeysDeep(entryValue)]),
    );
  }
  return value;
}

function assertNeverStatus(status: never): never {
  throw new Error(`Unhandled Catalog scope sync unit observed status: ${String(status)}`);
}
