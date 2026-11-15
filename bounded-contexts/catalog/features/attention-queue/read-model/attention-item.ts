// ---------------------------------------------------------------------------
// Catalog attention queue — unified item model
//
// The attention queue is the "needs-you" inbox that unifies work scattered
// across the integration control plane into one severity-ordered list. This
// module owns the item shape, the pure ordering logic and the count and window
// vocabulary; the collectors map each source read model into these items, and
// the assembler merges + sorts them. Everything here is deterministic and DB-free
// so the ordering contract is unit-testable in isolation.
// ---------------------------------------------------------------------------

// The six sources that feed the queue. Each maps 1:1 to a catalog read model an
// operator would otherwise have to hunt for on a separate surface.
export type CatalogAttentionItemKind =
  | "unmapped-scope"
  | "merge-conflict"
  | "provider-health"
  | "import-job"
  | "alias-candidate"
  | "stale-scope-sync";

export const CATALOG_ATTENTION_ITEM_KINDS = [
  "unmapped-scope",
  "merge-conflict",
  "provider-health",
  "import-job",
  "alias-candidate",
  "stale-scope-sync",
] as const satisfies readonly CatalogAttentionItemKind[];

export function isCatalogAttentionItemKind(value: unknown): value is CatalogAttentionItemKind {
  return typeof value === "string" && (CATALOG_ATTENTION_ITEM_KINDS as readonly string[]).includes(value);
}

// A record with one entry per kind, built without casts so a new kind is a type error.
export function catalogAttentionKindRecord<T>(
  value: (kind: CatalogAttentionItemKind) => T,
): Record<CatalogAttentionItemKind, T> {
  return {
    "unmapped-scope": value("unmapped-scope"),
    "merge-conflict": value("merge-conflict"),
    "provider-health": value("provider-health"),
    "import-job": value("import-job"),
    "alias-candidate": value("alias-candidate"),
    "stale-scope-sync": value("stale-scope-sync"),
  };
}

// Ordering severity. `critical` blocks the primary import-to-promotion path;
// `warning` degrades it; `info` is queued work that has not auto-cleared.
export type CatalogAttentionSeverity = "critical" | "warning" | "info";

// Higher rank sorts first. Kept explicit (not the union order) so the ordering
// contract is legible and stable under refactors.
export const CATALOG_ATTENTION_SEVERITY_RANK: Readonly<Record<CatalogAttentionSeverity, number>> = {
  critical: 3,
  warning: 2,
  info: 1,
};

// The inline resolution an item carries. `intent` is the daily-surface form
// intent the queue POSTs; every attention intent resolves on the daily surface
// (import-to-promotion), so acting never navigates to a different surface.
// `mode` tells the panel whether the resolution is a one-click command or opens
// an inline drawer on the same surface. `fields` are the hidden form values the
// command handler needs to act on exactly this item.
export type CatalogAttentionResolutionMode = "command" | "drawer";

export type CatalogAttentionResolution = Readonly<{
  intent: string;
  mode: CatalogAttentionResolutionMode;
  // Localization key for the primary affordance label.
  labelKey: string;
  fields: Readonly<Record<string, string>>;
  /** Entity home opened by the drawer; inline commands do not need a navigation href. */
  href?: string;
  /** Explicitly distinguishes a missing/deleted target from a resolvable one. */
  unavailable?: boolean;
  // Whether the operator must supply a reason (dismiss / reject style actions).
  requiresReason?: boolean;
}>;

export type CatalogAttentionItem = Readonly<{
  // Stable identity across reloads: `${kind}:${sourceId}`. Used for dedupe,
  // dismissal keying, and React keys. Never changes for the same underlying row.
  itemKey: string;
  kind: CatalogAttentionItemKind;
  severity: CatalogAttentionSeverity;
  // Localization key + params for the item's one-line title and supporting detail.
  titleKey: string;
  titleParams: Readonly<Record<string, string | number>>;
  detailKey: string;
  detailParams: Readonly<Record<string, string | number>>;
  // Provider / unit scoping when the source carries it (health, jobs, mappings).
  providerKey: string | null;
  unitKey: string | null;
  // When the underlying work first needed attention. Drives the age tiebreak and
  // the "aged" label; ISO-8601 UTC.
  observedAt: string;
  // The primary inline resolution and any secondary resolutions (e.g. accept vs
  // reject for an alias candidate). The universal park action (dismiss/defer) is
  // added by the panel, not carried here.
  resolution: CatalogAttentionResolution;
  secondaryResolutions: readonly CatalogAttentionResolution[];
}>;

