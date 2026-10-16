import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { composeRelevanceCandidates, type RelevanceCandidate } from "../domain/relevance-evaluation";
import type {
  QueryEmbeddingCache,
  QueryEmbeddingWaitObservation,
  QueryEmbeddingLoadObservation,
} from "../domain/query-embedding-cache";
import { foldSearchDiacritics, truncateDiscoverySearchQuery } from "../domain/normalization";
import { classifyProtectedSearchTokens, type ProtectedSearchToken } from "../domain/protected-search-tokens";
import { buildSearchSynonymQueries } from "../domain/search-synonyms";
import { createSearchCorrectionBudget, protectedSearchQuery } from "../domain/spelling-correction";
import { interpretSearchText } from "../domain/search-interpretation";
import type { DiscoverySearchInterpretation } from "../../../support/client-support/contracts";
import type { DiscoveryEmbeddingProvider } from "../integrations/voyage-embedding-provider";
import { parseStructuredNaturalKeyQuery } from "../domain/structured-natural-key-query";
import {
  discoverySearchCursorState,
  searchDiscoveryItems,
  searchDiscoveryCorrectedItems,
  lookupServedSearchSetCodes,
  searchDiscoveryItemsByNaturalKey,
  searchDiscoverySemanticItems,
  hydrateDiscoverySearchItemMarketSummaries,
  loadDiscoverySearchInterpretationVocabulary,
  type DiscoverySearchCursorState,
  type DiscoverySearchItemRow,
  type DiscoverySearchParams,
  type DiscoverySemanticSearchItem,
  type ListResult,
} from "./queries";

export const DISCOVERY_RESCUE_THRESHOLD = 3;
export const DISCOVERY_SEMANTIC_TOP_K = 24;
export const DISCOVERY_HYBRID_CANDIDATE_WINDOW = 200;

export type DiscoveryRetrievalMode = "lexical" | "rescue" | "hybrid" | "structured" | "corrected";
export type DiscoverySearchResult = ListResult<DiscoverySearchItemRow> &
  Readonly<{
    retrievalMode: DiscoveryRetrievalMode;
    lexicalCount: number | null;
    cursorState: DiscoverySearchCursorState;
    interpretation?: DiscoverySearchInterpretation;
  }>;
type DiscoveryRetrievedPage = Omit<DiscoverySearchResult, "cursorState">;

type SearchLexical = typeof searchDiscoveryItems;
type SearchSemantic = typeof searchDiscoverySemanticItems;
type SearchNaturalKey = typeof searchDiscoveryItemsByNaturalKey;
type HydrateItems = typeof hydrateDiscoverySearchItemMarketSummaries;
type CorrectPage = (
  lexical: ListResult<DiscoverySearchItemRow>,
  request: DiscoverySearchParams,
  tokens: readonly ProtectedSearchToken[],
) => Promise<DiscoveryRetrievedPage | null>;

export type DiscoveryHybridRetrievalDependencies = Readonly<{
  db: PgQueryable;
  provider?: DiscoveryEmbeddingProvider;
  cache?: QueryEmbeddingCache;
  rescueEnabled: boolean;
  hybridEnabled: boolean;
  searchLexical?: SearchLexical;
  searchSemantic?: SearchSemantic;
  searchNaturalKey?: SearchNaturalKey;
  searchCorrected?: typeof searchDiscoveryCorrectedItems;
  loadInterpretationVocabulary?: typeof loadDiscoverySearchInterpretationVocabulary;
  hydrateItems?: HydrateItems;
  signal?: AbortSignal;
  onEmbeddingWait?: (observation: QueryEmbeddingWaitObservation) => void;
  onEmbeddingLoad?: (observation: QueryEmbeddingLoadObservation) => void;
}>;

