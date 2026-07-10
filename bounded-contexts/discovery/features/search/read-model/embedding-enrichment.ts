import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  buildDiscoveryEmbeddingDocument,
  estimateDiscoveryEmbeddingTokens,
  type DiscoveryEmbeddingDocument,
} from "../domain/embedding-document";
import type { DiscoveryEmbeddingProvider } from "../integrations/voyage-embedding-provider";

export const DISCOVERY_EMBEDDING_BATCH_SIZE = 128;
export const VOYAGE_4_LITE_PRICE_PER_MILLION_TOKENS_USD = 0.02;

type EmbeddingCandidateRow = Readonly<{
  catalog_item_id: string;
  title_i18n: unknown;
  title: string;
  subtitle_i18n: unknown;
  subtitle: string | null;
  description_i18n: unknown;
  description: string;
  category_names: unknown;
  field_values_text: string;
  resolved_aliases: unknown;
  embedding_model: string | null;
  embedded_text_hash: string | null;
  embedding_updated_at: string | null;
}>;

type PreparedEmbeddingCandidate = Readonly<{
  catalogItemId: string;
  document: DiscoveryEmbeddingDocument;
}>;

export type DiscoverySearchEmbeddingEnrichment = Readonly<{
  model: string;
  processNextBatch: (input?: Readonly<{ limit?: number; signal?: AbortSignal }>) => Promise<
    Readonly<{
      processed: number;
      embedded: number;
      totalTokens: number;
    }>
  >;
  inspectVectorCapabilities: () => Promise<DiscoveryVectorCapabilities>;
  estimateBackfillPage: (
    input?: Readonly<{
      afterCatalogItemId?: string | null;
      limit?: number;
      pricePerMillionTokensUsd?: number;
    }>,
  ) => Promise<DiscoveryEmbeddingBackfillEstimatePage>;
}>;

export type DiscoveryEmbeddingBackfillEstimatePage = Readonly<{
  itemCount: number;
  estimatedTokens: number;
  estimatedCostUsd: number;
  lastCatalogItemId: string | null;
}>;

export type DiscoveryVectorCapabilities = Readonly<{
  extensionVersion: string | null;
  supportsHnsw: boolean;
  supportsHalfvec: boolean;
  supportsIterativeIndexScans: boolean;
}>;

export function createDiscoverySearchEmbeddingEnrichment(
  input: Readonly<{
    db: PgQueryable;
    provider: DiscoveryEmbeddingProvider;
    batchSize?: number;
  }>,
): DiscoverySearchEmbeddingEnrichment {
  if (input.provider.dimensions !== 1_024) {
    throw new Error(`Discovery search embeddings require 1024 dimensions, got ${input.provider.dimensions}.`);
  }
  const batchSize = positiveInteger(input.batchSize ?? DISCOVERY_EMBEDDING_BATCH_SIZE, "batchSize");

  return {
    model: input.provider.model,
    inspectVectorCapabilities: () => inspectDiscoveryVectorCapabilities(input.db),
    estimateBackfillPage: (options = {}) =>
      estimateEmbeddingBackfillPage(input.db, {
        model: input.provider.model,
        afterCatalogItemId: options.afterCatalogItemId ?? null,
        limit: options.limit ?? 1_000,
        pricePerMillionTokensUsd: options.pricePerMillionTokensUsd ?? VOYAGE_4_LITE_PRICE_PER_MILLION_TOKENS_USD,
      }),
    processNextBatch: async (options = {}) => {
      const limit = positiveInteger(options.limit ?? batchSize, "limit");
      const candidates = await loadEmbeddingCandidates(input.db, input.provider.model, limit, null);
      const prepared: PreparedEmbeddingCandidate[] = [];

      for (const row of candidates) {
        options.signal?.throwIfAborted();
        const document = embeddingDocumentFromRow(row);
        if (row.embedded_text_hash !== document.hash) {
          const marked = await input.db.query(
            `UPDATE discovery_search_items
             SET embedded_text_hash = $2,
                 embedding_updated_at = NULL
             WHERE catalog_item_id = $1
               AND embedded_text_hash IS NOT DISTINCT FROM $3`,
            [row.catalog_item_id, document.hash, row.embedded_text_hash],
          );
          if (marked.rowCount !== 1) {
            continue;
          }
        }
        prepared.push({ catalogItemId: row.catalog_item_id, document });
      }

      if (prepared.length === 0) {
        return { processed: 0, embedded: 0, totalTokens: 0 };
      }

      const providerResult = await input.provider.embed(
        prepared.map((candidate) => candidate.document.text),
        "document",
        { signal: options.signal },
      );
      if (providerResult.vectors.length !== prepared.length) {
        throw new Error(
          `Embedding provider returned ${providerResult.vectors.length} vectors for ${prepared.length} documents.`,
        );
      }

      let embedded = 0;
      for (const [index, candidate] of prepared.entries()) {
        options.signal?.throwIfAborted();
        const vector = providerResult.vectors[index];
        if (!vector || vector.length !== 1_024) {
          throw new Error(`Embedding provider returned an invalid vector for '${candidate.catalogItemId}'.`);
        }
        const updated = await input.db.query(
          `UPDATE discovery_search_items
           SET search_embedding = $2::halfvec(1024),
               embedding_model = $3,
               embedding_updated_at = now()
           WHERE catalog_item_id = $1
             AND embedded_text_hash = $4
             AND (embedding_updated_at IS NULL OR embedding_model IS DISTINCT FROM $3)`,
          [candidate.catalogItemId, halfVectorLiteral(vector), input.provider.model, candidate.document.hash],
        );
        embedded += updated.rowCount ?? 0;
      }

      return {
        processed: prepared.length,
        embedded,
        totalTokens: providerResult.totalTokens,
      };
    },
  };
}

