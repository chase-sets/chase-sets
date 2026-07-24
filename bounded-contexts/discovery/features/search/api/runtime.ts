import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { DiscoveryRuntimeDeps } from "../../../support/runtime-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { QueryEmbeddingCache } from "../domain/query-embedding-cache";
import type { DiscoveryEmbeddingProvider } from "../integrations/voyage-embedding-provider";
import { createHash } from "node:crypto";
import { normalizeSimpleSearchText } from "../domain/normalization";
import { retrieveDiscoveryItems, type DiscoverySearchResult } from "../read-model/hybrid-retrieval";
import {
  previewBulkAddSearchResults,
  type DiscoveryBulkCartPreview,
  type DiscoverySearchParams,
} from "../read-model/queries";
import { buildDiscoverySearchItemProjectionHandlers, rebuildDiscoverySearchIndex } from "../read-model/projection";
import { publishDiscoveryCsatOutcomeFact } from "../../../support/request-support/csat-outcome-facts";
import type { DiscoverySearchSuggestion } from "../../../support/client-support/contracts";
import { suggestDiscoveryItems } from "../read-model/suggestions";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type DiscoverySearchQuerySignal = Readonly<{
  queryHash: string;
  resultSetKey: string;
  filterState: string;
  sortOrder: string;
  cursorState: "cursor" | "fresh";
  resultCount: number | null;
  total: number | null;
  zeroResults: boolean | null;
  retrievalMode: DiscoverySearchResult["retrievalMode"] | null;
  outcome: "success" | "failure";
  normalizationDurationMs: number;
  retrievalDurationMs: number;
  totalDurationMs: number;
}>;

export type DiscoverySearchInvocationResult = DiscoverySearchResult &
  Readonly<{
    queryHash: string;
    resultSetKey: string;
  }>;

export type DiscoveryItemSearchServices = Readonly<{
  suggestItems: (query: string, limit?: number) => Promise<DiscoverySearchSuggestion[]>;
  searchItems: (params?: DiscoverySearchParams) => Promise<DiscoverySearchInvocationResult>;
  previewBulkAdd: (params?: DiscoverySearchParams) => Promise<DiscoveryBulkCartPreview>;
  rebuildSearchIndex: (db: PgQueryable) => Promise<void>;
  publishSearchOutcome?: (
    input: Readonly<{ accountId: string; sessionId: string; context: EventStoreContext }>,
  ) => Promise<void>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createDiscoveryItemSearchRuntime(
  deps: DiscoveryRuntimeDeps,
  retrieval: Readonly<{
    provider?: DiscoveryEmbeddingProvider;
    cache?: QueryEmbeddingCache;
    rescueEnabled?: boolean;
    hybridEnabled?: boolean;
    recordSearchQuery?: (signal: DiscoverySearchQuerySignal) => void;
  }> = {},
): DiscoveryItemSearchServices {
  return {
    suggestItems: (query, limit) => suggestDiscoveryItems(deps.db, query, limit),
    searchItems: async (params = {}) => {
      const startedAt = performance.now();
      const normalizedSearch = normalizeSimpleSearchText(params.search ?? "")
        .trim()
        .toLowerCase();
      const queryHash = sha256(normalizedSearch);
      const resultSetKey = sha256(JSON.stringify(searchIdentity(params, normalizedSearch)));
      const normalizationDurationMs = performance.now() - startedAt;
      const retrievalStartedAt = performance.now();
      let result: DiscoverySearchResult | undefined;

      try {
        result = await retrieveDiscoveryItems(
          {
            db: deps.db,
            provider: retrieval.provider,
            cache: retrieval.cache,
            rescueEnabled: retrieval.rescueEnabled ?? false,
            hybridEnabled: retrieval.hybridEnabled ?? false,
          },
          params,
        );
        return { ...result, queryHash, resultSetKey };
      } finally {
        try {
          retrieval.recordSearchQuery?.({
            queryHash,
            resultSetKey,
            filterState: filterState(params),
            sortOrder: observedSortOrder(params.sort),
            cursorState: params.cursor === undefined ? "fresh" : "cursor",
            resultCount: result?.items.length ?? null,
            total: result?.total ?? null,
            zeroResults: result ? result.items.length === 0 : null,
            retrievalMode: result?.retrievalMode ?? null,
            outcome: result ? "success" : "failure",
            normalizationDurationMs,
            retrievalDurationMs: performance.now() - retrievalStartedAt,
            totalDurationMs: performance.now() - startedAt,
          });
        } catch {
          // Telemetry must never become a search dependency.
        }
      }
    },
    previewBulkAdd: (params = {}) => previewBulkAddSearchResults(deps.db, params),
    rebuildSearchIndex: (db) => rebuildDiscoverySearchIndex(db),
    publishSearchOutcome: async ({ accountId, sessionId, context }) => {
      await publishDiscoveryCsatOutcomeFact(deps.eventStore, context, {
        outcomeCode: "discovery.search-completed",
        subjectAccountId: accountId,
        subjectKind: "account",
        subject: { entityType: "session", entityId: sessionId },
        idempotencyKey: `discovery:search-session:${sessionId}`,
      });
    },
    projectors: [
      createProjectionHandlerSet({
        projectionName: "discovery-search-item-projection",
        handlers: buildDiscoverySearchItemProjectionHandlers(deps.db),
      }),
    ],
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function searchIdentity(params: DiscoverySearchParams, normalizedSearch: string) {
  return {
    search: normalizedSearch,
    category: params.category ?? null,
    tag: params.tag ?? null,
    blueprintId: params.blueprintId ?? null,
    language: params.language ?? null,
    status: params.status ?? null,
    marketActivity: params.marketActivity ?? null,
    priceMin: params.priceMin ?? null,
    priceMax: params.priceMax ?? null,
    inStock: params.inStock ?? false,
    fieldFilters: params.fieldFilters ?? [],
    referenceFilters: params.referenceFilters ?? [],
    dimensionFilters: params.dimensionFilters ?? [],
    sort: params.sort ?? "relevance",
  };
}

function filterState(params: DiscoverySearchParams): string {
  const filters = [
    params.category && "category",
    params.tag && "tag",
    params.blueprintId && "blueprint",
    params.language && "language",
    params.status && "status",
    params.marketActivity && "market-activity",
    params.priceMin && "price-min",
    params.priceMax && "price-max",
    params.inStock && "in-stock",
    params.fieldFilters?.length && "field",
    params.referenceFilters?.length && "reference",
    params.dimensionFilters?.length && "dimension",
  ].filter(Boolean);

  return filters.length > 0 ? filters.join(",") : "none";
}

function observedSortOrder(sort: string | undefined): string {
  return ["relevance", "title_asc", "title_desc", "newest", "price_asc", "price_desc"].includes(sort ?? "relevance")
    ? (sort ?? "relevance")
    : "other";
}