export async function retrieveDiscoveryItems(
  dependencies: DiscoveryHybridRetrievalDependencies,
  params: DiscoverySearchParams = {},
): Promise<DiscoverySearchResult> {
  params = { ...params, search: params.search === undefined ? undefined : truncateDiscoverySearchQuery(params.search) };
  const tokens = await classifyProtectedSearchTokens(params.search ?? "", (codes) =>
    lookupServedSearchSetCodes(dependencies.db, codes),
  );
  const cursorState =
    decodeHybridCursor(params.cursor) && tokens.some((token) => token.protected)
      ? "restarted"
      : classifyDiscoverySearchCursor(dependencies, params);
  // A rejected cursor restarts as a fresh first page in every branch below, including
  // structured resolution, hybrid, and rescue, with full first-page metadata. Its offset
  // goes with it, so the restart can never skip the leading rows it reports as fresh.
  const request =
    cursorState === "cursor"
      ? params
      : cursorState === "restarted"
        ? { ...params, cursor: undefined, offset: undefined, includeTotal: true }
        : { ...params, cursor: undefined };

  return {
    ...(await retrieveDiscoveryPage(dependencies, request, !params.cursor && !params.offset, tokens)),
    cursorState,
  };
}

/**
 * Effective cursor state: hybrid cursors classify first and continue only under enabled
 * hybrid retrieval of an unmarked request; any other cursor must decode for the lexical
 * ordering it continues.
 */
export function classifyDiscoverySearchCursor(
  dependencies: Pick<DiscoveryHybridRetrievalDependencies, "provider" | "cache" | "hybridEnabled">,
  params: DiscoverySearchParams,
): DiscoverySearchCursorState {
  if (!params.cursor) return "fresh";
  if (decodeHybridCursor(params.cursor)) {
    return isSemanticEligible(dependencies, params) && dependencies.hybridEnabled ? "cursor" : "restarted";
  }
  return discoverySearchCursorState(params);
}

