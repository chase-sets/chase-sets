// ---------------------------------------------------------------------------
// Catalog attention queue — read-model contract + assembler
//
// The serializable read model the Catalog home surfaces render, plus the pure
// assembler that folds the six sources into one severity-ordered window.
// Counts are each source's eligible, unparked cohort, never the length of the
// returned window: database sources arrive with exact totals beside one window,
// provider readiness is a finite set counted in full, and import jobs count the
// active snapshot the job store observed, so an incomplete snapshot is a lower
// bound rather than a total.
// ---------------------------------------------------------------------------

import type { CatalogAliasCandidateAttentionRow } from "../../alias-equivalence/read-model/queries";
import type { ProviderScopeMappingAttentionRow } from "../../provider-scope-mapping/read-model/queries";
import type { CatalogScopeRecordAttentionRow } from "../../scope-registry/read-model/queries";
import type { CatalogMergeCandidateAttentionPage } from "../../source-observations/read-model/queries";
import type { CatalogIntegrationControlPlaneUnitReadiness } from "../../source-observations/api/runtime";
import type { CatalogIntegrationUnitActivity } from "../../source-observations/api/admin-control-plane-overview";
import {
  collectAliasCandidateItems,
  collectImportJobItems,
  collectMergeConflictItems,
  collectProviderHealthItems,
  collectStaleScopeSyncItems,
  collectUnmappedScopeItems,
} from "../read-model/collectors";
import {
  CATALOG_ATTENTION_DEFAULT_WINDOW_LIMIT,
  CATALOG_ATTENTION_ITEM_KINDS,
  CATALOG_ATTENTION_KIND_SEVERITIES,
  CATALOG_ATTENTION_MAX_WINDOW_LIMIT,
  CATALOG_ATTENTION_SEVERITIES,
  catalogAttentionKindRecord,
  catalogAttentionKindWindow,
  catalogAttentionSeverityRecord,
  isCatalogAttentionItemKind,
  sortCatalogAttentionItems,
  type CatalogAttentionItem,
  type CatalogAttentionItemKind,
  type CatalogAttentionQueueCountBasis,
  type CatalogAttentionQueueCounts,
  type CatalogAttentionQueueWindow,
  type CatalogAttentionSeverity,
  type CatalogAttentionSourcePage,
  type CatalogAttentionTotalKind,
} from "../read-model/attention-item";

// The source datasets the assembler folds into the queue. Database sources have
// already excluded parked items and carry their exact eligible total beside the
// requested window; readiness and import jobs are observed in memory.
export type CatalogAttentionQueueSources = Readonly<{
  proposedScopeMappings: CatalogAttentionSourcePage<ProviderScopeMappingAttentionRow>;
  mergeCandidates: CatalogMergeCandidateAttentionPage;
  unitReadiness: readonly CatalogIntegrationControlPlaneUnitReadiness[];
  // Every observed active job mapped to its unit with no display slice, and
  // whether the job store's snapshot held every active job.
  importJobs: Readonly<{
    unitActivity: readonly CatalogIntegrationUnitActivity[];
    completeness: "complete" | "incomplete";
  }>;
  pendingAliasCandidates: CatalogAttentionSourcePage<CatalogAliasCandidateAttentionRow>;
  staleScopeRecords: CatalogAttentionSourcePage<CatalogScopeRecordAttentionRow>;
}>;

export type CatalogAttentionQueueAssembleOptions = Readonly<{
  generatedAt: string;
  // Parked keys among the observed readiness and import-job items, judged at
  // `generatedAt` (dismissed, or deferred with a future re-surface time). Deferred
  // items whose window has elapsed are absent here and age back in.
  parkedObservedItemKeys: ReadonlySet<string>;
  window: CatalogAttentionQueueWindow;
}>;

// Read-model freshness so the surface can label projection lag (AC: lag is
// labeled). `generatedAt` is when the queue was assembled from the read models;
// `oldest/newestObservedAt` bracket the returned items' age.
export type CatalogAttentionQueueFreshness = Readonly<{
  generatedAt: string;
  oldestObservedAt: string | null;
  newestObservedAt: string | null;
}>;

// How one kind's window sits inside its cohort. `nextOffset` walks only the
// counted cohort, so for a lower bound it stops at the end of what was observed
// while `truncated` stays true for the unobserved tail.
export type CatalogAttentionKindCoverage = Readonly<{
  total: number;
  totalKind: CatalogAttentionTotalKind;
  offset: number;
  limit: number;
  returned: number;
  truncated: boolean;
  nextOffset: number | null;
}>;

export type CatalogAttentionQueueCoverage = Readonly<Record<CatalogAttentionItemKind, CatalogAttentionKindCoverage>>;

