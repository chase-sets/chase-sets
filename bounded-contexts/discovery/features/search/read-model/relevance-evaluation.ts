import { createHash } from "node:crypto";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { buildSimpleSearchQuery, foldSearchDiacritics } from "../domain/normalization";
import {
  buildRelevanceReport,
  composeRelevanceCandidates,
  evaluateGoldenQuery,
  RELEVANCE_MODES,
  summarizeRelevanceMode,
  type GoldenQuery,
  type GoldenQueryResult,
  type RelevanceCandidate,
  type RelevanceMode,
  type RelevanceReport,
} from "../domain/relevance-evaluation";

const SEMANTIC_MINIMUM_SIMILARITY = 0.52;
const CANDIDATE_LIMIT = 50;

export type RelevanceCatalogFixtureItem = Readonly<{
  catalogItemId: string;
  languageCode: string;
  title: string;
  subtitle: string;
  description: string;
  aliases: readonly string[];
  categories: readonly string[];
  tags: readonly string[];
}>;

export type RelevanceEmbeddingFixture = Readonly<{
  version: 1;
  model: string;
  dimensions: number;
  sourceHash: string;
  documents: Readonly<Record<string, readonly (readonly [number, number])[]>>;
  queries: Readonly<Record<string, readonly (readonly [number, number])[]>>;
}>;

export async function runDiscoveryRelevanceEvaluation(
  db: PgQueryable,
  input: Readonly<{
    catalogItems: readonly RelevanceCatalogFixtureItem[];
    goldenQueries: readonly GoldenQuery[];
    embeddingFixture: RelevanceEmbeddingFixture;
    generatedAt: string;
  }>,
): Promise<RelevanceReport> {
  validateEvaluationFixture(input.catalogItems, input.goldenQueries, input.embeddingFixture);
  const documentEmbeddings = Object.fromEntries(
    Object.entries(input.embeddingFixture.documents).map(([itemId, components]) => [
      itemId,
      expandSparseEmbedding(components, input.embeddingFixture.dimensions),
    ]),
  );
  await seedDiscoveryRelevanceCatalog(db, input.catalogItems, documentEmbeddings, input.embeddingFixture.model);

  const caseResults = Object.fromEntries(RELEVANCE_MODES.map((mode) => [mode, [] as GoldenQueryResult[]])) as Record<
    RelevanceMode,
    GoldenQueryResult[]
  >;
  for (const goldenQuery of input.goldenQueries) {
    const queryComponents = input.embeddingFixture.queries[goldenQuery.id];
    if (!queryComponents) throw new Error(`Missing query embedding for '${goldenQuery.id}'.`);
    const candidates = await retrieveDiscoveryRelevanceCandidates(db, {
      query: goldenQuery.query,
      queryEmbedding: expandSparseEmbedding(queryComponents, input.embeddingFixture.dimensions),
    });
    for (const mode of RELEVANCE_MODES) {
      const ranked = composeRelevanceCandidates(mode, candidates.lexical, candidates.semantic);
      caseResults[mode].push(evaluateGoldenQuery(goldenQuery, ranked));
    }
  }
  const modes = Object.fromEntries(
    RELEVANCE_MODES.map((mode) => [mode, summarizeRelevanceMode(mode, caseResults[mode])]),
  ) as Record<RelevanceMode, ReturnType<typeof summarizeRelevanceMode>>;
  return buildRelevanceReport({
    generatedAt: input.generatedAt,
    sourceHash: input.embeddingFixture.sourceHash,
    embeddingModel: input.embeddingFixture.model,
    dimensions: input.embeddingFixture.dimensions,
    catalogItemCount: input.catalogItems.length,
    goldenQueries: input.goldenQueries,
    modes,
  });
}

