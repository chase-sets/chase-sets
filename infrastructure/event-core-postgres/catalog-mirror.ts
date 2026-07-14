import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import { extractIdFromStreamId } from "@chase-sets/event-core";
import { coerceLocalizedTextMap, resolveLocalizedTextMap, type LocalizedTextMap } from "@chase-sets/localization";
import type { PgQueryable } from "./types";
import { assertSqlIdentifier } from "./sql-identifier";

export const CATALOG_ITEM_STREAM_PREFIX = "catalog.item-";
export const CATALOG_BLUEPRINT_STREAM_PREFIX = "catalog.blueprint-";
export const CATALOG_DIMENSION_STREAM_PREFIX = "catalog.dimension-";

export function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function asStringArray(value: unknown): string[] {
  return asArray<unknown>(value).filter((entry): entry is string => typeof entry === "string");
}

export function coerceDimensionOptionLabel(value: unknown): LocalizedTextMap {
  if (Array.isArray(value)) {
    return coerceLocalizedTextMap({
      defaultLocale: "en",
      values: Object.fromEntries(
        value
          .map((entry) => {
            if (typeof entry !== "object" || entry === null) {
              return null;
            }

            const candidate = entry as { locale?: unknown; value?: unknown };
            return typeof candidate.locale === "string" && typeof candidate.value === "string"
              ? [candidate.locale, candidate.value]
              : null;
          })
          .filter((entry): entry is [string, string] => entry !== null),
      ),
    });
  }

  return coerceLocalizedTextMap(value);
}

export async function loadNameMap(
  db: PgQueryable,
  table: string,
  idColumn: string,
  nameColumn: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) {
    return new Map();
  }

  const result = await db.query<Record<string, string>>(
    `SELECT ${idColumn} AS id, ${nameColumn} AS name FROM ${table} WHERE ${idColumn} = ANY($1)`,
    [ids],
  );

  return new Map(result.rows.map((row) => [row.id, row.name]));
}

export type CatalogMirrorTables = Readonly<{
  items: string;
  blueprints: string;
  dimensions: string;
  dimensionOptions: string;
}>;

export function catalogMirrorTables(tablePrefix: string): CatalogMirrorTables {
  assertSqlIdentifier(tablePrefix);

  return {
    items: `${tablePrefix}_items`,
    blueprints: `${tablePrefix}_blueprints`,
    dimensions: `${tablePrefix}_dimensions`,
    dimensionOptions: `${tablePrefix}_dimension_options`,
  };
}

type DimensionRule = Readonly<{
  dimensionId: string;
  required: boolean;
  allowedOptionIds?: string[];
  appliesWhen?: Array<{ dimensionId: string; optionIds?: string[] }>;
}>;

type CatalogMirrorItemRow = Readonly<{
  catalog_item_id: string;
  language_code: string;
  title: string;
  subtitle: string | null;
  blueprint_id: string | null;
  status: string;
  updated_at: string;
}>;

type CatalogMirrorBlueprintRow = Readonly<{
  blueprint_id: string;
  name: string;
  dimension_rules: unknown;
  canonical_dimension_order: unknown;
}>;

type CatalogMirrorChoiceRow = Readonly<{
  option_id: string;
  code: string;
  label_i18n: unknown;
  label: string;
}>;

type CatalogItemDisplayIdentityResolvedEventData = Readonly<{
  catalogItemId: string;
  languageCode?: string;
  title: string;
  subtitle?: string | null;
}>;

