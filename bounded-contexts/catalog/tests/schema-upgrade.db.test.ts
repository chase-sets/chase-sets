import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as catalogModule } from "../index";
import type { CatalogItemId } from "../ids";
import { decideCatalogItem, evolveCatalogItem, initialCatalogItemState } from "../features/catalog-items/domain/domain";
import {
  decideSourceObservation,
  initialSourceObservationState,
  sourceObservationLinkExternalKey,
} from "../features/source-observations/domain/domain";
import { SOURCE_OBSERVATION_INLINE_EVENT_TARGET_BYTES } from "../features/source-observations/domain/source-observation-payload-chunks";
import {
  canonicalPromotionReferencePairs,
  canonicalPromotionReferenceText as canonical,
  canonicalPromotionSourceLinkText,
  promotionReferenceFunctionMarker,
  promotionReferenceFunctionSearchPath,
  promotionReferenceFunctions,
  promotionReferenceParityCorpus,
  promotionReferenceTextFunctionName,
} from "../features/source-observations/api/promotion/promotion-reference-canonicalization";
import {
  catalogPromotionReferenceAccessPathMigrations,
  promotionReferenceExpressions,
  promotionReferenceIndexes,
  promotionReferenceKeyBoundedQueries,
  promotionReferencePredicates,
  readPromotionReferenceAccessPathReadiness,
} from "../features/source-observations/api/promotion/promotion-target-indexes";
import {
  cacheKeyForProviderOptionQuery,
  createPgCatalogProviderOptionQueryCacheStore,
  queryCatalogProviderIntegrationOptionsWithCache,
} from "../features/source-observations/api/providers/provider-option-query-cache";
import { seedContext } from "../support/seed-support/context";
import { normalizedObservation } from "../support/test-support/source-observation-fixtures";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = adminDatabaseUrl ? describe : describe.skip;

