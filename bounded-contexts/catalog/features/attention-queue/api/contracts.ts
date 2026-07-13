// ---------------------------------------------------------------------------
// Catalog attention queue — read-model contract + assembler
//
// The serializable read model the daily home surface renders, plus the pure
// assembler that merges the six source datasets into one severity-ordered queue.
// The assembler is deterministic: given the same source rows and dismissal set
// it always produces the same queue, so counts computed here can never disagree
// with the rendered list.
// ---------------------------------------------------------------------------

import type { CatalogAliasCandidateRow } from "../../alias-equivalence/read-model/queries";
import type { ProviderScopeMappingRow } from "../../provider-scope-mapping/read-model/queries";
import type { CatalogScopeRecordRow } from "../../scope-registry/read-model/queries";
import type { CatalogMergeCandidateListRow } from "../../source-observations/read-model/queries";
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
  sortCatalogAttentionItems,
  summarizeCatalogAttentionItems,
  type CatalogAttentionItem,
  type CatalogAttentionQueueCounts,
} from "../read-model/attention-item";

// The raw source datasets the assembler folds into the queue. The runtime fetches
// each with the owning slice's read query; tests supply fixtures directly.
export type CatalogAttentionQueueSources = Readonly<{
  proposedScopeMappings: readonly ProviderScopeMappingRow[];
  mergeCandidates: readonly CatalogMergeCandidateListRow[];
  unitReadiness: readonly CatalogIntegrationControlPlaneUnitReadiness[];
  unitActivity: readonly CatalogIntegrationUnitActivity[];
  pendingAliasCandidates: readonly CatalogAliasCandidateRow[];
  staleScopeRecords: readonly CatalogScopeRecordRow[];
}>;

export type CatalogAttentionQueueAssembleOptions = Readonly<{
  generatedAt: string;
  // Item keys currently parked (dismissed, or deferred with a future re-surface
  // time). Deferred items whose window has elapsed are absent here and age back in.
  dismissedItemKeys: ReadonlySet<string>;
}>;

// Read-model freshness so the surface can label projection lag (AC: lag is
// labeled). `generatedAt` is when the queue was assembled from the read models;
// `oldest/newestObservedAt` bracket the underlying work's age.
export type CatalogAttentionQueueFreshness = Readonly<{
  generatedAt: string;
  oldestObservedAt: string | null;
  newestObservedAt: string | null;
}>;

export type CatalogAttentionQueueReadModel = Readonly<{
  generatedAt: string;
  empty: boolean;
  items: readonly CatalogAttentionItem[];
  counts: CatalogAttentionQueueCounts;
  freshness: CatalogAttentionQueueFreshness;
}>;

export function assembleCatalogAttentionQueue(
  sources: CatalogAttentionQueueSources,
  options: CatalogAttentionQueueAssembleOptions,
): CatalogAttentionQueueReadModel {
  const collected: CatalogAttentionItem[] = [
    ...collectUnmappedScopeItems(sources.proposedScopeMappings),
    ...collectMergeConflictItems(sources.mergeCandidates),
    ...collectProviderHealthItems(sources.unitReadiness, { generatedAt: options.generatedAt }),
    ...collectImportJobItems(sources.unitActivity),
    ...collectAliasCandidateItems(sources.pendingAliasCandidates),
    ...collectStaleScopeSyncItems(sources.staleScopeRecords, {
      now: options.generatedAt,
      // Staleness is applied by the query (`before`); anything the assembler
      // received here already crossed the window, so pass 0 to keep the mapper total.
      stalenessThresholdMs: 0,
    }),
  ];

  const visible = collected.filter((item) => !options.dismissedItemKeys.has(item.itemKey));
  const items = sortCatalogAttentionItems(visible);
  const counts = summarizeCatalogAttentionItems(items);

  return {
    generatedAt: options.generatedAt,
    empty: items.length === 0,
    items,
    counts,
    freshness: {
      generatedAt: options.generatedAt,
      oldestObservedAt: items.at(-1) ? oldestObservedAt(items) : null,
      newestObservedAt: items.length > 0 ? newestObservedAt(items) : null,
    },
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
