// ---------------------------------------------------------------------------
// Catalog attention queue — unified item model
//
// The attention queue is the "needs-you" inbox that unifies work scattered
// across the integration control plane into one severity-ordered list. This
// module owns the item shape and the pure ordering / summary logic; the
// collectors map each source read model into these items, and the assembler
// merges + sorts them. Everything here is deterministic and DB-free so the
// ordering contract is unit-testable in isolation.
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

export type CatalogAttentionQueueCounts = Readonly<{
  total: number;
  bySeverity: Readonly<Record<CatalogAttentionSeverity, number>>;
  byKind: Readonly<Record<CatalogAttentionItemKind, number>>;
}>;

// Source-of-truth counts, computed from the same items the queue renders so the
// count strip can never disagree with the list (AC: counts match source-of-truth).
export function summarizeCatalogAttentionItems(items: readonly CatalogAttentionItem[]): CatalogAttentionQueueCounts {
  const bySeverity: Record<CatalogAttentionSeverity, number> = { critical: 0, warning: 0, info: 0 };
  const byKind: Record<CatalogAttentionItemKind, number> = {
    "unmapped-scope": 0,
    "merge-conflict": 0,
    "provider-health": 0,
    "import-job": 0,
    "alias-candidate": 0,
    "stale-scope-sync": 0,
  };

  for (const item of items) {
    bySeverity[item.severity] += 1;
    byKind[item.kind] += 1;
  }

  return { total: items.length, bySeverity, byKind };
}