export async function inspectDiscoveryVectorCapabilities(db: PgQueryable): Promise<DiscoveryVectorCapabilities> {
  const result = await db.query<{ extversion: string }>(
    `SELECT extversion
     FROM pg_extension
     WHERE extname = 'vector'`,
  );
  const extensionVersion = result.rows[0]?.extversion ?? null;
  return {
    extensionVersion,
    supportsHnsw: versionAtLeast(extensionVersion, [0, 5, 0]),
    supportsHalfvec: versionAtLeast(extensionVersion, [0, 7, 0]),
    supportsIterativeIndexScans: versionAtLeast(extensionVersion, [0, 8, 0]),
  };
}

async function estimateEmbeddingBackfillPage(
  db: PgQueryable,
  input: Readonly<{
    model: string;
    afterCatalogItemId: string | null;
    limit: number;
    pricePerMillionTokensUsd: number;
  }>,
): Promise<DiscoveryEmbeddingBackfillEstimatePage> {
  const rows = await loadEmbeddingCandidates(
    db,
    input.model,
    positiveInteger(input.limit, "limit"),
    input.afterCatalogItemId,
  );
  const estimatedTokens = rows.reduce(
    (total, row) => total + estimateDiscoveryEmbeddingTokens(embeddingDocumentFromRow(row).text),
    0,
  );
  return {
    itemCount: rows.length,
    estimatedTokens,
    estimatedCostUsd: (estimatedTokens / 1_000_000) * input.pricePerMillionTokensUsd,
    lastCatalogItemId: rows.at(-1)?.catalog_item_id ?? null,
  };
}

async function loadEmbeddingCandidates(
  db: PgQueryable,
  model: string,
  limit: number,
  afterCatalogItemId: string | null,
): Promise<readonly EmbeddingCandidateRow[]> {
  const result = await db.query<EmbeddingCandidateRow>(
    `SELECT item.catalog_item_id,
            item.title_i18n,
            item.title,
            item.subtitle_i18n,
            item.subtitle,
            item.description_i18n,
            item.description,
            item.category_names,
            item.field_values_text,
            source.resolved_aliases,
            item.embedding_model,
            item.embedded_text_hash,
            item.embedding_updated_at
     FROM discovery_search_items AS item
     LEFT JOIN discovery_search_catalog_items AS source
       ON source.catalog_item_id = item.catalog_item_id
     WHERE item.status = 'active'
       AND (item.embedding_updated_at IS NULL OR item.embedding_model IS DISTINCT FROM $1)
       AND ($2::text IS NULL OR item.catalog_item_id > $2)
     ORDER BY item.catalog_item_id ASC
     LIMIT $3`,
    [model, afterCatalogItemId, limit],
  );
  return result.rows;
}

function embeddingDocumentFromRow(row: EmbeddingCandidateRow): DiscoveryEmbeddingDocument {
  return buildDiscoveryEmbeddingDocument({
    title: row.title,
    titleI18n: row.title_i18n,
    subtitle: row.subtitle,
    subtitleI18n: row.subtitle_i18n,
    resolvedAliases: row.resolved_aliases,
    categoryNames: row.category_names,
    keyFieldValues: row.field_values_text ? [row.field_values_text] : [],
    description: row.description,
    descriptionI18n: row.description_i18n,
  });
}

function halfVectorLiteral(vector: readonly number[]): string {
  if (vector.some((value) => !Number.isFinite(value))) {
    throw new Error("Embedding vector contains a non-finite component.");
  }
  return `[${vector.join(",")}]`;
}

function versionAtLeast(version: string | null, expected: readonly [number, number, number]): boolean {
  if (!version) return false;
  const actual = version
    .split(/[.-]/u)
    .slice(0, 3)
    .map((part) => Number(part));
  if (actual.some((part) => !Number.isFinite(part))) return false;
  for (let index = 0; index < expected.length; index += 1) {
    const difference = (actual[index] ?? 0) - expected[index];
    if (difference !== 0) return difference > 0;
  }
  return true;
}

function positiveInteger(value: number, fieldName: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer.`);
  }
  return value;
}