async function readColumnNames(pool: PgTransactionalPool, tableName: string): Promise<string[]> {
  const result = await pool.query<{ column_name: string }>(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1
     ORDER BY column_name`,
    [tableName],
  );
  return result.rows.map((row) => row.column_name);
}

const accessPathMigrationId = catalogPromotionReferenceAccessPathMigrations[0].migrationId;
const [itemIndex, productIndex, sourceHeaderIndex, sourceLinkIndex] = promotionReferenceIndexes;
const textFunction = promotionReferenceFunctions[0];
const sqlLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;
const inlineParameters = (query: string, values: readonly string[]) =>
  query.replace(/\$(\d+)/g, (_, index: string) => sqlLiteral(values[Number(index) - 1]));

/** Digests of every retained event-table byte, ordered by position. */
async function digestEvents(pool: PgTransactionalPool) {
  const result = await pool.query<{ events: string; streams: string; count: string }>(
    `SELECT md5(coalesce(string_agg(row_to_json(e)::text, '|' ORDER BY e.global_position), '')) AS events,
            count(*)::text AS count,
            (SELECT md5(coalesce(string_agg(row_to_json(s)::text, '|' ORDER BY s.stream_id), ''))
               FROM event_store_streams s) AS streams
     FROM event_store_events e`,
  );
  return result.rows[0];
}

async function deleteAccessPathLedgerRow(pool: PgTransactionalPool) {
  await pool.query("DELETE FROM bounded_context_schema_migrations WHERE migration_id = $1", [accessPathMigrationId]);
}

async function readAccessPathLedgerRows(pool: PgTransactionalPool) {
  return (
    await pool.query<{ migration_id: string }>(
      "SELECT migration_id FROM bounded_context_schema_migrations WHERE migration_id = $1",
      [accessPathMigrationId],
    )
  ).rows;
}

/** Leaves an invalid index named like an owned one behind, the way an interrupted concurrent build does. */
async function leaveInvalidIndex(pool: PgTransactionalPool, name: string) {
  await pool.query(`DROP INDEX IF EXISTS ${name}`);
  await expect(
    pool.query(
      `CREATE UNIQUE INDEX CONCURRENTLY ${name} ON event_store_events ((${promotionReferenceTextFunctionName}(payload->>'providerKey')))`,
    ),
  ).rejects.toThrow(/could not create unique index/);
  const state = await pool.query<{ indisvalid: boolean }>(
    "SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass($1)",
    [name],
  );
  expect(state.rows).toEqual([{ indisvalid: false }]);
}

const rawItemReferences = [
  { itemId: "cat_promotion_ref_a", providerKey: " TCGdex ", externalKey: " SWSH3-136 " },
  { itemId: "cat_promotion_ref_b", providerKey: "tcgdex", externalKey: "swsh3-136" },
  { itemId: "cat_promotion_ref_c", providerKey: " Scrydex﻿", externalKey: "İΣTANBUL" },
  { itemId: "cat_promotion_ref_d", providerKey: "unrelated", externalKey: "other-key" },
] as const;

const rawSourceReferences = {
  externalCatalogItemReferences: [{ providerKey: " TCGdex ", externalKey: " SWSH3-136 " }],
  externalProductReferences: [
    { providerKey: "Scrydex", externalKey: "İΣTANBUL", selectedOptions: [] },
    { providerKey: "tcgplayer", externalKey: "﻿Same-Key " },
  ],
} as const;

function recordCommand(observationId: string, externalKey: string, sourcePayload: Record<string, string>) {
  return {
    type: "RecordSourceObservation",
    observationId,
    providerKey: " TCGdex ",
    externalKey,
    sourceUrl: "https://api.tcgdex.net/v2/en/cards/swsh3-136",
    languageCode: "EN-us",
    sourceRecordHash: `hash-${observationId}`,
    sourceUpdatedAt: null,
    observedAt: "2026-05-15T00:00:00.000Z",
    sourceProfileKey: "pokemon-tcg",
    sourceProfileVersion: "2026.06.03",
    sourceMappingFingerprint: "mapping-fingerprint",
    normalized: normalizedObservation(rawSourceReferences),
    sourcePayload,
  } as const;
}

/** Retained history written through the real domain deciders: items at both levels, inline and chunked source headers. */
async function appendRetainedHistory(pool: PgTransactionalPool) {
  const store = createPostgresEventStore({ pool });
  for (const reference of rawItemReferences) {
    const created = decideCatalogItem(initialCatalogItemState, {
      type: "CreateCatalogItem",
      itemId: reference.itemId as CatalogItemId,
      languageCode: "en",
      title: { defaultLocale: "en", values: { en: `Retained ${reference.itemId}` } },
    });
    const state = created.reduce(evolveCatalogItem, initialCatalogItemState);
    const links = (["LinkExternalCatalogItemReference", "LinkExternalProductReference"] as const).flatMap((type) =>
      decideCatalogItem(state, { type, providerKey: reference.providerKey, externalKey: reference.externalKey }),
    );
    await store.appendToStream({
      streamId: `catalog.item-${reference.itemId}`,
      expectedVersion: 0,
      context: seedContext,
      events: [...created, ...links].map((event) => ({ eventType: event.type, payload: event.data })),
    });
  }
  const inline = decideSourceObservation(
    initialSourceObservationState,
    recordCommand("tcgdex_en_inline", " SWSH3-136 ", { id: "swsh3-136" }),
  );
  const chunked = decideSourceObservation(
    initialSourceObservationState,
    recordCommand("tcgdex_en_chunked", " SWSH3-136﻿", {
      id: "swsh3-136",
      blob: "x".repeat(SOURCE_OBSERVATION_INLINE_EVENT_TARGET_BYTES + 1),
    }),
  );
  expect(inline).toHaveLength(1);
  expect(chunked.length).toBeGreaterThan(1);
  for (const [observationId, events] of [
    ["tcgdex_en_inline", inline],
    ["tcgdex_en_chunked", chunked],
  ] as const) {
    await store.appendToStream({
      streamId: `catalog.source-observation-${observationId}`,
      expectedVersion: 0,
      context: seedContext,
      events: events.map((event) => ({ eventType: event.type, payload: event.data })),
    });
  }
  return { itemEvents: rawItemReferences, sourceHeaders: [inline[0], chunked[0]] };
}

/** Bulk retained rows large enough that a sequential scan is never the planner's choice. */
async function appendBulkRetainedRows(pool: PgTransactionalPool, perFamily: number) {
  await pool.query(
    `INSERT INTO event_store_streams (stream_id, current_version, updated_at)
     SELECT 'catalog.item-bulk-' || g, 2, now() FROM generate_series(1, $1::int) g
     UNION ALL
     SELECT 'catalog.source-observation-bulk-' || g, 1, now() FROM generate_series(1, $1::int) g`,
    [perFamily],
  );
  await pool.query(
    `INSERT INTO event_store_events (event_id, stream_id, stream_version, tenant_id, stream_context_name, stream_category,
       event_type, payload, occurred_at, recorded_at, performed_by_user_id, for_account_id)
     SELECT 'evt_bulk_item_' || g, 'catalog.item-bulk-' || g, 1, 'tnt_bulk', 'catalog', 'item',
       CASE WHEN g % 2 = 0 THEN 'catalog.catalog-item.external-catalog-item-reference-linked'
            ELSE 'catalog.catalog-item.external-product-reference-linked' END,
       jsonb_build_object('providerKey', 'bulk', 'externalKey', 'key-' || g), now(), now(), 'usr_bulk', 'acc_bulk'
     FROM generate_series(1, $1::int) g
     UNION ALL
     SELECT 'evt_bulk_other_' || g, 'catalog.item-bulk-' || g, 2, 'tnt_bulk', 'catalog', 'item',
       'catalog.catalog-item.title-changed', jsonb_build_object('providerKey', 'bulk', 'externalKey', 'key-' || g),
       now(), now(), 'usr_bulk', 'acc_bulk'
     FROM generate_series(1, $1::int) g
     UNION ALL
     SELECT 'evt_bulk_source_' || g, 'catalog.source-observation-bulk-' || g, 1, 'tnt_bulk', 'catalog', 'source-observation',
       'catalog.source-observation.recorded',
       jsonb_build_object('providerKey', 'bulk', 'externalKey', 'src-' || g, 'languageCode', 'en',
         'normalized', jsonb_build_object(
           'externalCatalogItemReferences', jsonb_build_array(jsonb_build_object('providerKey', 'bulk', 'externalKey', 'item-' || g)),
           'externalProductReferences', jsonb_build_array(jsonb_build_object('providerKey', 'bulk', 'externalKey', 'prod-' || g)))),
       now(), now(), 'usr_bulk', 'acc_bulk'
     FROM generate_series(1, $1::int) g`,
    [perFamily],
  );
}

type PlanNode = Readonly<{ [key: string]: unknown; Plans?: readonly PlanNode[] }>;

function flattenPlan(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flattenPlan)];
}

async function explain(pool: PgTransactionalPool, query: string, values: readonly string[]) {
  const result = await pool.query<{ "QUERY PLAN": readonly { Plan: PlanNode }[] }>(
    `EXPLAIN (FORMAT JSON) ${inlineParameters(query, values)}`,
  );
  return flattenPlan(result.rows[0]["QUERY PLAN"][0].Plan);
}

describeDb("catalog schema upgrades", () => {
  let pools: Readonly<Record<"catalog", PgTransactionalPool>>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(adminDatabaseUrl!, ["catalog"], "catalog_schema_upgrade");
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });

  beforeEach(async () => resetMultiContextTestSchemas(pools));
  afterAll(async () => closeMultiContextTestPools(pools));

  it("installs promotion-reference functions and indexes on a fresh boot and canonicalizes the pinned corpus byte-for-byte", async () => {
    const pool = pools.catalog;
    const empty = await readPromotionReferenceAccessPathReadiness(pool);
    expect(empty.ready).toBe(false);
    expect(empty.failures).toEqual([
      ...promotionReferenceFunctions.map((fn) => `function-missing:${fn.name}`),
      ...promotionReferenceIndexes.map((index) => `index-missing:${index.name}`),
    ]);

    await bootstrapContextDatabase(catalogModule, pool);
    const readiness = await readPromotionReferenceAccessPathReadiness(pool);
    expect(readiness).toMatchObject({
      ready: true,
      failures: [],
      version: 1,
      runtime: { unicode: "17.0", pinnedUnicode: "17.0" },
      environment: { serverEncoding: "UTF8", cCollationVersionless: true },
    });
    expect(readiness.functions).toEqual(
      promotionReferenceFunctions.map((fn) => ({
        name: fn.name,
        installed: true,
        identical: true,
        marker: promotionReferenceFunctionMarker,
      })),
    );
    expect(readiness.indexes).toEqual(
      promotionReferenceIndexes.map((index) => ({
        name: index.name,
        installed: true,
        indisvalid: true,
        indisready: true,
        identical: true,
        definition: index.definition,
      })),
    );
    expect(await readAccessPathLedgerRows(pool)).toEqual([{ migration_id: accessPathMigrationId }]);
    expect(await digestEvents(pool)).toMatchObject({ count: "0" });

    const unique = await pool.query<{ indisunique: boolean }>(
      "SELECT bool_or(indisunique) AS indisunique FROM pg_index WHERE indexrelid IN (SELECT to_regclass(n) FROM unnest($1::text[]) n)",
      [promotionReferenceIndexes.map((index) => index.name)],
    );
    expect(unique.rows).toEqual([{ indisunique: false }]);

    for (const row of promotionReferenceParityCorpus) {
      const result = await pool.query<{ sql: string; again: string }>(
        `SELECT ${promotionReferenceTextFunctionName}($1) AS sql, ${promotionReferenceTextFunctionName}(${promotionReferenceTextFunctionName}($1)) AS again`,
        [row.value],
      );
      expect(result.rows[0].sql, row.label).toBe(row.canonical);
      expect(result.rows[0].sql, row.label).toBe(canonical(row.value));
      expect(Buffer.from(result.rows[0].sql, "utf8").equals(Buffer.from(row.canonical, "utf8")), row.label).toBe(true);
      expect(result.rows[0].again, row.label).toBe(row.canonical);
    }
    const pairs = await pool.query<{ pairs: unknown; empty: unknown; scalar: unknown }>(
      `SELECT ${promotionReferenceFunctions[1].name}($1::jsonb) AS pairs,
              ${promotionReferenceFunctions[1].name}('{"name":"KEEP ME"}'::jsonb) AS empty,
              ${promotionReferenceFunctions[1].name}('"KEEP"'::jsonb) AS scalar`,
      [JSON.stringify({ ...rawSourceReferences, name: "Never Lowercased", extra: [{ providerKey: 1 }] })],
    );
    expect(pairs.rows[0].pairs).toEqual(canonicalPromotionReferencePairs(rawSourceReferences));
    expect(pairs.rows[0].pairs).toEqual({
      externalCatalogItemReferences: [{ providerKey: "tcgdex", externalKey: "swsh3-136" }],
      externalProductReferences: [
        { providerKey: "scrydex", externalKey: "i̇σtanbul" },
        { providerKey: "tcgplayer", externalKey: "same-key" },
      ],
    });
    expect(pairs.rows[0].empty).toEqual({ externalCatalogItemReferences: [], externalProductReferences: [] });
    expect(pairs.rows[0].scalar).toEqual({ externalCatalogItemReferences: [], externalProductReferences: [] });
  });

  it("installs the access paths over retained history, repeats boot, and never rewrites retained bytes", async () => {
    const pool = pools.catalog;
    await pool.query(catalogModule.schemaSql);
    const history = await appendRetainedHistory(pool);
    const before = await digestEvents(pool);
    expect(Number(before.count)).toBeGreaterThan(rawItemReferences.length * 3 + 2);
    expect((await readPromotionReferenceAccessPathReadiness(pool)).ready).toBe(false);

    await bootstrapContextDatabase(catalogModule, pool);
    expect(await digestEvents(pool)).toEqual(before);
    expect((await readPromotionReferenceAccessPathReadiness(pool)).ready).toBe(true);
    await bootstrapContextDatabase(catalogModule, pool);
    expect(await digestEvents(pool)).toEqual(before);
    expect((await readPromotionReferenceAccessPathReadiness(pool)).ready).toBe(true);
    expect(await readAccessPathLedgerRows(pool)).toHaveLength(1);

    // SQL C equals the item domain's stored canonical keys and the JS canonical of the raw input.
    for (const reference of history.itemEvents) {
      const result = await pool.query<{
        event_type: string;
        stored_provider: string;
        stored_key: string;
        provider: string;
        key: string;
      }>(
        `SELECT event_type, payload->>'providerKey' AS stored_provider, payload->>'externalKey' AS stored_key,
                ${promotionReferenceExpressions.providerKey} AS provider, ${promotionReferenceExpressions.externalKey} AS key
         FROM event_store_events WHERE stream_id = $1 AND event_type LIKE '%-reference-linked' ORDER BY stream_version`,
        [`catalog.item-${reference.itemId}`],
      );
      expect(result.rows.map((row) => row.event_type)).toEqual([
        "catalog.catalog-item.external-catalog-item-reference-linked",
        "catalog.catalog-item.external-product-reference-linked",
      ]);
      for (const row of result.rows) {
        expect(row.stored_provider).toBe(canonical(reference.providerKey));
        expect(row.stored_key).toBe(canonical(reference.externalKey));
        expect(row.provider).toBe(canonical(reference.providerKey));
        expect(row.key).toBe(canonical(reference.externalKey));
      }
    }
    // SQL N over inline and chunked mapper-derived headers equals JS N over the raw and the domain-normalized header.
    const expectedPairs = canonicalPromotionReferencePairs(rawSourceReferences);
    for (const [observationId, header] of [
      ["tcgdex_en_inline", history.sourceHeaders[0]],
      ["tcgdex_en_chunked", history.sourceHeaders[1]],
    ] as const) {
      const data = header.data as { normalized: unknown; languageCode: string; externalKey: string };
      const result = await pool.query<{ pairs: unknown; link: string; provider: string; chunked: boolean }>(
        `SELECT ${promotionReferenceExpressions.sourcePairs} AS pairs, ${promotionReferenceExpressions.sourceLink} AS link,
                ${promotionReferenceExpressions.providerKey} AS provider, payload ? 'sourcePayloadChunkCount' AS chunked
         FROM event_store_events WHERE stream_id = $1 AND event_type = 'catalog.source-observation.recorded'`,
        [`catalog.source-observation-${observationId}`],
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].chunked).toBe(observationId === "tcgdex_en_chunked");
      expect(result.rows[0].pairs).toEqual(expectedPairs);
      expect(result.rows[0].pairs).toEqual(canonicalPromotionReferencePairs(data.normalized));
      expect(result.rows[0].provider).toBe("tcgdex");
      expect(result.rows[0].link).toBe("en-us:swsh3-136");
      expect(result.rows[0].link).toBe(canonicalPromotionSourceLinkText(data.languageCode, data.externalKey));
      expect(result.rows[0].link).toBe(
        canonical(sourceObservationLinkExternalKey(data.languageCode, data.externalKey)),
      );
    }
    // Each family answers its exact canonical key through the shared query shapes.
    const itemStreams = await pool.query<{ stream_id: string }>(
      promotionReferenceKeyBoundedQueries.itemReference("item"),
      ["tcgdex", "swsh3-136"],
    );
    expect(itemStreams.rows.map((row) => row.stream_id).sort()).toEqual([
      "catalog.item-cat_promotion_ref_a",
      "catalog.item-cat_promotion_ref_b",
    ]);
    const productStreams = await pool.query<{ stream_id: string }>(
      promotionReferenceKeyBoundedQueries.itemReference("product"),
      ["scrydex", "i̇σtanbul"],
    );
    expect(productStreams.rows.map((row) => row.stream_id)).toEqual(["catalog.item-cat_promotion_ref_c"]);
    const headerStreams = await pool.query<{ stream_id: string }>(promotionReferenceKeyBoundedQueries.sourceHeader, [
      JSON.stringify({ externalProductReferences: [{ providerKey: "scrydex", externalKey: "i̇σtanbul" }] }),
    ]);
    expect(headerStreams.rows.map((row) => row.stream_id).sort()).toEqual([
      "catalog.source-observation-tcgdex_en_chunked",
      "catalog.source-observation-tcgdex_en_inline",
    ]);
    const linkStreams = await pool.query<{ stream_id: string }>(promotionReferenceKeyBoundedQueries.sourceLink, [
      "tcgdex",
      canonicalPromotionSourceLinkText("en-US", " SWSH3-136 "),
    ]);
    expect(linkStreams.rows.map((row) => row.stream_id).sort()).toEqual([
      "catalog.source-observation-tcgdex_en_chunked",
      "catalog.source-observation-tcgdex_en_inline",
    ]);
    expect(
      (await pool.query(promotionReferenceKeyBoundedQueries.itemReference("item"), ["tcgdex", "SWSH3-136"])).rows,
    ).toEqual([]);
  });

  it("repairs an interrupted invalid owned index on the next boot without rewriting retained bytes", async () => {
    const pool = pools.catalog;
    await bootstrapContextDatabase(catalogModule, pool);
    await appendRetainedHistory(pool);
    const before = await digestEvents(pool);

    await leaveInvalidIndex(pool, itemIndex.name);
    const drifted = await readPromotionReferenceAccessPathReadiness(pool);
    expect(drifted.ready).toBe(false);
    expect(drifted.failures).toContain(`index-invalid:${itemIndex.name}`);
    expect(drifted.failures).toContain(`index-definition-drift:${itemIndex.name}`);

    await deleteAccessPathLedgerRow(pool);
    await bootstrapContextDatabase(catalogModule, pool);
    const repaired = await readPromotionReferenceAccessPathReadiness(pool);
    expect(repaired.ready).toBe(true);
    expect(repaired.indexes.find((index) => index.name === itemIndex.name)).toMatchObject({
      indisvalid: true,
      indisready: true,
      identical: true,
    });
    expect(await digestEvents(pool)).toEqual(before);
    expect(await readAccessPathLedgerRows(pool)).toHaveLength(1);
  });

  it("refuses a valid index with another definition under an owned name and keeps it in place", async () => {
    const pool = pools.catalog;
    await bootstrapContextDatabase(catalogModule, pool);
    await appendRetainedHistory(pool);
    const before = await digestEvents(pool);

    await pool.query(`DROP INDEX ${sourceLinkIndex.name}`);
    await pool.query(`CREATE INDEX ${sourceLinkIndex.name} ON event_store_events (stream_id)`);
    const drifted = await readPromotionReferenceAccessPathReadiness(pool);
    expect(drifted.ready).toBe(false);
    expect(drifted.failures).toEqual([`index-definition-drift:${sourceLinkIndex.name}`]);
    expect(drifted.indexes.find((index) => index.name === sourceLinkIndex.name)).toMatchObject({
      indisvalid: true,
      indisready: true,
      identical: false,
      definition: "USING btree (stream_id)",
    });

    await deleteAccessPathLedgerRow(pool);
    await expect(bootstrapContextDatabase(catalogModule, pool)).rejects.toThrow(
      `catalog-promotion-reference-index-conflict:${sourceLinkIndex.name}`,
    );
    expect(await readAccessPathLedgerRows(pool)).toEqual([]);
    expect(
      (await pool.query("SELECT pg_get_indexdef(to_regclass($1)::oid) AS definition", [sourceLinkIndex.name])).rows[0]
        .definition,
    ).toContain("USING btree (stream_id)");
    expect(await digestEvents(pool)).toEqual(before);
  });

  it("refuses a valid UNIQUE B-tree with identical columns and predicate without dropping it or recording the migration", async () => {
    const pool = pools.catalog;
    await bootstrapContextDatabase(catalogModule, pool);
    await appendRetainedHistory(pool);
    const before = await digestEvents(pool);

    await pool.query(`DROP INDEX ${itemIndex.name}`);
    await pool.query(
      `CREATE UNIQUE INDEX CONCURRENTLY ${itemIndex.name} ON event_store_events USING ${itemIndex.method} ${itemIndex.columns} WHERE ${itemIndex.predicate}`,
    );
    const readConflict = () =>
      pool.query<{ oid: number; indisvalid: boolean; indisready: boolean; indisunique: boolean; definition: string }>(
        `SELECT i.indexrelid AS oid, i.indisvalid, i.indisready, i.indisunique,
                pg_get_indexdef(i.indexrelid) AS definition
         FROM pg_index i WHERE i.indexrelid = to_regclass($1)`,
        [itemIndex.name],
      );
    const conflict = await readConflict();
    expect(conflict.rows).toHaveLength(1);
    expect(conflict.rows[0]).toMatchObject({ indisvalid: true, indisready: true, indisunique: true });
    expect(conflict.rows[0].definition).toContain("CREATE UNIQUE INDEX");
    expect(conflict.rows[0].definition.slice(conflict.rows[0].definition.indexOf("USING "))).toBe(itemIndex.definition);
    const drifted = await readPromotionReferenceAccessPathReadiness(pool);
    expect(drifted.ready).toBe(false);
    expect(drifted.failures).toEqual([`index-definition-drift:${itemIndex.name}`]);
    expect(drifted.indexes.find((index) => index.name === itemIndex.name)).toMatchObject({
      installed: true,
      indisvalid: true,
      indisready: true,
      identical: false,
      definition: itemIndex.definition,
    });

    await deleteAccessPathLedgerRow(pool);
    await expect(bootstrapContextDatabase(catalogModule, pool)).rejects.toThrow(
      `catalog-promotion-reference-index-conflict:${itemIndex.name}`,
    );
    expect((await readConflict()).rows).toEqual(conflict.rows);
    expect(await readAccessPathLedgerRows(pool)).toEqual([]);
    expect(await digestEvents(pool)).toEqual(before);
  });

  it("refuses a pre-existing same-named function with another body instead of replacing it", async () => {
    const pool = pools.catalog;
    await pool.query(
      `CREATE FUNCTION ${promotionReferenceTextFunctionName}(value text) RETURNS text LANGUAGE sql IMMUTABLE AS 'SELECT lower(value)'`,
    );
    await expect(bootstrapContextDatabase(catalogModule, pool)).rejects.toThrow(
      `catalog-promotion-reference-function-conflict:${promotionReferenceTextFunctionName}`,
    );
    expect(await readAccessPathLedgerRows(pool)).toEqual([]);
    const readiness = await readPromotionReferenceAccessPathReadiness(pool);
    expect(readiness.failures[0]).toBe(`function-drift:${promotionReferenceTextFunctionName}`);
    expect(readiness.functions[0]).toMatchObject({ installed: true, identical: false });

    await pool.query(`DROP FUNCTION ${promotionReferenceTextFunctionName}(text)`);
    await bootstrapContextDatabase(catalogModule, pool);
    expect((await readPromotionReferenceAccessPathReadiness(pool)).ready).toBe(true);
  });

  it("reports an altered function body as not-ready and refuses to re-ledger over it", async () => {
    const pool = pools.catalog;
    await bootstrapContextDatabase(catalogModule, pool);
    await appendRetainedHistory(pool);
    const before = await digestEvents(pool);

    await pool.query(
      `CREATE OR REPLACE FUNCTION ${promotionReferenceTextFunctionName}(value text) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE SET ${promotionReferenceFunctionSearchPath} AS 'BEGIN RETURN value; END'`,
    );
    const drifted = await readPromotionReferenceAccessPathReadiness(pool);
    expect(drifted.ready).toBe(false);
    expect(drifted.failures).toEqual([`function-drift:${promotionReferenceTextFunctionName}`]);
    expect(drifted.functions[0]).toMatchObject({
      installed: true,
      identical: false,
      marker: promotionReferenceFunctionMarker,
    });
    await deleteAccessPathLedgerRow(pool);
    await expect(bootstrapContextDatabase(catalogModule, pool)).rejects.toThrow(
      `catalog-promotion-reference-function-conflict:${promotionReferenceTextFunctionName}`,
    );
    expect(await digestEvents(pool)).toEqual(before);

    await pool.query(
      `CREATE OR REPLACE FUNCTION ${textFunction.name}(value text) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE SET ${promotionReferenceFunctionSearchPath} AS ${sqlLiteral(textFunction.body)}`,
    );
    await bootstrapContextDatabase(catalogModule, pool);
    expect((await readPromotionReferenceAccessPathReadiness(pool)).ready).toBe(true);
  });

  it("reports a mismatched casing-data marker, a missing index and a runtime Unicode mismatch as not-ready without throwing", async () => {
    const pool = pools.catalog;
    await bootstrapContextDatabase(catalogModule, pool);

    await pool.query(
      `COMMENT ON FUNCTION ${promotionReferenceTextFunctionName}(text) IS 'catalog-promotion-reference v1; unicode 17.0; casing-data sha256 ${"0".repeat(64)}'`,
    );
    const marker = await readPromotionReferenceAccessPathReadiness(pool);
    expect(marker.ready).toBe(false);
    expect(marker.failures).toEqual([`function-marker-drift:${promotionReferenceTextFunctionName}`]);
    expect(marker.functions[0]).toMatchObject({ installed: true, identical: true });
    await pool.query(
      `COMMENT ON FUNCTION ${promotionReferenceTextFunctionName}(text) IS ${sqlLiteral(promotionReferenceFunctionMarker)}`,
    );
    expect((await readPromotionReferenceAccessPathReadiness(pool)).ready).toBe(true);

    await pool.query(`DROP INDEX ${sourceHeaderIndex.name}`);
    const missing = await readPromotionReferenceAccessPathReadiness(pool);
    expect(missing.ready).toBe(false);
    expect(missing.failures).toEqual([`index-missing:${sourceHeaderIndex.name}`]);
    expect(missing.indexes.find((index) => index.name === sourceHeaderIndex.name)).toEqual({
      name: sourceHeaderIndex.name,
      installed: false,
      indisvalid: false,
      indisready: false,
      identical: false,
      definition: null,
    });
    await deleteAccessPathLedgerRow(pool);
    await bootstrapContextDatabase(catalogModule, pool);
    expect((await readPromotionReferenceAccessPathReadiness(pool)).ready).toBe(true);

    const runtime = await readPromotionReferenceAccessPathReadiness(pool, "16.0");
    expect(runtime.ready).toBe(false);
    expect(runtime.failures).toEqual(["runtime-unicode-drift"]);
    expect(runtime.runtime).toEqual({ unicode: "16.0", pinnedUnicode: "17.0", casingDataHash: expect.any(String) });
  });

  it("answers every family key-bounded over a large retained table without an all-Catalog event-type scan", async () => {
    const pool = pools.catalog;
    await pool.query(catalogModule.schemaSql);
    await appendBulkRetainedRows(pool, 10_000);
    const history = await appendRetainedHistory(pool);
    const before = await digestEvents(pool);
    expect(Number(before.count)).toBeGreaterThan(30_000);

    await bootstrapContextDatabase(catalogModule, pool);
    expect(await digestEvents(pool)).toEqual(before);
    expect((await readPromotionReferenceAccessPathReadiness(pool)).ready).toBe(true);
    await pool.query("ANALYZE event_store_events");

    const plans = [
      {
        index: itemIndex,
        query: promotionReferenceKeyBoundedQueries.itemReference("item"),
        values: ["bulk", "key-4242"],
        expectedStreams: ["catalog.item-bulk-4242"],
      },
      {
        index: productIndex,
        query: promotionReferenceKeyBoundedQueries.itemReference("product"),
        values: ["bulk", "key-4241"],
        expectedStreams: ["catalog.item-bulk-4241"],
      },
      {
        index: sourceHeaderIndex,
        query: promotionReferenceKeyBoundedQueries.sourceHeader,
        values: [JSON.stringify({ externalCatalogItemReferences: [{ providerKey: "bulk", externalKey: "item-777" }] })],
        expectedStreams: ["catalog.source-observation-bulk-777"],
      },
      {
        index: sourceLinkIndex,
        query: promotionReferenceKeyBoundedQueries.sourceLink,
        values: ["bulk", "en:src-777"],
        expectedStreams: ["catalog.source-observation-bulk-777"],
      },
    ] as const;
    for (const plan of plans) {
      const nodes = await explain(pool, plan.query, plan.values);
      const scans = nodes.filter((node) => node["Relation Name"] === "event_store_events");
      expect(scans.length, plan.index.name).toBeGreaterThan(0);
      expect(
        scans.map((node) => node["Node Type"]),
        plan.index.name,
      ).not.toContain("Seq Scan");
      expect(
        nodes.some((node) => node["Index Name"] === plan.index.name),
        `${plan.index.name} ${JSON.stringify(nodes.map((node) => [node["Node Type"], node["Index Name"]]))}`,
      ).toBe(true);
      expect(
        nodes.some((node) => typeof node["Index Name"] === "string" && node["Index Name"] !== plan.index.name),
        plan.index.name,
      ).toBe(false);
      const rows = await pool.query<{ stream_id: string }>(plan.query, plan.values);
      expect(rows.rows.map((row) => row.stream_id)).toEqual(plan.expectedStreams);
    }
    // Unrelated retained rows under the same predicate stay out of a key-bounded answer.
    const unrelated = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM event_store_events WHERE ${promotionReferencePredicates.item}`,
    );
    expect(Number(unrelated.rows[0].count)).toBeGreaterThan(history.itemEvents.length);
  });

  it("upgrades the option cache in place and round-trips completed count metadata without changing display", async () => {
    const pool = pools.catalog;
    await bootstrapContextDatabase(catalogModule, pool);
    const request = {
      providerKey: "scrydex",
      profileKey: "synthetic-card-profile",
      profileVersion: "synthetic-v1",
      ingestionUnitKey: "synthetic-card-unit",
      queryKind: "cards",
      languageCode: "en",
      parentValue: "TFC",
    };
    const store = createPgCatalogProviderOptionQueryCacheStore(pool)!;
    const items = [
      {
        providerKey: "scrydex",
        queryKind: "cards",
        value: "synthetic-tfc-card",
        label: "Synthetic TFC card",
        description: null,
        parentValue: "TFC",
        imageUrl: null,
        aliases: [],
        metadata: {},
      },
    ];
    await queryCatalogProviderIntegrationOptionsWithCache({ request, cacheStore: store, loadLive: async () => items });
    await pool.query("ALTER TABLE catalog_provider_option_query_cache DROP COLUMN total_count, DROP COLUMN page_size");
    await pool.query(
      "DELETE FROM bounded_context_schema_migrations WHERE migration_id = '20261001_catalog_provider_option_query_cache_card_count'",
    );
    await bootstrapContextDatabase(catalogModule, pool);
    expect(await store.read(request)).toMatchObject({
      cacheKey: cacheKeyForProviderOptionQuery(request),
      items,
      itemCount: 1,
      totalCount: null,
      pageSize: null,
    });
    const migration = await pool.query<{ migration_id: string }>(
      "SELECT migration_id FROM bounded_context_schema_migrations WHERE migration_id = '20261001_catalog_provider_option_query_cache_card_count'",
    );
    expect(migration.rows).toEqual([{ migration_id: "20261001_catalog_provider_option_query_cache_card_count" }]);
    await queryCatalogProviderIntegrationOptionsWithCache({
      request: { ...request, forceRefresh: true },
      cacheStore: store,
      loadLive: async () => items,
      validatedPagination: () => ({ totalCount: 1, pageSize: 100 }),
    });
    expect(await store.read(request)).toMatchObject({ items, itemCount: 1, totalCount: 1, pageSize: 100 });
    await queryCatalogProviderIntegrationOptionsWithCache({
      request: { ...request, forceRefresh: true },
      cacheStore: store,
      loadLive: async () => items,
    });
    expect(await store.read(request)).toMatchObject({ items, itemCount: 1, totalCount: null, pageSize: null });
  });

  it("converges a deployed scope-sync table to the complete fresh schema", async () => {
    const pool = pools.catalog;
    await bootstrapContextDatabase(catalogModule, pool);
    const freshColumns = await readColumnNames(pool, "catalog_scope_sync_state");

    await pool.query("ALTER TABLE catalog_scope_sync_state DROP COLUMN scope_record_id");
    await pool.query(
      "DELETE FROM bounded_context_schema_migrations WHERE migration_id = '20260718_catalog_scope_sync_state_scope_record_id'",
    );
    await bootstrapContextDatabase(catalogModule, pool);

    expect(await readColumnNames(pool, "catalog_scope_sync_state")).toEqual(freshColumns);
    const migration = await pool.query<{ migration_id: string }>(
      "SELECT migration_id FROM bounded_context_schema_migrations WHERE migration_id = '20260718_catalog_scope_sync_state_scope_record_id'",
    );
    expect(migration.rows).toEqual([{ migration_id: "20260718_catalog_scope_sync_state_scope_record_id" }]);
  });
});