export type CatalogAttentionQueueReadModel = Readonly<{
  generatedAt: string;
  // Only a complete zero: no eligible work anywhere and every count exact.
  empty: boolean;
  items: readonly CatalogAttentionItem[];
  counts: CatalogAttentionQueueCounts;
  countBasis: CatalogAttentionQueueCountBasis;
  coverage: CatalogAttentionQueueCoverage;
  window: CatalogAttentionQueueWindow;
  freshness: CatalogAttentionQueueFreshness;
}>;

// Where a mounted panel's page links point: the route path and the search it
// keeps (for example Scope Record filters and pager) without the attention
// window parameters. A mount without navigation shows no page links.
export type CatalogAttentionQueueNavigation = Readonly<{
  pathname: string;
  search: string;
}>;

// Deferred availability of the queue on a Catalog home surface. `ready`
// carries a read model the route loader validated in full; `unavailable`
// covers a missing endpoint, a failed request, or a response the loader could
// not trust, so an empty inbox is never confused with an unreadable one.
export type CatalogDeferredAttentionQueueResult =
  | Readonly<{
      status: "ready";
      readModel: CatalogAttentionQueueReadModel;
      navigation?: CatalogAttentionQueueNavigation;
    }>
  | Readonly<{ status: "unavailable" }>;

export type CatalogAttentionQueueWindowQuery = Readonly<{
  kind?: string | null;
  limit?: string | null;
  offset?: string | null;
}>;

// Read a queue window from request parameters. Limit (1..200, default 20) and
// offset (nonnegative, default 0) clamp into range; an unknown kind is refused
// (null) so a caller never pages a different kind than it asked for.
export function parseCatalogAttentionQueueWindow(
  query: CatalogAttentionQueueWindowQuery,
): CatalogAttentionQueueWindow | null {
  const kind = query.kind?.trim() ?? "";
  if (kind && !isCatalogAttentionItemKind(kind)) {
    return null;
  }
  return {
    kind: isCatalogAttentionItemKind(kind) ? kind : null,
    offset: clampedInteger(query.offset, 0, 0, Number.MAX_SAFE_INTEGER),
    limit: clampedInteger(query.limit, CATALOG_ATTENTION_DEFAULT_WINDOW_LIMIT, 1, CATALOG_ATTENTION_MAX_WINDOW_LIMIT),
  };
}

// The API query for a window, omitting defaults so the summary stays `/attention-queue`.
export function catalogAttentionQueueWindowSearch(window: CatalogAttentionQueueWindow): string {
  const params = new URLSearchParams();
  if (window.kind) {
    params.set("kind", window.kind);
  }
  if (window.offset > 0) {
    params.set("offset", String(window.offset));
  }
  if (window.limit !== CATALOG_ATTENTION_DEFAULT_WINDOW_LIMIT) {
    params.set("limit", String(window.limit));
  }
  return params.toString();
}

