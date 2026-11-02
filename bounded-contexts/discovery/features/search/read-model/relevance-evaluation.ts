import { createHash } from "node:crypto";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createQueryEmbeddingCache, normalizeQueryForEmbedding } from "../domain/query-embedding-cache";
import { retrieveDiscoveryItems } from "./hybrid-retrieval";
import { rebuildDiscoverySearchIndex } from "./projection";
import type { DiscoveryEmbeddingProvider } from "../integrations/voyage-embedding-provider";
import {
  buildRelevanceReport,
  evaluateGoldenQuery,
  RELEVANCE_MODES,
  RELEVANCE_RESULT_LIMIT,
  summarizeRelevanceMode,
  validateGoldenQuery,
  type GoldenQuery,
  type GoldenQueryResult,
  type RelevanceMode,
  type RelevanceReport,
} from "../domain/relevance-evaluation";

export type RelevanceCatalogFixtureItem = Readonly<{
  catalogItemId: string;
  languageCode: string;
  title: string;
  subtitle: string;
  description: string;
  aliases: readonly string[];
  categories: readonly string[];
  tags: readonly string[];
  variants?: readonly Readonly<{ finish: "foil" | "nonfoil"; price: string; quantity: number }>[];
  naturalKey?: Readonly<{ setCode: string; cardNumber: string }>;
}>;