export async function buildVersionSchema(
  db: PgQueryable,
  tables: CatalogMirrorTables,
  blueprintId: string,
): Promise<unknown | null> {
  const blueprintResult = await db.query<CatalogMirrorBlueprintRow>(
    `SELECT * FROM ${tables.blueprints} WHERE blueprint_id = $1`,
    [blueprintId],
  );
  const blueprint = blueprintResult.rows[0];

  if (!blueprint) {
    return null;
  }

  const dimensionRules = asArray<DimensionRule>(blueprint.dimension_rules);
  const canonicalDimensionOrder = asStringArray(blueprint.canonical_dimension_order);
  const dimensionIds = [
    ...new Set([
      ...dimensionRules.map((rule) => rule.dimensionId),
      ...dimensionRules.flatMap((rule) => (rule.appliesWhen ?? []).map((clause) => clause.dimensionId)),
      ...canonicalDimensionOrder,
    ]),
  ];
  const optionIds = dimensionRules.flatMap((rule) => [
    ...(rule.allowedOptionIds ?? []),
    ...(rule.appliesWhen ?? []).flatMap((clause) => clause.optionIds ?? []),
  ]);

  const dimensionNames = await loadNameMap(db, tables.dimensions, "dimension_id", "name", dimensionIds);
  const choiceRows =
    optionIds.length > 0
      ? (
          await db.query<CatalogMirrorChoiceRow>(
            `SELECT option_id, code, label_i18n, label
           FROM ${tables.dimensionOptions}
           WHERE option_id = ANY($1)`,
            [optionIds],
          )
        ).rows
      : [];

  const choiceMap = new Map(choiceRows.map((row) => [row.option_id, row]));

  return {
    canonicalDimensionOrder: canonicalDimensionOrder.map((dimensionId) => ({
      dimensionId,
      dimensionName: dimensionNames.get(dimensionId) ?? dimensionId,
    })),
    dimensions: dimensionRules.map((rule) => ({
      dimensionId: rule.dimensionId,
      dimensionName: dimensionNames.get(rule.dimensionId) ?? rule.dimensionId,
      required: rule.required,
      appliesWhen: (rule.appliesWhen ?? []).map((clause) => ({
        dimensionId: clause.dimensionId,
        optionIds: clause.optionIds ?? [],
      })),
      allowedOptions: (rule.allowedOptionIds ?? []).map((optionId) => {
        const detail = choiceMap.get(optionId);

        return {
          optionId,
          code: detail?.code ?? optionId,
          label_i18n: detail?.label_i18n ?? coerceLocalizedTextMap(detail?.label ?? optionId),
          label: detail?.label ?? detail?.code ?? optionId,
        };
      }),
    })),
  };
}

export type CatalogMirrorSpec = Readonly<{
  /** Prefix for the four mirror tables: `<prefix>_items`, `<prefix>_blueprints`, `<prefix>_dimensions`, `<prefix>_dimension_options`. */
  tablePrefix: string;
  /** Read-model status written by the catalog-item lifecycle handlers. */
  itemStatusTransitions?: Readonly<{
    published?: string;
    retired?: string;
    archived?: string;
  }>;
  /** Re-derive the item's product schema after a catalog-item publish (default false). */
  refreshProductSchemaOnItemPublished?: boolean;
  /** Seed and preserve a draft/active status column on blueprint upserts (default true). */
  blueprintDraftStatusOnUpsert?: boolean;
  /** Shared-shape handlers that only some consumers subscribe to. */
  optionalHandlers?: Readonly<{
    metadataRevised?: boolean;
    displayIdentityResolved?: boolean;
  }>;
}>;

const MIRROR_STATUS_RE = /^[a-z][a-z0-9_-]*$/;

function assertMirrorStatus(status: string): string {
  if (!MIRROR_STATUS_RE.test(status)) {
    throw new Error(
      `Invalid catalog mirror status "${status}". Use lowercase letters, numbers, hyphens, and underscores.`,
    );
  }

  return status;
}

async function refreshCatalogMirrorItem(db: PgQueryable, tables: CatalogMirrorTables, itemId: string): Promise<void> {
  const result = await db.query<CatalogMirrorItemRow>(
    `SELECT catalog_item_id, language_code, title, subtitle, blueprint_id, status, updated_at
     FROM ${tables.items}
     WHERE catalog_item_id = $1`,
    [itemId],
  );
  const item = result.rows[0];

  if (!item) {
    return;
  }

  const productSchema = item.blueprint_id ? await buildVersionSchema(db, tables, item.blueprint_id) : null;

  await db.query(
    `UPDATE ${tables.items}
     SET product_schema = $2,
         updated_at = $3
     WHERE catalog_item_id = $1`,
    [itemId, productSchema === null ? null : JSON.stringify(productSchema), item.updated_at],
  );
}

