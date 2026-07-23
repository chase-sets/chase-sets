import type { PgQueryResult, PgQueryable } from "@chase-sets/event-core-postgres";
import { describe, expect, it } from "vitest";
import type { DiscoveryEmbeddingProvider } from "../integrations/voyage-embedding-provider";
import { createDiscoverySearchEmbeddingEnrichment } from "./embedding-enrichment";

type Row = Record<string, unknown> & {
  catalog_item_id: string;
  title: string;
  embedded_text_hash: string | null;
  search_embedding: string | null;
  embedding_model: string | null;
  embedding_updated_at: string | null;
};

class EmbeddingDb implements PgQueryable {
  readonly rows: Row[];
  vectorWrites = 0;

  constructor(count: number) {
    this.rows = Array.from({ length: count }, (_, index) => ({
      catalog_item_id: `item-${index + 1}`,
      title_i18n: { values: { en: `Item ${index + 1}`, ja: `カード${index + 1}` } },
      title: `Item ${index + 1}`,
      subtitle_i18n: null,
      subtitle: null,
      description_i18n: { values: { en: "Description" } },
      description: "Description",
      category_names: ["Cards"],
      field_values_text: "Rare",
      resolved_aliases: {},
      embedded_text_hash: null,
      search_embedding: null,
      embedding_model: null,
      embedding_updated_at: null,
    }));
  }

  async query<ResultRow = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResult<ResultRow>> {
    if (sql.includes("FROM pg_extension")) {
      return { rows: [{ extversion: "0.8.1" }] as ResultRow[], rowCount: 1 };
    }
    if (sql.includes("FROM discovery_search_items AS item")) {
      const [model, after, limit] = values as [string, string | null, number];
      const candidates = this.rows
        .filter(
          (row) =>
            (row.embedding_updated_at === null || row.embedding_model !== model) &&
            (after === null || row.catalog_item_id > after),
        )
        .sort((left, right) => left.catalog_item_id.localeCompare(right.catalog_item_id))
        .slice(0, limit);
      return { rows: candidates as ResultRow[], rowCount: candidates.length };
    }
    if (sql.includes("SET embedded_text_hash")) {
      const [id, nextHash, previousHash] = values as [string, string, string | null];
      const row = this.rows.find((candidate) => candidate.catalog_item_id === id);
      if (!row || row.embedded_text_hash !== previousHash) return { rows: [], rowCount: 0 };
      row.embedded_text_hash = nextHash;
      row.search_embedding = null;
      row.embedding_model = null;
      row.embedding_updated_at = null;
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SET search_embedding")) {
      const [id, _vector, model, hash] = values as [string, string, string, string];
      const row = this.rows.find((candidate) => candidate.catalog_item_id === id);
      if (
        !row ||
        row.embedded_text_hash !== hash ||
        (row.embedding_updated_at !== null && row.embedding_model === model)
      ) {
        return { rows: [], rowCount: 0 };
      }
      row.search_embedding = String(_vector);
      row.embedding_model = model;
      row.embedding_updated_at = "2026-07-10T00:00:00.000Z";
      this.vectorWrites += 1;
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected query: ${sql}`);
  }
}

function provider(input: { failOnCall?: number } = {}): DiscoveryEmbeddingProvider & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    model: "voyage-4-lite",
    dimensions: 1_024,
    calls,
    embed: async (texts, inputType) => {
      expect(inputType).toBe("document");
      calls.push([...texts]);
      if (calls.length === input.failOnCall) throw new Error("provider unavailable");
      return {
        vectors: texts.map(() => [1, ...Array.from({ length: 1_023 }, () => 0)]),
        totalTokens: texts.length * 10,
      };
    },
  };
}

describe("Discovery search embedding enrichment", () => {
  it("batches, resumes after provider failure, and never re-embeds unchanged rows", async () => {
    const db = new EmbeddingDb(3);
    const unstableProvider = provider({ failOnCall: 2 });
    const enrichment = createDiscoverySearchEmbeddingEnrichment({
      db,
      provider: unstableProvider,
      batchSize: 2,
    });

    await expect(enrichment.processNextBatch()).resolves.toMatchObject({ processed: 2, embedded: 2 });
    await expect(enrichment.processNextBatch()).rejects.toThrow("provider unavailable");
    expect(db.vectorWrites).toBe(2);
    expect(db.rows[2]?.embedding_updated_at).toBeNull();

    const resumedProvider = provider();
    const resumed = createDiscoverySearchEmbeddingEnrichment({ db, provider: resumedProvider, batchSize: 2 });
    await expect(resumed.processNextBatch()).resolves.toMatchObject({ processed: 1, embedded: 1 });
    await expect(resumed.processNextBatch()).resolves.toEqual({ processed: 0, embedded: 0, totalTokens: 0 });
    expect(resumedProvider.calls).toHaveLength(1);
    expect(db.vectorWrites).toBe(3);
  });

  it("re-embeds revised text and reports pgvector/backfill capabilities without provider calls", async () => {
    const db = new EmbeddingDb(1);
    const fakeProvider = provider();
    const enrichment = createDiscoverySearchEmbeddingEnrichment({ db, provider: fakeProvider });

    await enrichment.processNextBatch();
    const originalHash = db.rows[0]?.embedded_text_hash;
    expect(db.rows[0]?.search_embedding).not.toBeNull();
    if (db.rows[0]) {
      db.rows[0].title = "Revised Item";
      db.rows[0].embedding_updated_at = null;
    }
    const unavailableProvider = provider({ failOnCall: 1 });
    const interrupted = createDiscoverySearchEmbeddingEnrichment({ db, provider: unavailableProvider });
    await expect(interrupted.processNextBatch()).rejects.toThrow("provider unavailable");

    expect(db.rows[0]?.embedded_text_hash).not.toBe(originalHash);
    expect(db.rows[0]).toMatchObject({
      search_embedding: null,
      embedding_model: null,
      embedding_updated_at: null,
    });

    await enrichment.processNextBatch();
    expect(db.rows[0]?.search_embedding).not.toBeNull();
    expect(fakeProvider.calls).toHaveLength(2);
    await expect(enrichment.inspectVectorCapabilities()).resolves.toEqual({
      extensionVersion: "0.8.1",
      supportsHnsw: true,
      supportsHalfvec: true,
      supportsIterativeIndexScans: true,
    });
  });
});
