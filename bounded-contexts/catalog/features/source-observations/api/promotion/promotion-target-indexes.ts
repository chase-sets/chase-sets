import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  promotionReferenceCasingDataHash,
  promotionReferenceCasingVersion,
  promotionReferenceFunctionIdentitySql,
  promotionReferenceFunctionMarker,
  promotionReferenceFunctionSignature,
  promotionReferenceFunctionStatements,
  promotionReferenceFunctions,
  promotionReferencePairsFunctionName,
  promotionReferenceTextFunctionName,
  promotionReferenceTrimCharacters,
  promotionReferenceUnicodeVersion,
} from "./promotion-reference-canonicalization";

/**
 * Dormant canonical promotion-reference access paths.
 *
 * Three index families over retained `event_store_events` rows locate targets by
 * canonical `(level, C(providerKey), C(externalKey))` without an all-Catalog
 * event-type scan. Nothing here reads or writes at runtime; the core slice (D)
 * is the first consumer and wires the readiness report.
 */
const sqlLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;
const inList = (values: readonly string[]) => values.map(sqlLiteral).join(", ");

export const promotionReferenceItemEventTypes = {
  item: [
    "catalog.catalog-item.external-catalog-item-reference-linked",
    "catalog.catalog-item.external-catalog-item-reference-unlinked",
  ],
  product: [
    "catalog.catalog-item.external-product-reference-linked",
    "catalog.catalog-item.external-product-reference-unlinked",
  ],
} as const;

/** Inline and chunked headers share these types; payload chunks carry no `normalized`. */
export const promotionReferenceSourceHeaderEventTypes = [
  "catalog.source-observation.recorded",
  "catalog.source-observation.changed",
  "catalog.source-observation.refreshed",
] as const;

export const promotionReferencePredicates = {
  item: `stream_id LIKE 'catalog.item-%' AND event_type IN (${inList(promotionReferenceItemEventTypes.item)})`,
  product: `stream_id LIKE 'catalog.item-%' AND event_type IN (${inList(promotionReferenceItemEventTypes.product)})`,
  source: `stream_id LIKE 'catalog.source-observation-%' AND event_type IN (${inList(promotionReferenceSourceHeaderEventTypes)})`,
} as const;

const canonical = (expression: string) => `${promotionReferenceTextFunctionName}(${expression}) COLLATE "C"`;

/** Index-side expressions; a query must repeat them verbatim to stay key-bounded. */
export const promotionReferenceExpressions = {
  providerKey: canonical("payload->>'providerKey'"),
  externalKey: canonical("payload->>'externalKey'"),
  sourcePairs: `${promotionReferencePairsFunctionName}(payload->'normalized')`,
  sourceLink: canonical(
    `(payload->>'languageCode') || ':' || btrim(payload->>'externalKey', ${sqlLiteral(promotionReferenceTrimCharacters)})`,
  ),
} as const;

export type PromotionReferenceIndexFamily = "item-reference" | "product-reference" | "source-header" | "source-link";

export type PromotionReferenceIndex = Readonly<{
  name: string;
  family: PromotionReferenceIndexFamily;
  method: "btree" | "gin";
  columns: string;
  predicate: string;
  /** `pg_get_indexdef` from `USING` onward as PostgreSQL 16 renders this definition. */
  definition: string;
}>;

const version = `v${promotionReferenceCasingVersion}`;
const textFn = promotionReferenceTextFunctionName;
const pairsFn = promotionReferencePairsFunctionName;
const renderedTrim = sqlLiteral(promotionReferenceTrimCharacters);
const renderedTypes = (types: readonly string[]) =>
  `= ANY (ARRAY[${types.map((type) => `${sqlLiteral(type)}::text`).join(", ")}])`;
const renderedItemPredicate = (level: "item" | "product") =>
  `WHERE ((stream_id ~~ 'catalog.item-%'::text) AND (event_type ${renderedTypes(promotionReferenceItemEventTypes[level])}))`;
const renderedSourcePredicate = `WHERE ((stream_id ~~ 'catalog.source-observation-%'::text) AND (event_type ${renderedTypes(promotionReferenceSourceHeaderEventTypes)}))`;
const renderedProviderKey = `${textFn}((payload ->> 'providerKey'::text)) COLLATE "C"`;
const renderedExternalKey = `${textFn}((payload ->> 'externalKey'::text)) COLLATE "C"`;