async function retrieveDiscoveryPage(
  dependencies: DiscoveryHybridRetrievalDependencies,
  params: DiscoverySearchParams,
  fresh: boolean,
  tokens: readonly ProtectedSearchToken[],
): Promise<DiscoveryRetrievedPage> {
  const lexicalReader = dependencies.searchLexical ?? searchDiscoveryItems;
  const searchSemantic = dependencies.searchSemantic ?? searchDiscoverySemanticItems;
  const searchNaturalKey = dependencies.searchNaturalKey ?? searchDiscoveryItemsByNaturalKey;
  const query = truncateDiscoverySearchQuery(params.search?.trim() ?? "");

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

  const protectedQuery = protectedSearchQuery(tokens);
  const searchLexical = await protectedLexicalReader(lexicalReader, query, tokens);
  const semanticEligible = !protectedQuery && isSemanticEligible(dependencies, params);
  const correctionEligible = fresh && query.length > 0 && (params.sort === undefined || params.sort === "relevance");
  // Every correction this invocation attempts, interpreted or original-text, spends one budget.
  const correctionBudget = createSearchCorrectionBudget();
  const correct: CorrectPage = async (lexical, request, requestTokens) => {
    if (!correctionEligible || lexical.items.length > 0) return null;
    const corrected = await (dependencies.searchCorrected ?? searchDiscoveryCorrectedItems)(
      dependencies.db,
      request,
      requestTokens,
      correctionBudget,
    );
    if (!corrected?.items.length) return null;
    return { ...corrected, retrievalMode: "corrected", lexicalCount: 0 };
  };
  // A fresh relevance zero is interpreted once, before original-text correction and never after
  // it. A marked (already interpreted) request is not, nor a one-word query: consuming its only
  // word would leave no remainder.
  const recover = async (lexical: ListResult<DiscoverySearchItemRow>) =>
    (correctionEligible && !params.interpreted && lexical.items.length === 0 && tokens.length > 1
      ? await retrieveInterpretedPage(dependencies, params, tokens, lexicalReader, correct)
      : null) ?? (await correct(lexical, params, tokens));
  const hybridCursor = decodeHybridCursor(params.cursor);

  if (semanticEligible && dependencies.hybridEnabled && (params.cursor === undefined || hybridCursor !== null)) {
    const initial =
      correctionEligible && !hybridCursor
        ? await searchLexical(
            dependencies.db,
            {
              ...params,
              cursor: undefined,
              offset: undefined,
              limit: DISCOVERY_HYBRID_CANDIDATE_WINDOW,
              includeTotal: true,
            },
            { loadMarketSummaries: false },
          )
        : undefined;
    const recovered = initial ? await recover(initial) : null;
    if (recovered) return recovered;
    try {
      return await retrieveHybridPage(
        dependencies,
        params,
        hybridCursor?.offset ?? 0,
        searchLexical,
        searchSemantic,
        initial,
      );
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
  const recovered = await recover(lexical);
  if (recovered) return recovered;
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

/**
 * The one interpreted evaluation: lexical retrieval of the remaining words under the explicit
 * plus newly inferred filters, then correction under the shared budget. It never loads an
 * embedding, so semantic rescue never sees interpreted text. Zero rows or an empty remainder
 * discard the interpretation, and the caller recovers the original text instead.
 */
async function retrieveInterpretedPage(
  dependencies: DiscoveryHybridRetrievalDependencies,
  params: DiscoverySearchParams,
  tokens: readonly ProtectedSearchToken[],
  lexicalReader: SearchLexical,
  correct: CorrectPage,
): Promise<DiscoveryRetrievedPage | null> {
  const vocabulary = await (dependencies.loadInterpretationVocabulary ?? loadDiscoverySearchInterpretationVocabulary)(
    dependencies.db,
  );
  const interpretation = interpretSearchText(tokens, vocabulary, params);
  if (!interpretation?.remainingQuery) return null;
  const { remainingQuery, applied } = interpretation;
  const request: DiscoverySearchParams = {
    ...params,
    search: remainingQuery,
    language: params.language ?? interpretation.language ?? undefined,
    dimensionFilters: [...(params.dimensionFilters ?? []), ...interpretation.dimensionFilters],
  };
  const remainingTokens = await classifyProtectedSearchTokens(remainingQuery, (codes) =>
    lookupServedSearchSetCodes(dependencies.db, codes),
  );
  const lexical = await (
    await protectedLexicalReader(lexicalReader, remainingQuery, remainingTokens)
  )(dependencies.db, request);
  // Interpreted rows answer the remaining query, so they never page: a cursor would continue
  // a different Result Set than the one the caller requested.
  const page =
    lexical.items.length > 0
      ? { ...lexicalResult(lexical), nextCursor: null }
      : await correct(lexical, request, remainingTokens);
  return page && { ...page, interpretation: { remainingQuery, applied } };
}

async function protectedLexicalReader(
  lexicalReader: SearchLexical,
  query: string,
  tokens: readonly ProtectedSearchToken[],
): Promise<SearchLexical> {
  const protectedQuery = protectedSearchQuery(tokens);
  if (!protectedQuery) return lexicalReader;
  const searchQueries = await buildSearchSynonymQueries(query, async () => new Set(), false, tokens);
  return (db, request, options) => lexicalReader(db, request, { ...options, searchQueries, protectedQuery });
}

async function retrieveHybridPage(
  dependencies: DiscoveryHybridRetrievalDependencies,
  params: DiscoverySearchParams,
  offset: number,
  searchLexical: SearchLexical,
  searchSemantic: SearchSemantic,
  initial?: ListResult<DiscoverySearchItemRow>,
): Promise<DiscoveryRetrievedPage> {
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
    initial ?? searchLexical(dependencies.db, candidateParams, { loadMarketSummaries: false }),
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
    params,
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

  return cache.getOrLoad(
    {
      model: provider.model,
      query,
      signal: dependencies.signal,
      onWait: dependencies.onEmbeddingWait,
      onLoad: dependencies.onEmbeddingLoad,
    },
    async (normalizedQuery, options) => {
      const result = await provider.embed([normalizedQuery], "query", { ...options, maxAttempts: 1 });
      const embedding = result.vectors[0];
      if (
        !embedding ||
        result.vectors.length !== 1 ||
        embedding.length !== provider.dimensions ||
        embedding.some((value) => !Number.isFinite(value)) ||
        !embedding.some((value) => value !== 0)
      ) {
        throw new Error("Discovery query embedding provider returned an invalid vector.");
      }
      return embedding;
    },
  );
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

function lexicalResult(result: ListResult<DiscoverySearchItemRow>): DiscoveryRetrievedPage {
  return { ...result, retrievalMode: "lexical", lexicalCount: result.total };
}

/**
 * A marked (already interpreted) request continues an interpreted result, which is lexical or
 * corrected only, so it never adds rescue or hybrid rows and a hybrid cursor restarts it.
 */
function isSemanticEligible(
  dependencies: Pick<DiscoveryHybridRetrievalDependencies, "provider" | "cache">,
  params: DiscoverySearchParams,
): boolean {
  return (
    Boolean(dependencies.provider && dependencies.cache && params.search?.trim()) &&
    !params.interpreted &&
    (params.sort === undefined || params.sort === "relevance")
  );
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