function clampedInteger(raw: string | null | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === null || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  if (Number.isNaN(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function catalogAttentionKindCoverage(
  input: Readonly<{
    total: number;
    totalKind: CatalogAttentionTotalKind;
    offset: number;
    limit: number;
    returned: number;
  }>,
): CatalogAttentionKindCoverage {
  const end = input.offset + input.returned;
  const moreCounted = end < input.total;
  return {
    ...input,
    truncated: moreCounted || input.totalKind === "lower-bound",
    nextOffset: moreCounted ? end : null,
  };
}

// A lower-bound kind makes the global total and every severity it can produce a
// lower bound too; every other count stays exact.
export function catalogAttentionCountBasis(
  totalKinds: Readonly<Record<CatalogAttentionItemKind, CatalogAttentionTotalKind>>,
): CatalogAttentionQueueCountBasis {
  const boundedKinds = CATALOG_ATTENTION_ITEM_KINDS.filter((kind) => totalKinds[kind] === "lower-bound");
  return {
    total: boundedKinds.length > 0 ? "lower-bound" : "exact",
    bySeverity: catalogAttentionSeverityRecord((severity) =>
      boundedKinds.some((kind) => CATALOG_ATTENTION_KIND_SEVERITIES[kind].includes(severity)) ? "lower-bound" : "exact",
    ),
  };
}

// One kind's contribution: its cohort split by severity, whether that count is
// exact, and the items of its window.
export type CatalogAttentionKindSlice = Readonly<{
  bySeverity: Readonly<Record<CatalogAttentionSeverity, number>>;
  totalKind: CatalogAttentionTotalKind;
  items: readonly CatalogAttentionItem[];
}>;

// The single derivation of counts, coverage, emptiness and freshness from the
// per-kind slices, shared by the assembler and the serialized test fixtures.
export function buildCatalogAttentionQueueReadModel(
  input: Readonly<{
    generatedAt: string;
    window: CatalogAttentionQueueWindow;
    slices: Readonly<Record<CatalogAttentionItemKind, CatalogAttentionKindSlice>>;
  }>,
): CatalogAttentionQueueReadModel {
  const coverage = catalogAttentionKindRecord((kind) => {
    const slice = input.slices[kind];
    return catalogAttentionKindCoverage({
      total: CATALOG_ATTENTION_SEVERITIES.reduce((sum, severity) => sum + slice.bySeverity[severity], 0),
      totalKind: slice.totalKind,
      ...catalogAttentionKindWindow(input.window, kind),
      returned: slice.items.length,
    });
  });
  const byKind = catalogAttentionKindRecord((kind) => coverage[kind].total);
  const counts: CatalogAttentionQueueCounts = {
    total: CATALOG_ATTENTION_ITEM_KINDS.reduce((sum, kind) => sum + byKind[kind], 0),
    bySeverity: catalogAttentionSeverityRecord((severity) =>
      CATALOG_ATTENTION_ITEM_KINDS.reduce((sum, kind) => sum + input.slices[kind].bySeverity[severity], 0),
    ),
    byKind,
  };
  const countBasis = catalogAttentionCountBasis(catalogAttentionKindRecord((kind) => coverage[kind].totalKind));
  const items = sortCatalogAttentionItems(CATALOG_ATTENTION_ITEM_KINDS.flatMap((kind) => input.slices[kind].items));

  return {
    generatedAt: input.generatedAt,
    empty: counts.total === 0 && countBasis.total === "exact",
    items,
    counts,
    countBasis,
    coverage,
    window: input.window,
    freshness: {
      generatedAt: input.generatedAt,
      oldestObservedAt: items.length > 0 ? oldestObservedAt(items) : null,
      newestObservedAt: items.length > 0 ? newestObservedAt(items) : null,
    },
  };
}

export function assembleCatalogAttentionQueue(
  sources: CatalogAttentionQueueSources,
  options: CatalogAttentionQueueAssembleOptions,
): CatalogAttentionQueueReadModel {
  const unparked = (items: readonly CatalogAttentionItem[]) =>
    items.filter((item) => !options.parkedObservedItemKeys.has(item.itemKey));

  return buildCatalogAttentionQueueReadModel({
    generatedAt: options.generatedAt,
    window: options.window,
    slices: {
      "unmapped-scope": databaseSlice(collectUnmappedScopeItems(sources.proposedScopeMappings.rows), {
        warning: sources.proposedScopeMappings.total,
      }),
      "merge-conflict": databaseSlice(collectMergeConflictItems(sources.mergeCandidates.rows), {
        critical: sources.mergeCandidates.conflictTotal,
        warning: sources.mergeCandidates.staleTotal,
      }),
      "provider-health": observedSlice(
        unparked(collectProviderHealthItems(sources.unitReadiness, { generatedAt: options.generatedAt })),
        "exact",
        catalogAttentionKindWindow(options.window, "provider-health"),
      ),
      "import-job": observedSlice(
        unparked(collectImportJobItems(sources.importJobs.unitActivity)),
        sources.importJobs.completeness === "complete" ? "exact" : "lower-bound",
        catalogAttentionKindWindow(options.window, "import-job"),
      ),
      "alias-candidate": databaseSlice(collectAliasCandidateItems(sources.pendingAliasCandidates.rows), {
        info: sources.pendingAliasCandidates.total,
      }),
      "stale-scope-sync": databaseSlice(
        collectStaleScopeSyncItems(sources.staleScopeRecords.rows, {
          now: options.generatedAt,
          // Staleness is applied by the query (`before`); anything the assembler
          // received here already crossed the window, so pass 0 to keep the mapper total.
          stalenessThresholdMs: 0,
        }),
        { warning: sources.staleScopeRecords.total },
      ),
    },
  });
}

// A database source already counted its cohort and read only the window.
function databaseSlice(
  items: readonly CatalogAttentionItem[],
  bySeverity: Partial<Record<CatalogAttentionSeverity, number>>,
): CatalogAttentionKindSlice {
  return {
    bySeverity: catalogAttentionSeverityRecord((severity) => bySeverity[severity] ?? 0),
    totalKind: "exact",
    items,
  };
}

// An observed source is counted in full after parking, then windowed in queue order.
function observedSlice(
  items: readonly CatalogAttentionItem[],
  totalKind: CatalogAttentionTotalKind,
  window: Readonly<{ offset: number; limit: number }>,
): CatalogAttentionKindSlice {
  const ordered = sortCatalogAttentionItems(items);
  return {
    bySeverity: catalogAttentionSeverityRecord(
      (severity) => ordered.filter((item) => item.severity === severity).length,
    ),
    totalKind,
    items: ordered.slice(window.offset, window.offset + window.limit),
  };
}

function oldestObservedAt(items: readonly CatalogAttentionItem[]): string {
  return items.reduce(
    (oldest, item) => (item.observedAt.localeCompare(oldest) < 0 ? item.observedAt : oldest),
    items[0]!.observedAt,
  );
}

function newestObservedAt(items: readonly CatalogAttentionItem[]): string {
  return items.reduce(
    (newest, item) => (item.observedAt.localeCompare(newest) > 0 ? item.observedAt : newest),
    items[0]!.observedAt,
  );
}