export const promotionReferenceIndexes: readonly PromotionReferenceIndex[] = [
  {
    name: `catalog_promotion_item_reference_${version}_idx`,
    family: "item-reference",
    method: "btree",
    columns: `(${promotionReferenceExpressions.providerKey}, ${promotionReferenceExpressions.externalKey}, stream_id, stream_version)`,
    predicate: promotionReferencePredicates.item,
    definition: `USING btree (${renderedProviderKey}, ${renderedExternalKey}, stream_id, stream_version) ${renderedItemPredicate("item")}`,
  },
  {
    name: `catalog_promotion_product_reference_${version}_idx`,
    family: "product-reference",
    method: "btree",
    columns: `(${promotionReferenceExpressions.providerKey}, ${promotionReferenceExpressions.externalKey}, stream_id, stream_version)`,
    predicate: promotionReferencePredicates.product,
    definition: `USING btree (${renderedProviderKey}, ${renderedExternalKey}, stream_id, stream_version) ${renderedItemPredicate("product")}`,
  },
  {
    name: `catalog_promotion_source_reference_pairs_${version}_idx`,
    family: "source-header",
    method: "gin",
    columns: `(${promotionReferenceExpressions.sourcePairs} jsonb_path_ops)`,
    predicate: promotionReferencePredicates.source,
    definition: `USING gin (${pairsFn}((payload -> 'normalized'::text)) jsonb_path_ops) ${renderedSourcePredicate}`,
  },
  {
    name: `catalog_promotion_source_link_${version}_idx`,
    family: "source-link",
    method: "btree",
    columns: `(${promotionReferenceExpressions.providerKey}, ${promotionReferenceExpressions.sourceLink}, stream_id, stream_version)`,
    predicate: promotionReferencePredicates.source,
    definition: `USING btree (${renderedProviderKey}, ${textFn}((((payload ->> 'languageCode'::text) || ':'::text) || btrim((payload ->> 'externalKey'::text), ${renderedTrim}::text))) COLLATE "C", stream_id, stream_version) ${renderedSourcePredicate}`,
  },
];

/**
 * Key-bounded access plans each family answers. These are the exact query shapes
 * whose `EXPLAIN` plans the schema-upgrade proof captures; a consumer that repeats
 * them stays on the index.
 */
export const promotionReferenceKeyBoundedQueries = {
  itemReference: (level: "item" | "product") =>
    `SELECT stream_id, stream_version FROM event_store_events
     WHERE ${promotionReferencePredicates[level]}
       AND ${promotionReferenceExpressions.providerKey} = $1 AND ${promotionReferenceExpressions.externalKey} = $2`,
  sourceHeader: `SELECT stream_id, stream_version FROM event_store_events
     WHERE ${promotionReferencePredicates.source}
       AND ${promotionReferenceExpressions.sourcePairs} @> $1::jsonb`,
  sourceLink: `SELECT stream_id, stream_version FROM event_store_events
     WHERE ${promotionReferencePredicates.source}
       AND ${promotionReferenceExpressions.providerKey} = $1 AND ${promotionReferenceExpressions.sourceLink} = $2`,
} as const;

const indexDefinitionSql = "substring(pg_get_indexdef(i.indexrelid) FROM 'USING .*')";

/**
 * Restartable and outside any transaction: the runner executes one statement per
 * query on a single session. An interrupted concurrent build leaves an invalid
 * owned index behind, which the repair step drops before `IF NOT EXISTS` runs,
 * because `IF NOT EXISTS` never certifies validity. A valid index under the same
 * name with any other definition is refused, never dropped.
 */
export const catalogPromotionReferenceAccessPathMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: `20261010_catalog_promotion_reference_access_paths_${version}`,
    description: "catalog.promotion-reference-access-paths-v1",
    statements: [
      "SET lock_timeout = '5s';",
      ...promotionReferenceFunctionStatements,
      ...promotionReferenceIndexes.flatMap((index) => [
        `DO $repair$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indexrelid = to_regclass(${sqlLiteral(index.name)})
      AND i.indrelid = to_regclass('event_store_events') AND NOT i.indisvalid
  ) THEN
    EXECUTE ${sqlLiteral(`DROP INDEX ${index.name}`)};
  END IF;
END $repair$`,
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${index.name}
  ON event_store_events USING ${index.method} ${index.columns}
  WHERE ${index.predicate}`,
        `DO $verify$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indexrelid = to_regclass(${sqlLiteral(index.name)})
      AND i.indrelid = to_regclass('event_store_events') AND i.indisvalid AND i.indisready
      AND ${indexDefinitionSql} = ${sqlLiteral(index.definition)}
  ) THEN
    RAISE EXCEPTION 'catalog-promotion-reference-index-conflict:${index.name}';
  END IF;
END $verify$`,
      ]),
    ],
  },
];

export type PromotionReferenceAccessPathReadiness = Readonly<{
  ready: boolean;
  version: number;
  failures: readonly string[];
  runtime: Readonly<{ unicode: string; pinnedUnicode: string; casingDataHash: string }>;
  environment: Readonly<{ serverEncoding: string | null; cCollationVersionless: boolean | null }>;
  functions: readonly Readonly<{ name: string; installed: boolean; identical: boolean; marker: string | null }>[];
  indexes: readonly Readonly<{
    name: string;
    installed: boolean;
    indisvalid: boolean;
    indisready: boolean;
    identical: boolean;
    definition: string | null;
  }>[];
}>;

/**
 * Reports whether every access path is installed, valid, ready, definition-identical
 * and generated from the runtime's pinned casing data. Drift is reported as
 * not-ready; this never throws, so a boot-time caller cannot be taken down by it.
 */
export async function readPromotionReferenceAccessPathReadiness(
  db: PgQueryable,
  unicode: string | undefined = process.versions.unicode,
): Promise<PromotionReferenceAccessPathReadiness> {
  const failures: string[] = [];
  const runtime = {
    unicode: unicode ?? "unknown",
    pinnedUnicode: promotionReferenceUnicodeVersion,
    casingDataHash: promotionReferenceCasingDataHash,
  };
  if (unicode !== promotionReferenceUnicodeVersion) failures.push("runtime-unicode-drift");
  let environment: PromotionReferenceAccessPathReadiness["environment"] = {
    serverEncoding: null,
    cCollationVersionless: null,
  };
  const functions: Array<PromotionReferenceAccessPathReadiness["functions"][number]> = [];
  const indexes: Array<PromotionReferenceAccessPathReadiness["indexes"][number]> = [];
  try {
    const environmentResult = await db.query<{ server_encoding: string; c_collation_versionless: boolean }>(
      `SELECT current_setting('server_encoding') AS server_encoding,
              EXISTS (
                SELECT 1 FROM pg_collation
                WHERE oid = '"C"'::regcollation AND collprovider = 'c'
                  AND collversion IS NULL AND pg_collation_actual_version(oid) IS NULL
              ) AS c_collation_versionless`,
    );
    const environmentRow = environmentResult.rows[0];
    environment = {
      serverEncoding: environmentRow?.server_encoding ?? null,
      cCollationVersionless: environmentRow?.c_collation_versionless ?? null,
    };
    if (environment.serverEncoding !== "UTF8" || environment.cCollationVersionless !== true) {
      failures.push("environment-drift");
    }
    for (const fn of promotionReferenceFunctions) {
      const result = await db.query<{ identical: boolean; marker: string | null }>(
        `SELECT (${promotionReferenceFunctionIdentitySql(fn)}) AS identical,
                obj_description(p.oid, 'pg_proc') AS marker
         FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
         WHERE p.oid = to_regprocedure($1)`,
        [promotionReferenceFunctionSignature(fn)],
      );
      const row = result.rows[0];
      const entry = {
        name: fn.name,
        installed: row !== undefined,
        identical: row?.identical === true,
        marker: row?.marker ?? null,
      };
      functions.push(entry);
      if (!entry.installed) failures.push(`function-missing:${fn.name}`);
      else if (!entry.identical) failures.push(`function-drift:${fn.name}`);
      else if (entry.marker !== promotionReferenceFunctionMarker) failures.push(`function-marker-drift:${fn.name}`);
    }
    const indexResult = await db.query<{
      name: string;
      indisvalid: boolean;
      indisready: boolean;
      definition: string | null;
    }>(
      `SELECT c.relname AS name, i.indisvalid, i.indisready, ${indexDefinitionSql} AS definition
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE i.indrelid = to_regclass('event_store_events') AND c.relname = ANY($1::text[])`,
      [promotionReferenceIndexes.map((index) => index.name)],
    );
    for (const index of promotionReferenceIndexes) {
      const rows = indexResult.rows.filter((row) => row.name === index.name);
      const row = rows.length === 1 ? rows[0] : undefined;
      const entry = {
        name: index.name,
        installed: row !== undefined,
        indisvalid: row?.indisvalid === true,
        indisready: row?.indisready === true,
        identical: row?.definition === index.definition,
        definition: row?.definition ?? null,
      };
      indexes.push(entry);
      if (!entry.installed) failures.push(`index-missing:${index.name}`);
      else {
        if (!entry.indisvalid) failures.push(`index-invalid:${index.name}`);
        if (!entry.indisready) failures.push(`index-not-ready:${index.name}`);
        if (!entry.identical) failures.push(`index-definition-drift:${index.name}`);
      }
    }
  } catch (error) {
    failures.push(`readiness-query-failed:${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    ready: failures.length === 0,
    version: promotionReferenceCasingVersion,
    failures,
    runtime,
    environment,
    functions,
    indexes,
  };
}