export async function seedDiscoveryRelevanceCatalog(
  db: PgQueryable,
  items: readonly RelevanceCatalogFixtureItem[],
  documentEmbeddings: Readonly<Record<string, readonly number[]>>,
  embeddingModel: string,
): Promise<void> {
  await db.query("DELETE FROM discovery_search_items");
  for (const item of items) {
    const embedding = documentEmbeddings[item.catalogItemId];
    if (!embedding || embedding.length !== 1_024) {
      throw new Error(`Missing 1024-dimensional relevance embedding for '${item.catalogItemId}'.`);
    }
    const searchableText = [
      item.title,
      item.subtitle,
      ...item.aliases,
      ...item.categories,
      ...item.tags,
      item.description,
    ].join(" ");
    await db.query(
      `INSERT INTO discovery_search_items (
         catalog_item_id, slug, language_code, title_i18n, title, subtitle_i18n, subtitle,
         description_i18n, description, status, category_names, tags, field_values_text,
         search_text, search_text_simple, search_embedding, embedding_model, embedded_text_hash, embedding_updated_at
       ) VALUES (
         $1, $2, $3, $4::jsonb, $5, $6::jsonb, $7, $8::jsonb, $9, 'active', $10::jsonb, $11::jsonb, $12,
         setweight(to_tsvector('english', $18), 'A') ||
           setweight(to_tsvector('english', $19), 'B') ||
           setweight(to_tsvector('english', $13), 'C'),
         to_tsvector('simple', $14), $15::halfvec(1024), $16, $17, now()
       )`,
      [
        item.catalogItemId,
        item.catalogItemId,
        item.languageCode,
        localized(item.languageCode, item.title),
        item.title,
        localized(item.languageCode, item.subtitle),
        item.subtitle,
        localized(item.languageCode, item.description),
        item.description,
        JSON.stringify(item.categories),
        JSON.stringify(item.tags),
        item.tags.join(" "),
        foldSearchDiacritics(
          [item.subtitle, ...item.aliases, ...item.categories, ...item.tags, item.description].join(" "),
        ),
        buildSimpleSearchQuery(searchableText),
        halfVectorLiteral(embedding),
        embeddingModel,
        item.catalogItemId,
        foldSearchDiacritics(item.title),
        foldSearchDiacritics(item.subtitle),
      ],
    );
  }
}

export async function retrieveDiscoveryRelevanceCandidates(
  db: PgQueryable,
  input: Readonly<{ query: string; queryEmbedding: readonly number[] }>,
): Promise<Readonly<{ lexical: RelevanceCandidate[]; semantic: RelevanceCandidate[] }>> {
  if (input.queryEmbedding.length !== 1_024) throw new Error("Relevance query embedding must contain 1024 values.");
  const englishQuery = foldSearchDiacritics(input.query);
  const simpleQuery = buildSimpleSearchQuery(input.query);
  const lexicalResult = await db.query<{
    catalog_item_id: string;
    title: string;
    exact_title_match: boolean;
    lexical_rank: string | number;
  }>(
    `SELECT catalog_item_id,
            title,
            lower(title) = lower($4) AS exact_title_match,
            ts_rank(search_text, plainto_tsquery('english', $1)) +
              ts_rank(search_text_simple, plainto_tsquery('simple', $2)) AS lexical_rank
     FROM discovery_search_items
     WHERE status = 'active'
       AND (search_text @@ plainto_tsquery('english', $1)
         OR search_text_simple @@ plainto_tsquery('simple', $2))
     ORDER BY exact_title_match DESC, lexical_rank DESC, title ASC, catalog_item_id ASC
     LIMIT $3`,
    [englishQuery, simpleQuery, CANDIDATE_LIMIT, input.query],
  );
  const semanticResult = await db.query<{
    catalog_item_id: string;
    title: string;
    exact_title_match: boolean;
    semantic_similarity: string | number;
  }>(
    `SELECT catalog_item_id,
            title,
            lower(title) = lower($1) AS exact_title_match,
            -(search_embedding <#> $2::halfvec(1024)) AS semantic_similarity
     FROM discovery_search_items
     WHERE status = 'active'
       AND search_embedding IS NOT NULL
       AND -(search_embedding <#> $2::halfvec(1024)) >= $3
     ORDER BY search_embedding <#> $2::halfvec(1024), title ASC, catalog_item_id ASC
     LIMIT $4`,
    [input.query, halfVectorLiteral(input.queryEmbedding), SEMANTIC_MINIMUM_SIMILARITY, CANDIDATE_LIMIT],
  );
  return {
    lexical: lexicalResult.rows.map((row, index) => ({
      catalogItemId: row.catalog_item_id,
      title: row.title,
      exactTitleMatch: row.exact_title_match,
      lexicalRank: index + 1,
      semanticRank: null,
      semanticSimilarity: null,
    })),
    semantic: semanticResult.rows.map((row, index) => ({
      catalogItemId: row.catalog_item_id,
      title: row.title,
      exactTitleMatch: row.exact_title_match,
      lexicalRank: null,
      semanticRank: index + 1,
      semanticSimilarity: Number(row.semantic_similarity),
    })),
  };
}

