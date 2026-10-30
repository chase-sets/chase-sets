import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { DiscoveryRuntimeDeps } from "../../../support/runtime-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type {
  QueryEmbeddingCache,
  QueryEmbeddingWaitObservation,
  QueryEmbeddingLoadObservation,
} from "../domain/query-embedding-cache";
import type { DiscoveryEmbeddingProvider } from "../integrations/voyage-embedding-provider";
import { createHash } from "node:crypto";
import { normalizeSimpleSearchText } from "../domain/normalization";
import {
  classifyDiscoverySearchCursor,
  retrieveDiscoveryItems,
  type DiscoveryHybridRetrievalDependencies,
  type DiscoverySearchResult,
} from "../read-model/hybrid-retrieval";
import {
  previewBulkAddSearchResults,
  normalizeCategorySet,
  type DiscoveryBulkCartPreview,
  type DiscoverySearchCursorState,
  type DiscoverySearchParams,
} from "../read-model/queries";
import { buildDiscoverySearchItemProjectionHandlers, rebuildDiscoverySearchIndex } from "../read-model/projection";
import { appendSearchSessionStarted } from "../../../support/request-support/lifecycle-events";
import type { DiscoverySearchSuggestion } from "../../../support/client-support/contracts";
import { suggestDiscoveryItems } from "../read-model/suggestions";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { AccountId, SessionId } from "@chase-sets/primitives/typed-ids";

export type DiscoverySearchQuerySignal = Readonly<{
  queryHash: string;
  resultSetKey: string;
  filterState: string;
  sortOrder: string;
  cursorState: DiscoverySearchCursorState;
  resultCount: number | null;
  total: number | null;
  zeroResults: boolean | null;
  lexicalZero: boolean | null;
  interpretation: "applied" | "not-applied" | "unknown";
  retrievalMode: DiscoverySearchResult["retrievalMode"] | null;
  outcome: "success" | "failure";
  normalizationDurationMs: number;
  retrievalDurationMs: number;
  totalDurationMs: number;
  queryEmbeddingOutcome: QueryEmbeddingWaitObservation["outcome"];
  queryEmbeddingWaiterDurationMs: number;
}>;

export type DiscoverySearchInvocationResult = DiscoverySearchResult &
  Readonly<{
    queryHash: string;
    resultSetKey: string;
  }>;

