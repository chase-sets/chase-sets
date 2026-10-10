import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PromotionReferenceKey } from "./promotion-target-identity";

const sourcePredicate =
  "stream_id LIKE 'catalog.source-observation-%' AND event_type IN ('catalog.source-observation.recorded', 'catalog.source-observation.changed', 'catalog.source-observation.refreshed')";
const itemPredicate = (level: "item" | "product") =>
  `stream_id LIKE 'catalog.item-%' AND event_type IN ('catalog.catalog-item.external-${level === "item" ? "catalog-item" : "product"}-reference-linked', 'catalog.catalog-item.external-${level === "item" ? "catalog-item" : "product"}-reference-unlinked')`;
const sourceLinkExpression = "((payload->>'languageCode') || ':' || (payload->>'externalKey'))";
const indexes = [
  {
    name: "catalog_promotion_item_reference_idx",
    method: "btree",
    columns: "((payload->>'providerKey'), (payload->>'externalKey'), stream_id, stream_version)",
    predicate: itemPredicate("item"),
  },
  {
    name: "catalog_promotion_product_reference_idx",
    method: "btree",
    columns: "((payload->>'providerKey'), (payload->>'externalKey'), stream_id, stream_version)",
    predicate: itemPredicate("product"),
  },
  {
    name: "catalog_promotion_source_references_idx",
    method: "gin",
    columns: "((payload->'normalized') jsonb_path_ops)",
    predicate: sourcePredicate,
  },
  {
    name: "catalog_promotion_source_link_idx",
    method: "btree",
    columns: `((payload->>'providerKey'), ${sourceLinkExpression}, stream_id, stream_version)`,
    predicate: sourcePredicate,
  },
] as const;

// A failed concurrent build can leave its name behind. Only invalid owned indexes
// are removed; valid objects with the wrong definition fail closed below.
export const promotionTargetIndexMigrations = [
  {
    migrationId: "20261010_catalog_promotion_target_discovery",
    description: "Install authoritative Catalog promotion target discovery indexes before writer activation.",
    statements: indexes.flatMap((index) => [
      `DO $repair$ BEGIN IF EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = to_regclass('${index.name}') AND NOT indisvalid) THEN EXECUTE 'DROP INDEX ${index.name}'; END IF; END $repair$`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${index.name} ON event_store_events USING ${index.method} ${index.columns} WHERE ${index.predicate}`,
      `DO $verify$ BEGIN IF NOT EXISTS (
        SELECT 1 FROM pg_index WHERE indexrelid = to_regclass('${index.name}')
        AND indrelid = 'event_store_events'::regclass AND indisvalid AND indisready
        AND translate(replace(substring(pg_get_indexdef(indexrelid) FROM 'USING .*'), '::text', ''), E' \\t\\n\\r()[]', '')
          = '${normalizeIndexDefinition(`USING ${index.method} ${index.columns} WHERE ${index.predicate}`).replaceAll("'", "''")}'
      ) THEN RAISE EXCEPTION 'promotion-target-index-unavailable:${index.name}'; END IF; END $verify$`,
    ]),
  },
] as const;

export async function requirePromotionTargetIndexes(db: PgQueryable): Promise<void> {
  const result = await db.query<{ name: string; valid: boolean; definition: string }>(
    `SELECT c.relname AS name, (i.indisvalid AND i.indisready) AS valid, pg_get_indexdef(i.indexrelid) AS definition
     FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE i.indrelid = 'event_store_events'::regclass AND c.relname = ANY($1::text[])`,
    [indexes.map((index) => index.name)],
  );
  for (const index of indexes) {
    const found = result.rows.filter((row) => row.name === index.name);
    const expected = `USING ${index.method} ${index.columns} WHERE ${index.predicate}`;
    if (
      found.length !== 1 ||
      !found[0].valid ||
      normalizeIndexDefinition(found[0].definition.slice(found[0].definition.indexOf("USING "))) !==
        normalizeIndexDefinition(expected)
    ) {
      throw new Error(`promotion-target-index-unavailable:${index.name}`);
    }
  }
}

function normalizeIndexDefinition(value: string): string {
  return value
    .replaceAll("::text", "")
    .replace(/\bLIKE\b/g, "~~")
    .replace(/\s+IN\s+/g, "=ANYARRAY")
    .replace(/[\s()[\]]/g, "");
}

export async function locatePromotionReferenceStreams(
  db: PgQueryable,
  key: PromotionReferenceKey,
): Promise<readonly string[]> {
  const queries: readonly { predicate: string; match: string; values: readonly unknown[] }[] = [
    {
      predicate: itemPredicate(key.level),
      match: "payload->>'providerKey' = $1 AND payload->>'externalKey' = $2",
      values: [key.providerKey, key.externalKey],
    },
    {
      predicate: sourcePredicate,
      match: "payload->'normalized' @> $1::jsonb",
      values: [
        JSON.stringify({
          [key.level === "item" ? "externalCatalogItemReferences" : "externalProductReferences"]: [
            { providerKey: key.providerKey, externalKey: key.externalKey },
          ],
        }),
      ],
    },
    ...(key.level === "product"
      ? [
          {
            predicate: sourcePredicate,
            match: `payload->>'providerKey' = $1 AND ${sourceLinkExpression} = $2`,
            values: [key.providerKey, key.externalKey],
          },
        ]
      : []),
  ];
  const streams = new Set<string>();
  for (const query of queries) {
    let after = "";
    for (;;) {
      const page = await db.query<{ stream_id: string }>(
        `SELECT DISTINCT stream_id FROM event_store_events WHERE ${query.predicate} AND ${query.match}
         AND stream_id > $${query.values.length + 1} ORDER BY stream_id LIMIT 500`,
        [...query.values, after],
      );
      if (page.rows.length > 500) throw new Error("promotion-target-invalid-page");
      for (const row of page.rows) {
        if (typeof row.stream_id !== "string" || row.stream_id <= after)
          throw new Error("promotion-target-invalid-page");
        after = row.stream_id;
        streams.add(after);
        if (streams.size > 10000) throw new Error("promotion-target-discovery-budget-exceeded");
      }
      if (page.rows.length < 500) break;
    }
  }
  return [...streams];
}
