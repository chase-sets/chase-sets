import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { composeRelevanceCandidates, type RelevanceCandidate } from "../domain/relevance-evaluation";
import type { QueryEmbeddingCache } from "../domain/query-embedding-cache";
import { foldSearchDiacritics } from "../domain/normalization";
import type { DiscoveryEmbeddingProvider } from "../integrations/voyage-embedding-provider";
import { parseStructuredNaturalKeyQuery } from "../domain/structured-natural-key-query";
import {
  searchDiscoveryItems,
  searchDiscoveryItemsByNaturalKey,
  searchDiscoverySemanticItems,
  hydrateDiscoverySearchItemMarketSummaries,
  type DiscoverySearchItemRow,
  type DiscoverySearchParams,
  type DiscoverySemanticSearchItem,
  type ListResult,
} from "./queries";

export const DISCOVERY_RESCUE_THRESHOLD = 3;
export const DISCOVERY_SEMANTIC_TOP_K = 24;
export const DISCOVERY_HYBRID_CANDIDATE_WINDOW = 200;

export type DiscoveryRetrievalMode = "lexical" | "rescue" | "hybrid" | "structured";
export type DiscoverySearchResult = ListResult<DiscoverySearchItemRow> &
  Readonly<{
    retrievalMode: DiscoveryRetrievalMode;
    lexicalCount: number | null;
  }>;

type SearchLexical = typeof searchDiscoveryItems;
type SearchSemantic = typeof searchDiscoverySemanticItems;
type SearchNaturalKey = typeof searchDiscoveryItemsByNaturalKey;
type HydrateItems = typeof hydrateDiscoverySearchItemMarketSummaries;

export type DiscoveryHybridRetrievalDependencies = Readonly<{
  db: PgQueryable;
  provider?: DiscoveryEmbeddingProvider;
  cache?: QueryEmbeddingCache;
  rescueEnabled: boolean;
  hybridEnabled: boolean;
  searchLexical?: SearchLexical;
  searchSemantic?: SearchSemantic;
  searchNaturalKey?: SearchNaturalKey;
  hydrateItems?: HydrateItems;
}>;

export async function retrieveDiscoveryItems(
  dependencies: DiscoveryHybridRetrievalDependencies,
  params: DiscoverySearchParams = {},
): Promise<DiscoverySearchResult> {
  const searchLexical = dependencies.searchLexical ?? searchDiscoveryItems;
  const searchSemantic = dependencies.searchSemantic ?? searchDiscoverySemanticItems;
  const searchNaturalKey = dependencies.searchNaturalKey ?? searchDiscoveryItemsByNaturalKey;
  const query = params.search?.trim() ?? "";

  // Structured set-code + collector-number resolution is tried first, on the
  // first page only (a cursor means the caller is paging an already-chosen
  // retrieval mode). A precise point-lookup miss falls straight through to the
  // existing lexical/hybrid/rescue logic below, so a query that merely looks
  // structured ("Pikachu 4") degrades to ordinary search rather than a dead end.
  if (params.cursor === undefined) {
    const naturalKey = parseStructuredNaturalKeyQuery(query);
    if (naturalKey) {
      const structured = await searchNaturalKey(dependencies.db, naturalKey, params);
      if (structured.items.length > 0) {
        return { ...structured, retrievalMode: "structured", lexicalCount: null };
      }
    }
  }

  const semanticEligible =
    Boolean(dependencies.provider && dependencies.cache && query) &&
    (params.sort === undefined || params.sort === "relevance");
  const hybridCursor = decodeHybridCursor(params.cursor);

  if (semanticEligible && dependencies.hybridEnabled && (params.cursor === undefined || hybridCursor !== null)) {
    try {
      return await retrieveHybridPage(dependencies, params, hybridCursor?.offset ?? 0, searchLexical, searchSemantic);
    } catch {
      return lexicalResult(
        await searchLexical(dependencies.db, {
          ...params,
          cursor: hybridCursor ? undefined : params.cursor,
          offset: hybridCursor?.offset ?? params.offset,
        }),
      );
    }
  }

  const lexical = await searchLexical(dependencies.db, params);
  if (
    !semanticEligible ||
    !dependencies.rescueEnabled ||
    params.cursor !== undefined ||
    lexical.items.length >= DISCOVERY_RESCUE_THRESHOLD
  ) {
    return lexicalResult(lexical);
  }

  try {
    const queryEmbedding = await loadQueryEmbedding(dependencies, query);
    const semantic = await searchSemantic(dependencies.db, params, queryEmbedding, {
      limit: DISCOVERY_SEMANTIC_TOP_K + lexical.items.length,
    });
    const lexicalIds = new Set(lexical.items.map((item) => item.catalog_item_id));
    const additions = semantic
      .map((candidate) => candidate.item)
      .filter((item) => !lexicalIds.has(item.catalog_item_id))
      .slice(0, DISCOVERY_SEMANTIC_TOP_K);
    if (additions.length === 0) return lexicalResult(lexical);

    return {
      ...lexical,
      items: [...lexical.items, ...additions],
      total: lexical.total,
      nextCursor: null,
      retrievalMode: "rescue",
      lexicalCount: lexical.total,
    };
  } catch {
    return lexicalResult(lexical);
  }
}