export type RelevanceEmbeddingFixture = Readonly<{
  version: 2;
  source: "deterministic" | "voyage";
  model: string;
  dimensions: number;
  sourceHash: string;
  documents: Readonly<Record<string, readonly (readonly [number, number])[]>>;
  queries: Readonly<Record<string, readonly (readonly [number, number])[]>>;
  documentProvenance: Readonly<Record<string, Readonly<{ text: string; hash: string; key: string }>>>;
  queryProvenance: Readonly<Record<string, Readonly<{ text: string; inputType: "query"; model: string }>>>;
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
  const projected = await db.query<{ catalog_item_id: string; embedded_text_hash: string }>(
    "SELECT catalog_item_id, embedded_text_hash FROM discovery_search_items",
  );
  if (projected.rows.length !== input.catalogItems.length)
    throw new Error("Production projection did not populate every fixture item.");
  for (const item of projected.rows) {
    const provenance = input.embeddingFixture.documentProvenance[item.catalog_item_id];
    if (
      !provenance ||
      provenance.hash !== item.embedded_text_hash ||
      createHash("sha256").update(provenance.text).digest("hex") !== provenance.hash ||
      provenance.key !== relevanceEmbeddingInputKey(input.embeddingFixture.model, "document", provenance.text)
    )
      throw new Error(`Stale production document snapshot for '${item.catalog_item_id}'.`);
  }

  const caseResults = Object.fromEntries(RELEVANCE_MODES.map((mode) => [mode, [] as GoldenQueryResult[]])) as Record<
    RelevanceMode,
    GoldenQueryResult[]
  >;
  const queryVectors = input.embeddingFixture.queries;
  const missingInputs = new Set<string>();
  let providerCalls = 0;
  let failProvider = false;
  const provider: DiscoveryEmbeddingProvider = {
    model: input.embeddingFixture.model,
    dimensions: input.embeddingFixture.dimensions,
    embed: async (texts: readonly string[], inputType: "query" | "document") => {
      providerCalls += 1;
      if (failProvider) throw new Error("Synthetic provider failure.");
      if (inputType !== "query") throw new Error("Relevance evaluation only embeds query inputs at retrieval time.");
      return {
        vectors: texts.map((text) => {
          const components = queryVectors[relevanceEmbeddingInputKey(provider.model, "query", text)];
          if (!components) {
            missingInputs.add(text);
            throw new Error(`Missing effective-query vector for '${text}'.`);
          }
          return expandSparseEmbedding(components, input.embeddingFixture.dimensions);
        }),
        totalTokens: texts.length,
      };
    },
  };
  for (const goldenQuery of input.goldenQueries) {
    failProvider = goldenQuery.scenario === "provider-failure";
    for (const mode of RELEVANCE_MODES) {
      const semantic = mode !== "lexical-only";
      const callsBefore = providerCalls;
      const result = await retrieveDiscoveryItems(
        {
          db,
          provider,
          cache: createQueryEmbeddingCache(),
          rescueEnabled: mode !== "hybrid" ? semantic : true,
          hybridEnabled: mode === "hybrid",
        },
        { ...goldenQuery.request, search: goldenQuery.query, limit: 50, includeTotal: true },
      );
      if (missingInputs.size > 0) throw new Error(`Missing effective-query vector: ${[...missingInputs].join(", ")}.`);
      const summaries = result.items.map((item) => ({
        catalogItemId: item.catalog_item_id,
        summary: item.market_summary
          ? {
              price: item.market_summary.lowest_price_amount,
              currency: item.market_summary.lowest_price_currency_code ?? null,
              inStock: item.market_summary.total_visible_quantity > 0,
              buy: item.market_summary.active_listing_count > 0 && item.market_summary.total_visible_quantity > 0,
            }
          : null,
      }));
      const evaluated = evaluateGoldenQuery(goldenQuery, summaries);
      caseResults[mode].push({
        ...evaluated,
        live: {
          retrievalMode: result.retrievalMode,
          interpretation: result.interpretation ?? null,
          total: result.total,
          facets: result.facets,
          categoryCounts: result.category_counts,
          lexicalCount: result.lexicalCount,
          providerCalls: providerCalls - callsBefore,
          resultItemIds: result.items.map((item) => item.catalog_item_id),
        },
        resultItemIds: result.items.slice(0, RELEVANCE_RESULT_LIMIT).map((item) => item.catalog_item_id),
        total: result.total,
        interpretation: result.interpretation ?? null,
        summaries,
      });
    }
  }
  const modes = Object.fromEntries(
    RELEVANCE_MODES.map((mode) => [mode, summarizeRelevanceMode(mode, caseResults[mode])]),
  ) as Record<RelevanceMode, ReturnType<typeof summarizeRelevanceMode>>;
  return buildRelevanceReport({
    generatedAt: input.generatedAt,
    sourceHash: input.embeddingFixture.sourceHash,
    embeddingModel: input.embeddingFixture.model,
    embeddingSource: input.embeddingFixture.source,
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
  await db.query("DELETE FROM discovery_search_catalog_items");
  await db.query("DELETE FROM discovery_search_catalog_categories");
  await db.query("DELETE FROM discovery_market_listings");
  await db.query(
    "INSERT INTO discovery_market_accounts (account_id, status) VALUES ('relevance-seller', 'active') ON CONFLICT (account_id) DO NOTHING",
  );
  await db.query(
    "INSERT INTO discovery_search_catalog_blueprints (blueprint_id, name) VALUES ('relevance-card', 'Card') ON CONFLICT (blueprint_id) DO NOTHING",
  );
  await db.query(
    "INSERT INTO discovery_search_catalog_dimensions (dimension_id, name, value_kind) VALUES ('relevance-finish', 'Finish', 'unordered') ON CONFLICT (dimension_id) DO NOTHING",
  );
  await db.query(
    `INSERT INTO discovery_search_catalog_dimension_options (option_id, dimension_id, code, label, status) VALUES ('relevance-foil', 'relevance-finish', 'foil', 'Foil', 'active'), ('relevance-nonfoil', 'relevance-finish', 'nonfoil', 'Nonfoil', 'active') ON CONFLICT (option_id) DO NOTHING`,
  );
  await db.query(
    `INSERT INTO discovery_search_catalog_blueprint_dimensions (blueprint_id, dimension_id, allowed_option_ids) VALUES ('relevance-card', 'relevance-finish', '["relevance-foil","relevance-nonfoil"]'::jsonb) ON CONFLICT (blueprint_id, dimension_id) DO NOTHING`,
  );
  await db.query(
    `INSERT INTO discovery_search_catalog_fields (field_id, key, name, value_type, filterable) VALUES ('relevance-number', 'card-number', 'Card number', 'string', true), ('relevance-set', 'set', 'Set', 'reference', true) ON CONFLICT (field_id) DO NOTHING`,
  );
  for (const name of new Set(items.flatMap((item) => item.categories))) {
    await db.query(
      `INSERT INTO discovery_search_catalog_categories (category_id, slug, name, status) VALUES ($1, $1, $2, 'active')`,
      [createHash("sha256").update(name).digest("hex"), name],
    );
  }
  for (const item of items) {
    const embedding = documentEmbeddings[item.catalogItemId];
    if (!embedding || embedding.length !== 1_024) {
      throw new Error(`Missing 1024-dimensional relevance embedding for '${item.catalogItemId}'.`);
    }
    await db.query(
      `INSERT INTO discovery_search_catalog_items (
         catalog_item_id, slug, language_code, title_i18n, title, subtitle_i18n, subtitle,
         description_i18n, description, status, category_ids, tags, resolved_aliases, blueprint_id, updated_at
       ) VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7, $8::jsonb, $9, 'active', $10::jsonb, $11::jsonb, $12::jsonb, 'relevance-card', now())`,
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
        JSON.stringify(item.categories.map((name) => createHash("sha256").update(name).digest("hex"))),
        JSON.stringify(item.tags),
        JSON.stringify({
          [item.languageCode]: item.aliases.map((aliasText) => ({
            aliasText,
            aliasHash: createHash("sha256").update(aliasText).digest("hex"),
            normalizedAliasText: aliasText.toLowerCase(),
            aliasType: "official-equivalent",
            confidence: "exact",
            broad: false,
          })),
        }),
      ],
    );
    if (item.naturalKey) {
      const { setCode, cardNumber } = item.naturalKey;
      await db.query(
        `INSERT INTO discovery_search_catalog_reference_records (reference_record_id, type_key, key, name, attributes, status) VALUES ($1, 'set', $2, $2, $3::jsonb, 'active') ON CONFLICT (reference_record_id) DO UPDATE SET attributes = EXCLUDED.attributes`,
        [`relevance-set-${setCode}`, setCode, JSON.stringify({ code: setCode })],
      );
      await db.query("UPDATE discovery_search_catalog_items SET field_values = $2::jsonb WHERE catalog_item_id = $1", [
        item.catalogItemId,
        JSON.stringify([
          { fieldId: "relevance-number", value: cardNumber },
          { fieldId: "relevance-set", value: { referenceId: `relevance-set-${setCode}` } },
        ]),
      ]);
    }
    for (const [index, variant] of (item.variants ?? []).entries()) {
      await db.query(
        `INSERT INTO discovery_market_listings (listing_id, account_id, inventory_item_id, catalog_catalog_item_id, product_id, selected_options, price_amount, price_currency_code, quantity_cap, supply_total_quantity, active_held_quantity, status, listing_stream_version, product_measure_snapshot)
        VALUES ($1, 'relevance-seller', $1, $2, $1, $3::jsonb, $4, 'USD', $5, $5, 0, 'active', 1, '{}'::jsonb)`,
        [
          `${item.catalogItemId}-${index}`,
          item.catalogItemId,
          JSON.stringify([{ dimensionId: "relevance-finish", optionId: `relevance-${variant.finish}` }]),
          variant.price,
          variant.quantity,
        ],
      );
    }
  }
  await rebuildDiscoverySearchIndex(db);
  for (const item of items) {
    await db.query(
      `UPDATE discovery_search_items
       SET search_embedding = $2::halfvec(1024), embedding_model = $3,
           embedding_updated_at = now()
       WHERE catalog_item_id = $1`,
      [item.catalogItemId, halfVectorLiteral(documentEmbeddings[item.catalogItemId]!), embeddingModel],
    );
  }
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
    validateGoldenQuery(goldenQuery);
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
    for (const query of [goldenQuery.query, ...(goldenQuery.effectiveQueries ?? [])]) {
      const text = normalizeQueryForEmbedding(query);
      const key = relevanceEmbeddingInputKey(fixture.model, "query", text);
      const provenance = fixture.queryProvenance[key];
      if (
        !fixture.queries[key] ||
        provenance?.text !== text ||
        provenance.model !== fixture.model ||
        provenance.inputType !== "query"
      )
        throw new Error(`Missing effective-query vector for '${text}'.`);
    }
  }
  if (fixture.dimensions !== 1_024) throw new Error("Relevance fixture embeddings must use 1024 dimensions.");
  if (fixture.version !== 2 || !["deterministic", "voyage"].includes(fixture.source))
    throw new Error("Invalid snapshot provenance.");
  const sourceHash = createHash("sha256").update(JSON.stringify({ catalogItems, goldenQueries })).digest("hex");
  if (fixture.sourceHash !== sourceHash) {
    throw new Error("Embedding fixture is stale; run pnpm run generate:discovery-search-relevance-embeddings.");
  }
  for (const item of catalogItems) {
    if (!fixture.documents[item.catalogItemId]) {
      throw new Error(`Missing document embedding for '${item.catalogItemId}'.`);
    }
  }
  for (const components of [...Object.values(fixture.documents), ...Object.values(fixture.queries)])
    expandSparseEmbedding(components, fixture.dimensions);
}

export function relevanceEmbeddingInputKey(model: string, inputType: "query" | "document", text: string): string {
  return createHash("sha256")
    .update(JSON.stringify([model, inputType, text]))
    .digest("hex");
}

function expandSparseEmbedding(components: readonly (readonly [number, number])[], dimensions: number): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  const seen = new Set<number>();
  for (const [index, value] of components) {
    if (!Number.isInteger(index) || index < 0 || index >= dimensions || !Number.isFinite(value) || seen.has(index)) {
      throw new Error("Embedding component is outside the declared dimensions.");
    }
    vector[index] = value;
    seen.add(index);
  }
  if (Math.abs(Math.hypot(...vector) - 1) > 0.00001) throw new Error("Snapshot vectors must be normalized.");
  return vector;
}