export type DiscoveryItemSearchServices = Readonly<{
  suggestItems: (query: string, limit?: number) => Promise<DiscoverySearchSuggestion[]>;
  searchItems: (
    params?: DiscoverySearchParams,
    options?: Readonly<{ signal?: AbortSignal; correlationId?: string }>,
  ) => Promise<DiscoverySearchInvocationResult>;
  previewBulkAdd: (params?: DiscoverySearchParams) => Promise<DiscoveryBulkCartPreview>;
  rebuildSearchIndex: (db: PgQueryable) => Promise<void>;
  publishSearchOutcome?: (
    input: Readonly<{ accountId: string; sessionId: string; context: EventStoreContext }>,
  ) => Promise<void>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export type DiscoverySearchRetrievalOptions = Readonly<{
  provider?: DiscoveryEmbeddingProvider;
  cache?: QueryEmbeddingCache;
  rescueEnabled?: boolean;
  hybridEnabled?: boolean;
  recordSearchQuery?: (signal: DiscoverySearchQuerySignal) => void;
  recordQueryEmbeddingLoad?: (observation: QueryEmbeddingLoadObservation) => void;
  recordSearchRetrievalFailure?: (event: Readonly<{ correlationId?: string; error: unknown }>) => void;
}>;

export function createDiscoveryItemSearchRuntime(
  deps: DiscoveryRuntimeDeps,
  retrieval: DiscoverySearchRetrievalOptions = {},
): DiscoveryItemSearchServices {
  return {
    suggestItems: (query, limit) => suggestDiscoveryItems(deps.db, query, limit),
    searchItems: async (params = {}, options = {}) => {
      const startedAt = performance.now();
      const normalizedSearch = normalizeSimpleSearchText(params.search ?? "")
        .trim()
        .toLowerCase();
      const queryHash = sha256(normalizedSearch);
      const resultSetKey = sha256(JSON.stringify(searchIdentity(params, normalizedSearch)));
      const normalizationDurationMs = performance.now() - startedAt;
      const retrievalStartedAt = performance.now();
      let result: DiscoverySearchResult | undefined;
      let lexicalZero: boolean | null = null;
      let embeddingWait: QueryEmbeddingWaitObservation = { outcome: "not-attempted", waiterDurationMs: 0 };
      const retrievalDependencies: DiscoveryHybridRetrievalDependencies = {
        db: deps.db,
        provider: retrieval.provider,
        cache: retrieval.cache,
        rescueEnabled: retrieval.rescueEnabled ?? false,
        hybridEnabled: retrieval.hybridEnabled ?? false,
        signal: options.signal,
        onLexicalObservation: (observation) => {
          lexicalZero = observation;
        },
        onEmbeddingWait: (observation) => {
          embeddingWait = observation;
        },
        onEmbeddingLoad: retrieval.recordQueryEmbeddingLoad,
      };

      try {
        result = await retrieveDiscoveryItems(retrievalDependencies, params);
        return { ...result, queryHash, resultSetKey };
      } catch (error) {
        try {
          retrieval.recordSearchRetrievalFailure?.({
            correlationId: options.correlationId,
            error,
          });
        } catch {
          // Failure observability must never replace the original retrieval error.
        }
        throw error;
      } finally {
        try {
          retrieval.recordSearchQuery?.({
            queryHash,
            resultSetKey,
            filterState: filterState(params),
            sortOrder: observedSortOrder(params.sort),
            // Effective state: a failed retrieval still reports how its cursor classified.
            cursorState: result?.cursorState ?? classifyDiscoverySearchCursor(retrievalDependencies, params),
            resultCount: result?.items.length ?? null,
            total: result?.total ?? null,
            zeroResults: result ? result.items.length === 0 : null,
            lexicalZero,
            interpretation: result ? (result.interpretation ? "applied" : "not-applied") : "unknown",
            retrievalMode: result?.retrievalMode ?? null,
            outcome: result ? "success" : "failure",
            normalizationDurationMs,
            retrievalDurationMs: performance.now() - retrievalStartedAt,
            totalDurationMs: performance.now() - startedAt,
            queryEmbeddingOutcome: embeddingWait.outcome,
            queryEmbeddingWaiterDurationMs: embeddingWait.waiterDurationMs,
          });
        } catch {
          // Telemetry must never become a search dependency.
        }
      }
    },
    previewBulkAdd: (params = {}) => previewBulkAddSearchResults(deps.db, params),
    rebuildSearchIndex: (db) => rebuildDiscoverySearchIndex(db),
    publishSearchOutcome: async ({ accountId, sessionId, context }) => {
      await appendSearchSessionStarted(deps.eventStore, context, {
        accountId: accountId as AccountId,
        sessionId: sessionId as SessionId,
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
  const categories = normalizeCategorySet(params.categories);
  return {
    search: normalizedSearch,
    category: categories.length > 0 ? null : (params.category ?? null),
    ...(categories.length > 0 ? { categories } : {}),
    tag: params.tag ?? null,
    blueprintId: params.blueprintId ?? null,
    language: params.language ?? null,
    status: params.status ?? null,
    marketActivity: params.marketActivity ?? null,
    priceMin: params.priceMin ?? null,
    priceMax: params.priceMax ?? null,
    ...(params.priceCurrency !== undefined ? { priceCurrency: params.priceCurrency } : {}),
    inStock: params.inStock ?? false,
    fieldFilters: params.fieldFilters ?? [],
    referenceFilters: params.referenceFilters ?? [],
    dimensionFilters: params.dimensionFilters ?? [],
    sort: params.sort ?? "relevance",
    // A marked request has its own retrieval policy, so it is a different Result Set.
    ...(params.interpreted ? { interpreted: true } : {}),
  };
}

function filterState(params: DiscoverySearchParams): string {
  const hasCategories = normalizeCategorySet(params.categories).length > 0;
  const filters = [
    hasCategories ? "category" : params.category && "category",
    params.tag && "tag",
    params.blueprintId && "blueprint",
    params.language && "language",
    params.status && "status",
    params.marketActivity && "market-activity",
    params.priceMin && "price-min",
    params.priceMax && "price-max",
    params.priceCurrency !== undefined && "price-currency",
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