async function retrieveHybridPage(
  dependencies: DiscoveryHybridRetrievalDependencies,
  params: DiscoverySearchParams,
  offset: number,
  searchLexical: SearchLexical,
  searchSemantic: SearchSemantic,
): Promise<DiscoverySearchResult> {
  const query = params.search?.trim() ?? "";
  const queryEmbedding = await loadQueryEmbedding(dependencies, query);
  const candidateParams = {
    ...params,
    cursor: undefined,
    offset: undefined,
    limit: DISCOVERY_HYBRID_CANDIDATE_WINDOW,
    includeTotal: offset === 0,
  };
  const [lexical, semantic] = await Promise.all([
    searchLexical(dependencies.db, candidateParams, { loadMarketSummaries: false }),
    searchSemantic(dependencies.db, candidateParams, queryEmbedding, {
      limit: DISCOVERY_HYBRID_CANDIDATE_WINDOW,
      loadMarketSummaries: false,
    }),
  ]);
  const lexicalCandidates = lexical.items.map((item, index) => relevanceCandidate(item, index + 1, null, null, query));
  const semanticCandidates = semantic.map((candidate, index) =>
    relevanceCandidate(candidate.item, null, index + 1, candidate.similarity, query),
  );
  const ranked = composeRelevanceCandidates(
    "hybrid",
    lexicalCandidates,
    semanticCandidates,
    DISCOVERY_HYBRID_CANDIDATE_WINDOW,
  );
  const itemsById = new Map<string, DiscoverySearchItemRow>();
  for (const item of lexical.items) itemsById.set(item.catalog_item_id, item);
  for (const candidate of semantic) itemsById.set(candidate.item.catalog_item_id, candidate.item);
  const limit = searchLimit(params.limit);
  const unhydratedItems = ranked
    .slice(offset, offset + limit)
    .map((candidate) => itemsById.get(candidate.catalogItemId))
    .filter((item): item is DiscoverySearchItemRow => item !== undefined);
  const items = await (dependencies.hydrateItems ?? hydrateDiscoverySearchItemMarketSummaries)(
    dependencies.db,
    unhydratedItems,
  );
  const nextOffset = offset + items.length;

  return {
    items,
    facets: lexical.facets,
    category_counts: lexical.category_counts,
    total: lexical.total,
    nextCursor: nextOffset < ranked.length ? encodeHybridCursor(nextOffset) : null,
    retrievalMode: "hybrid",
    lexicalCount: lexical.total,
  };
}

async function loadQueryEmbedding(
  dependencies: DiscoveryHybridRetrievalDependencies,
  query: string,
): Promise<readonly number[]> {
  const provider = dependencies.provider;
  const cache = dependencies.cache;
  if (!provider || !cache) throw new Error("Discovery semantic retrieval is disabled.");

  return cache.getOrLoad({ model: provider.model, query }, async (normalizedQuery) => {
    const result = await provider.embed([normalizedQuery], "query");
    const embedding = result.vectors[0];
    if (!embedding || result.vectors.length !== 1 || embedding.length !== provider.dimensions) {
      throw new Error("Discovery query embedding provider returned an invalid vector.");
    }
    return embedding;
  });
}

function relevanceCandidate(
  item: DiscoverySearchItemRow,
  lexicalRank: number | null,
  semanticRank: number | null,
  semanticSimilarity: number | null,
  query: string,
): RelevanceCandidate {
  return {
    catalogItemId: item.catalog_item_id,
    title: item.title,
    exactTitleMatch:
      foldSearchDiacritics(item.title.trim()).toLowerCase() === foldSearchDiacritics(query).toLowerCase(),
    lexicalRank,
    semanticRank,
    semanticSimilarity,
  };
}

function lexicalResult(result: ListResult<DiscoverySearchItemRow>): DiscoverySearchResult {
  return { ...result, retrievalMode: "lexical", lexicalCount: result.total };
}

function searchLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit ?? Number.NaN)) return 50;
  return Math.min(200, Math.max(1, Math.trunc(limit as number)));
}

function encodeHybridCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ kind: "hybrid", offset }), "utf8").toString("base64url");
}

function decodeHybridCursor(cursor: string | undefined): Readonly<{ offset: number }> | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    const offset = Number(parsed.offset);
    return parsed.kind === "hybrid" &&
      Number.isInteger(offset) &&
      offset > 0 &&
      offset < DISCOVERY_HYBRID_CANDIDATE_WINDOW
      ? { offset }
      : null;
  } catch {
    return null;
  }
}