// Severity first (critical → info), then oldest-first so the most-aged work
// rises within a severity band, then a stable key tiebreak. Pure and total.
export function sortCatalogAttentionItems(items: readonly CatalogAttentionItem[]): readonly CatalogAttentionItem[] {
  return [...items].sort((left, right) => {
    const severityDelta =
      CATALOG_ATTENTION_SEVERITY_RANK[right.severity] - CATALOG_ATTENTION_SEVERITY_RANK[left.severity];
    if (severityDelta !== 0) {
      return severityDelta;
    }
    const ageDelta = left.observedAt.localeCompare(right.observedAt);
    if (ageDelta !== 0) {
      return ageDelta;
    }
    return left.itemKey.localeCompare(right.itemKey);
  });
}

export const CATALOG_ATTENTION_SEVERITIES = [
  "critical",
  "warning",
  "info",
] as const satisfies readonly CatalogAttentionSeverity[];

export function catalogAttentionSeverityRecord<T>(
  value: (severity: CatalogAttentionSeverity) => T,
): Record<CatalogAttentionSeverity, T> {
  return { critical: value("critical"), warning: value("warning"), info: value("info") };
}

// The severities each source can produce. A lower-bound source leaves every
// severity it can produce uncertain, because its unseen tail could hold any of them.
export const CATALOG_ATTENTION_KIND_SEVERITIES: Readonly<
  Record<CatalogAttentionItemKind, readonly CatalogAttentionSeverity[]>
> = {
  "unmapped-scope": ["warning"],
  "merge-conflict": ["critical", "warning"],
  "provider-health": ["critical"],
  "import-job": ["critical", "warning"],
  "alias-candidate": ["info"],
  "stale-scope-sync": ["warning"],
};

// Whether a count covers every eligible item (`exact`) or only what its source
// could observe (`lower-bound`), as with an incomplete active import-job snapshot.
export type CatalogAttentionTotalKind = "exact" | "lower-bound";

export const CATALOG_ATTENTION_TOTAL_KINDS = [
  "exact",
  "lower-bound",
] as const satisfies readonly CatalogAttentionTotalKind[];

// Eligible, unparked work across the whole cohort of every source, never the
// length of the returned window.
export type CatalogAttentionQueueCounts = Readonly<{
  total: number;
  bySeverity: Readonly<Record<CatalogAttentionSeverity, number>>;
  byKind: Readonly<Record<CatalogAttentionItemKind, number>>;
}>;

export type CatalogAttentionQueueCountBasis = Readonly<{
  total: CatalogAttentionTotalKind;
  bySeverity: Readonly<Record<CatalogAttentionSeverity, CatalogAttentionTotalKind>>;
}>;

// The page of a queue read. `kind: null` is the summary, where every kind returns
// its own window; naming a kind pages that kind alone and leaves the others at a
// zero-length window (their totals still count).
export type CatalogAttentionQueueWindow = Readonly<{
  kind: CatalogAttentionItemKind | null;
  offset: number;
  limit: number;
}>;

export const CATALOG_ATTENTION_DEFAULT_WINDOW_LIMIT = 20;
export const CATALOG_ATTENTION_MAX_WINDOW_LIMIT = 200;

export const CATALOG_ATTENTION_SUMMARY_WINDOW: CatalogAttentionQueueWindow = Object.freeze({
  kind: null,
  offset: 0,
  limit: CATALOG_ATTENTION_DEFAULT_WINDOW_LIMIT,
});

// The window one kind reads inside a queue window.
export function catalogAttentionKindWindow(
  window: CatalogAttentionQueueWindow,
  kind: CatalogAttentionItemKind,
): Readonly<{ offset: number; limit: number }> {
  return window.kind === null || window.kind === kind
    ? { offset: window.offset, limit: window.limit }
    : { offset: 0, limit: 0 };
}

// What a database-backed source reads: the clock parked items are judged at and
// the window in that source's queue order (severity, then age, then key).
export type CatalogAttentionSourceWindow = Readonly<{
  now: string;
  offset: number;
  limit: number;
}>;

// A database-backed source's answer: the exact size of its eligible, unparked
// cohort and the rows of the requested window.
export type CatalogAttentionSourcePage<Row> = Readonly<{
  total: number;
  rows: readonly Row[];
}>;