function localized(languageCode: string, value: string): string {
  return JSON.stringify({ defaultLocale: languageCode, values: { [languageCode]: value } });
}

function halfVectorLiteral(vector: readonly number[]): string {
  if (vector.some((value) => !Number.isFinite(value)))
    throw new Error("Relevance embedding contains a non-finite value.");
  return `[${vector.join(",")}]`;
}

function validateEvaluationFixture(
  catalogItems: readonly RelevanceCatalogFixtureItem[],
  goldenQueries: readonly GoldenQuery[],
  fixture: RelevanceEmbeddingFixture,
): void {
  if (goldenQueries.length < 50 || goldenQueries.length > 100) {
    throw new Error(`Golden query fixture must contain 50-100 cases; found ${goldenQueries.length}.`);
  }
  const requiredCoverage = ["en", "ja", "alias", "misspelling", "semantic-intent", "zero-result"];
  const coverage = new Set(goldenQueries.flatMap((goldenQuery) => goldenQuery.coverage));
  const missingCoverage = requiredCoverage.filter((value) => !coverage.has(value));
  if (missingCoverage.length > 0) {
    throw new Error(`Golden query fixture is missing coverage: ${missingCoverage.join(", ")}.`);
  }
  const catalogItemIds = new Set(catalogItems.map((item) => item.catalogItemId));
  for (const goldenQuery of goldenQueries) {
    if (goldenQuery.expected.kind === "items") {
      if (goldenQuery.expected.itemIds.length === 0) {
        throw new Error(`Golden query '${goldenQuery.id}' has no expected items.`);
      }
      for (const expectedItemId of goldenQuery.expected.itemIds) {
        if (!catalogItemIds.has(expectedItemId)) {
          throw new Error(`Golden query '${goldenQuery.id}' references unknown item '${expectedItemId}'.`);
        }
      }
    }
    if (!fixture.queries[goldenQuery.id]) {
      throw new Error(`Missing query embedding for '${goldenQuery.id}'.`);
    }
  }
  if (fixture.dimensions !== 1_024) throw new Error("Relevance fixture embeddings must use 1024 dimensions.");
  const sourceHash = createHash("sha256").update(JSON.stringify({ catalogItems, goldenQueries })).digest("hex");
  if (fixture.sourceHash !== sourceHash) {
    throw new Error("Embedding fixture is stale; run pnpm run generate:discovery-search-relevance-embeddings.");
  }
  for (const item of catalogItems) {
    if (!fixture.documents[item.catalogItemId]) {
      throw new Error(`Missing document embedding for '${item.catalogItemId}'.`);
    }
  }
}

function expandSparseEmbedding(components: readonly (readonly [number, number])[], dimensions: number): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  for (const [index, value] of components) {
    if (!Number.isInteger(index) || index < 0 || index >= dimensions || !Number.isFinite(value)) {
      throw new Error("Embedding component is outside the declared dimensions.");
    }
    vector[index] = value;
  }
  return vector;
}