async function refreshCatalogMirrorItemsByBlueprint(
  db: PgQueryable,
  tables: CatalogMirrorTables,
  blueprintId: string,
): Promise<void> {
  const productSchema = await buildVersionSchema(db, tables, blueprintId);
  const serializedProductSchema = productSchema === null ? null : JSON.stringify(productSchema);

  // Product schemas are blueprint-owned, so every item assigned to the same
  // blueprint receives the same value. Keep structural Catalog events set-based:
  // imported catalogs can contain tens of thousands of matching items, and
  // rebuilding the identical schema once per item cannot fit in one projection
  // transaction. Avoid rewriting rows that already contain the derived schema so
  // replaying a subscription version stays cheap on long-lived environments.
  await db.query(
    `UPDATE ${tables.items}
     SET product_schema = $2::jsonb
     WHERE blueprint_id = $1
       AND product_schema IS DISTINCT FROM $2::jsonb`,
    [blueprintId, serializedProductSchema],
  );
}

async function findBlueprintIdsByDimension(
  db: PgQueryable,
  tables: CatalogMirrorTables,
  dimensionId: string,
): Promise<string[]> {
  const result = await db.query<{ blueprint_id: string }>(
    `SELECT blueprint_id
     FROM ${tables.blueprints}
     WHERE dimension_rules @> $1::jsonb
        OR canonical_dimension_order @> $2::jsonb
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(dimension_rules) AS rule
          WHERE EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(rule->'appliesWhen', '[]'::jsonb)) AS clause
            WHERE clause->>'dimensionId' = $3
          )
        )
     ORDER BY blueprint_id ASC`,
    [JSON.stringify([{ dimensionId }]), JSON.stringify([dimensionId]), dimensionId],
  );

  return result.rows.map((row) => row.blueprint_id);
}

async function findBlueprintIdsByDimensionOption(
  db: PgQueryable,
  tables: CatalogMirrorTables,
  optionId: string,
): Promise<string[]> {
  const result = await db.query<{ blueprint_id: string }>(
    `SELECT blueprint_id
     FROM ${tables.blueprints}
     WHERE EXISTS (
       SELECT 1
       FROM jsonb_array_elements(dimension_rules) AS rule
       WHERE (rule->'allowedOptionIds') @> to_jsonb(ARRAY[$1]::text[])
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(rule->'appliesWhen', '[]'::jsonb)) AS clause
            WHERE (clause->'optionIds') @> to_jsonb(ARRAY[$1]::text[])
          )
     )
     ORDER BY blueprint_id ASC`,
    [optionId],
  );

  return result.rows.map((row) => row.blueprint_id);
}

async function refreshCatalogMirrorItemsByBlueprintIds(
  db: PgQueryable,
  tables: CatalogMirrorTables,
  blueprintIds: readonly string[],
): Promise<void> {
  for (const blueprintId of new Set(blueprintIds)) {
    await refreshCatalogMirrorItemsByBlueprint(db, tables, blueprintId);
  }
}

export function buildCatalogMirrorProjectionHandlers(db: PgQueryable, spec: CatalogMirrorSpec): ProjectorHandlerMap {
  const tables = catalogMirrorTables(spec.tablePrefix);
  const publishedStatus = assertMirrorStatus(spec.itemStatusTransitions?.published ?? "active");
  const retiredStatus = assertMirrorStatus(spec.itemStatusTransitions?.retired ?? "archived");
  const archivedStatus = assertMirrorStatus(spec.itemStatusTransitions?.archived ?? "archived");
  const blueprintDraftStatusOnUpsert = spec.blueprintDraftStatusOnUpsert ?? true;

  function setItemStatusHandler(status: string) {
    return async (event: Readonly<{ streamId: string; timing: Readonly<{ recordedAt: string }> }>) => {
      const itemId = extractIdFromStreamId(event.streamId, CATALOG_ITEM_STREAM_PREFIX);

      await db.query(
        `UPDATE ${tables.items}
         SET status = $2,
             updated_at = $3
         WHERE catalog_item_id = $1`,
        [itemId, status, event.timing.recordedAt],
      );
    };
  }

  async function upsertDimension(dimensionId: string, name: unknown, recordedAt: string): Promise<void> {
    const resolvedName = resolveLocalizedTextMap(coerceLocalizedTextMap(name));

    await db.query(
      `INSERT INTO ${tables.dimensions} (
         dimension_id,
         name,
         updated_at
       ) VALUES ($1, $2, $3)
       ON CONFLICT (dimension_id) DO UPDATE SET
         name = EXCLUDED.name,
         updated_at = EXCLUDED.updated_at`,
      [dimensionId, resolvedName, recordedAt],
    );

    await refreshCatalogMirrorItemsByBlueprintIds(
      db,
      tables,
      await findBlueprintIdsByDimension(db, tables, dimensionId),
    );
  }

  async function upsertDimensionOption(
    event: Readonly<{ streamId: string; data: unknown; timing: Readonly<{ recordedAt: string }> }>,
  ): Promise<void> {
    const dimensionId = extractIdFromStreamId(event.streamId, CATALOG_DIMENSION_STREAM_PREFIX);
    const { optionId, code, label, labels } = event.data as {
      optionId: string;
      code: string;
      label?: unknown;
      labels?: unknown;
    };
    const labelI18n = coerceDimensionOptionLabel(label ?? labels);

    await db.query(
      `INSERT INTO ${tables.dimensionOptions} (
         option_id,
         dimension_id,
         code,
         label_i18n,
         label,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (option_id) DO UPDATE SET
         dimension_id = EXCLUDED.dimension_id,
         code = EXCLUDED.code,
         label_i18n = EXCLUDED.label_i18n,
         label = EXCLUDED.label,
         updated_at = EXCLUDED.updated_at`,
      [
        optionId,
        dimensionId,
        code,
        JSON.stringify(labelI18n),
        resolveLocalizedTextMap(labelI18n),
        event.timing.recordedAt,
      ],
    );

    await refreshCatalogMirrorItemsByBlueprintIds(
      db,
      tables,
      await findBlueprintIdsByDimensionOption(db, tables, optionId),
    );
  }

  const handlers: Record<string, ProjectorHandlerMap[string]> = {
    "catalog.catalog-item.created": async (event) => {
      const { itemId, languageCode, title, subtitle } = event.data as {
        itemId: string;
        languageCode?: string;
        title: string | LocalizedTextMap;
        subtitle?: string | LocalizedTextMap | null;
      };
      const titleText = resolveLocalizedTextMap(coerceLocalizedTextMap(title));
      const subtitleText =
        subtitle === null || subtitle === undefined
          ? null
          : resolveLocalizedTextMap(coerceLocalizedTextMap(subtitle)) || null;

      await db.query(
        `INSERT INTO ${tables.items} (
           catalog_item_id,
           language_code,
           title,
           subtitle,
           status,
           updated_at
         ) VALUES ($1, $2, $3, $4, 'draft', $5)
         ON CONFLICT (catalog_item_id) DO UPDATE SET
           language_code = EXCLUDED.language_code,
           title = EXCLUDED.title,
           subtitle = EXCLUDED.subtitle,
           updated_at = EXCLUDED.updated_at`,
        [itemId, languageCode ?? "en", titleText, subtitleText, event.timing.recordedAt],
      );

      await refreshCatalogMirrorItem(db, tables, itemId);
    },
    "catalog.catalog-item.blueprint-assigned": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, CATALOG_ITEM_STREAM_PREFIX);
      const { blueprintId } = event.data as { blueprintId: string };

      await db.query(
        `UPDATE ${tables.items}
         SET blueprint_id = $2,
             updated_at = $3
         WHERE catalog_item_id = $1`,
        [itemId, blueprintId, event.timing.recordedAt],
      );

      await refreshCatalogMirrorItem(db, tables, itemId);
    },
    "catalog.catalog-item.published": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, CATALOG_ITEM_STREAM_PREFIX);

      await db.query(
        `UPDATE ${tables.items}
         SET status = $2,
             updated_at = $3
         WHERE catalog_item_id = $1`,
        [itemId, publishedStatus, event.timing.recordedAt],
      );

      if (spec.refreshProductSchemaOnItemPublished) {
        await refreshCatalogMirrorItem(db, tables, itemId);
      }
    },
    "catalog.catalog-item.retired": setItemStatusHandler(retiredStatus),
    "catalog.catalog-item.archived": setItemStatusHandler(archivedStatus),
    "catalog.blueprint.created": async (event) => {
      const { blueprintId, name } = event.data as {
        blueprintId: string;
        name: unknown;
      };
      const resolvedName = resolveLocalizedTextMap(coerceLocalizedTextMap(name));

      if (blueprintDraftStatusOnUpsert) {
        await db.query(
          `INSERT INTO ${tables.blueprints} (
             blueprint_id,
             name,
             status,
             updated_at
           ) VALUES ($1, $2, 'draft', $3)
           ON CONFLICT (blueprint_id) DO UPDATE SET
             name = EXCLUDED.name,
             updated_at = EXCLUDED.updated_at`,
          [blueprintId, resolvedName, event.timing.recordedAt],
        );
        return;
      }

      await db.query(
        `INSERT INTO ${tables.blueprints} (
           blueprint_id,
           name,
           updated_at
         ) VALUES ($1, $2, $3)
         ON CONFLICT (blueprint_id) DO UPDATE SET
           name = EXCLUDED.name,
           updated_at = EXCLUDED.updated_at`,
        [blueprintId, resolvedName, event.timing.recordedAt],
      );
    },
    "catalog.blueprint.revised": async (event) => {
      const blueprintId = extractIdFromStreamId(event.streamId, CATALOG_BLUEPRINT_STREAM_PREFIX);
      const { name } = event.data as { name: unknown };
      const resolvedName = resolveLocalizedTextMap(coerceLocalizedTextMap(name));

      if (blueprintDraftStatusOnUpsert) {
        await db.query(
          `INSERT INTO ${tables.blueprints} (
             blueprint_id,
             name,
             status,
             updated_at
           ) VALUES (
             $1,
             $2,
             COALESCE((SELECT status FROM ${tables.blueprints} WHERE blueprint_id = $1), 'draft'),
             $3
           )
           ON CONFLICT (blueprint_id) DO UPDATE SET
             name = EXCLUDED.name,
             updated_at = EXCLUDED.updated_at`,
          [blueprintId, resolvedName, event.timing.recordedAt],
        );
      } else {
        await db.query(
          `INSERT INTO ${tables.blueprints} (
             blueprint_id,
             name,
             updated_at
           ) VALUES ($1, $2, $3)
           ON CONFLICT (blueprint_id) DO UPDATE SET
             name = EXCLUDED.name,
             updated_at = EXCLUDED.updated_at`,
          [blueprintId, resolvedName, event.timing.recordedAt],
        );
      }

      await refreshCatalogMirrorItemsByBlueprint(db, tables, blueprintId);
    },
    "catalog.blueprint.dimensions-set": async (event) => {
      const blueprintId = extractIdFromStreamId(event.streamId, CATALOG_BLUEPRINT_STREAM_PREFIX);
      const { dimensionRules } = event.data as { dimensionRules: unknown };

      await db.query(
        `UPDATE ${tables.blueprints}
         SET dimension_rules = $2,
             updated_at = $3
         WHERE blueprint_id = $1`,
        [blueprintId, JSON.stringify(Array.isArray(dimensionRules) ? dimensionRules : []), event.timing.recordedAt],
      );

      await refreshCatalogMirrorItemsByBlueprint(db, tables, blueprintId);
    },
    "catalog.blueprint.product-resolution-rules-set": async (event) => {
      const blueprintId = extractIdFromStreamId(event.streamId, CATALOG_BLUEPRINT_STREAM_PREFIX);
      const { canonicalDimensionOrder } = event.data as {
        canonicalDimensionOrder: unknown;
      };

      await db.query(
        `UPDATE ${tables.blueprints}
         SET canonical_dimension_order = $2,
             updated_at = $3
         WHERE blueprint_id = $1`,
        [
          blueprintId,
          JSON.stringify(Array.isArray(canonicalDimensionOrder) ? canonicalDimensionOrder : []),
          event.timing.recordedAt,
        ],
      );

      await refreshCatalogMirrorItemsByBlueprint(db, tables, blueprintId);
    },
    "catalog.blueprint.published": async (event) => {
      const blueprintId = extractIdFromStreamId(event.streamId, CATALOG_BLUEPRINT_STREAM_PREFIX);

      await db.query(
        `UPDATE ${tables.blueprints}
         SET status = 'active',
             updated_at = $2
         WHERE blueprint_id = $1`,
        [blueprintId, event.timing.recordedAt],
      );

      await refreshCatalogMirrorItemsByBlueprint(db, tables, blueprintId);
    },
    "catalog.dimension.created": async (event) => {
      const { dimensionId, name } = event.data as {
        dimensionId: string;
        name: unknown;
      };

      await upsertDimension(dimensionId, name, event.timing.recordedAt);
    },
    "catalog.dimension.revised": async (event) => {
      const dimensionId = extractIdFromStreamId(event.streamId, CATALOG_DIMENSION_STREAM_PREFIX);
      const { name } = event.data as { name: unknown };

      await upsertDimension(dimensionId, name, event.timing.recordedAt);
    },
    "catalog.dimension.option-added": upsertDimensionOption,
    "catalog.dimension.option-revised": upsertDimensionOption,
  };

  if (spec.optionalHandlers?.metadataRevised) {
    handlers["catalog.catalog-item.metadata-revised"] = async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, CATALOG_ITEM_STREAM_PREFIX);
      const { languageCode, title, subtitle } = event.data as {
        languageCode?: string;
        title: string | LocalizedTextMap;
        subtitle?: string | LocalizedTextMap | null;
      };
      const titleText = resolveLocalizedTextMap(coerceLocalizedTextMap(title));
      const subtitleText =
        subtitle === null || subtitle === undefined
          ? null
          : resolveLocalizedTextMap(coerceLocalizedTextMap(subtitle)) || null;

      await db.query(
        `UPDATE ${tables.items}
         SET language_code = $2,
             title = $3,
             subtitle = $4,
             updated_at = $5
         WHERE catalog_item_id = $1`,
        [itemId, languageCode ?? "en", titleText, subtitleText, event.timing.recordedAt],
      );

      await refreshCatalogMirrorItem(db, tables, itemId);
    };
  }

  if (spec.optionalHandlers?.displayIdentityResolved) {
    handlers["catalog.catalog-item.display-identity-resolved"] = async (event) => {
      const data = event.data as CatalogItemDisplayIdentityResolvedEventData;

      await db.query(
        `UPDATE ${tables.items}
         SET language_code = $2,
             title = $3,
             subtitle = $4,
             updated_at = $5
         WHERE catalog_item_id = $1`,
        [
          data.catalogItemId,
          data.languageCode ?? "en",
          data.title,
          data.subtitle?.trim() || null,
          event.timing.recordedAt,
        ],
      );

      await refreshCatalogMirrorItem(db, tables, data.catalogItemId);
    };
  }

  return handlers;
}
