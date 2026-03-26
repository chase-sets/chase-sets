import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

const ITEM_STREAM_PREFIX = "catalog.item-";
const BLUEPRINT_STREAM_PREFIX = "catalog.blueprint-";
const CATEGORY_STREAM_PREFIX = "catalog.category-";
const FIELD_STREAM_PREFIX = "catalog.field-";
const DIMENSION_STREAM_PREFIX = "catalog.dimension-";

type FieldValue = Readonly<{ fieldId: string; value: unknown }>;
type DimensionRule = Readonly<{
  dimensionId: string;
  required: boolean;
  allowedChoiceIds?: string[];
}>;

type ItemDetailCatalogItemRow = Readonly<{
  item_id: string;
  title: string;
  subtitle: string | null;
  description: string;
  blueprint_id: string | null;
  status: string;
  field_values: unknown;
  category_ids: unknown;
  tags: unknown;
  image_urls: unknown;
  updated_at: string;
}>;

type ItemDetailBlueprintRow = Readonly<{
  blueprint_id: string;
  name: string;
  dimension_rules: unknown;
  canonical_dimension_order: unknown;
}>;

type ChoiceDetailRow = Readonly<{
  choice_id: string;
  code: string;
  labels: unknown;
}>;

function extractIdFromStreamId(streamId: string, prefix: string): string {
  if (!streamId.startsWith(prefix)) {
    throw new Error(`Stream ID "${streamId}" does not start with prefix "${prefix}".`);
  }

  return streamId.slice(prefix.length);
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asStringArray(value: unknown): string[] {
  return asArray<unknown>(value).filter((entry): entry is string => typeof entry === "string");
}

async function loadNameMap(
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

async function buildVersionSchema(db: PgQueryable, blueprintId: string): Promise<unknown | null> {
  const blueprintResult = await db.query<ItemDetailBlueprintRow>(
    `SELECT * FROM discovery_item_detail_catalog_blueprints WHERE blueprint_id = $1`,
    [blueprintId],
  );

  const blueprint = blueprintResult.rows[0];

  if (!blueprint) {
    return null;
  }

  const dimensionRules = asArray<DimensionRule>(blueprint.dimension_rules);
  const canonicalDimensionOrder = asStringArray(blueprint.canonical_dimension_order);
  const dimensionIds = [...new Set([...dimensionRules.map((rule) => rule.dimensionId), ...canonicalDimensionOrder])];
  const choiceIds = dimensionRules.flatMap((rule) => rule.allowedChoiceIds ?? []);

  const [dimensionNames, choiceRows] = await Promise.all([
    loadNameMap(
      db,
      "discovery_item_detail_catalog_dimensions",
      "dimension_id",
      "name",
      dimensionIds,
    ),
    choiceIds.length > 0
      ? db.query<ChoiceDetailRow>(
          `SELECT choice_id, code, labels
           FROM discovery_item_detail_catalog_dimension_choices
           WHERE choice_id = ANY($1)`,
          [choiceIds],
        ).then((result) => result.rows)
      : Promise.resolve([] as ChoiceDetailRow[]),
  ]);

  const choiceMap = new Map(choiceRows.map((row) => [row.choice_id, row]));

  return {
    canonicalDimensionOrder: canonicalDimensionOrder.map((dimensionId) => ({
      dimensionId,
      dimensionName: dimensionNames.get(dimensionId) ?? dimensionId,
    })),
    dimensions: dimensionRules.map((rule) => ({
      dimensionId: rule.dimensionId,
      dimensionName: dimensionNames.get(rule.dimensionId) ?? rule.dimensionId,
      required: rule.required,
      allowedChoices: (rule.allowedChoiceIds ?? []).map((choiceId) => {
        const detail = choiceMap.get(choiceId);
        return {
          choiceId,
          code: detail?.code ?? choiceId,
          labels: Array.isArray(detail?.labels) ? detail?.labels : [],
        };
      }),
    })),
  };
}

async function refreshDiscoveryItemDetailPage(db: PgQueryable, itemId: string): Promise<void> {
  const result = await db.query<ItemDetailCatalogItemRow>(
    `SELECT * FROM discovery_item_detail_catalog_items WHERE item_id = $1`,
    [itemId],
  );

  const item = result.rows[0];

  if (!item) {
    await db.query(`DELETE FROM discovery_item_detail_pages WHERE item_id = $1`, [itemId]);
    return;
  }

  const fieldValues = asArray<FieldValue>(item.field_values);
  const categoryIds = asStringArray(item.category_ids);
  const tags = asStringArray(item.tags);
  const imageUrls = asStringArray(item.image_urls);
  const fieldIds = fieldValues.map((entry) => entry.fieldId);

  const [fieldNames, categoryNames, blueprintNames] = await Promise.all([
    loadNameMap(
      db,
      "discovery_item_detail_catalog_fields",
      "field_id",
      "name",
      fieldIds,
    ),
    loadNameMap(
      db,
      "discovery_item_detail_catalog_categories",
      "category_id",
      "name",
      categoryIds,
    ),
    item.blueprint_id
      ? loadNameMap(
          db,
          "discovery_item_detail_catalog_blueprints",
          "blueprint_id",
          "name",
          [item.blueprint_id],
        )
      : Promise.resolve(new Map<string, string>()),
  ]);

  const versionSchema = item.blueprint_id
    ? await buildVersionSchema(db, item.blueprint_id)
    : null;

  await db.query(
    `INSERT INTO discovery_item_detail_pages (
      item_id,
      title,
      subtitle,
      description,
      blueprint_id,
      blueprint,
      status,
      field_values,
      categories,
      tags,
      image_urls,
      version_schema,
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    ON CONFLICT (item_id) DO UPDATE SET
      title = EXCLUDED.title,
      subtitle = EXCLUDED.subtitle,
      description = EXCLUDED.description,
      blueprint_id = EXCLUDED.blueprint_id,
      blueprint = EXCLUDED.blueprint,
      status = EXCLUDED.status,
      field_values = EXCLUDED.field_values,
      categories = EXCLUDED.categories,
      tags = EXCLUDED.tags,
      image_urls = EXCLUDED.image_urls,
      version_schema = EXCLUDED.version_schema,
      updated_at = EXCLUDED.updated_at`,
    [
      item.item_id,
      item.title,
      item.subtitle,
      item.description,
      item.blueprint_id,
      item.blueprint_id
        ? JSON.stringify({
            blueprintId: item.blueprint_id,
            name: blueprintNames.get(item.blueprint_id) ?? item.blueprint_id,
          })
        : null,
      item.status,
      JSON.stringify(
        fieldValues.map((entry) => ({
          fieldId: entry.fieldId,
          fieldName: fieldNames.get(entry.fieldId) ?? entry.fieldId,
          value: entry.value,
        })),
      ),
      JSON.stringify(
        categoryIds.map((categoryId) => ({
          categoryId,
          name: categoryNames.get(categoryId) ?? categoryId,
        })),
      ),
      JSON.stringify(tags),
      JSON.stringify(imageUrls),
      versionSchema === null ? null : JSON.stringify(versionSchema),
      item.updated_at,
    ],
  );
}

async function refreshItemsByBlueprint(db: PgQueryable, blueprintId: string): Promise<void> {
  const result = await db.query<{ item_id: string }>(
    `SELECT item_id FROM discovery_item_detail_catalog_items WHERE blueprint_id = $1`,
    [blueprintId],
  );

  await Promise.all(result.rows.map((row) => refreshDiscoveryItemDetailPage(db, row.item_id)));
}

async function refreshItemsByCategory(db: PgQueryable, categoryId: string): Promise<void> {
  const result = await db.query<{ item_id: string }>(
    `SELECT item_id FROM discovery_item_detail_catalog_items WHERE category_ids @> $1::jsonb`,
    [JSON.stringify([categoryId])],
  );

  await Promise.all(result.rows.map((row) => refreshDiscoveryItemDetailPage(db, row.item_id)));
}

async function refreshAllItems(db: PgQueryable): Promise<void> {
  const result = await db.query<{ item_id: string }>(
    `SELECT item_id FROM discovery_item_detail_catalog_items ORDER BY item_id ASC`,
  );

  await Promise.all(result.rows.map((row) => refreshDiscoveryItemDetailPage(db, row.item_id)));
}

export function buildDiscoveryItemDetailProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "catalog.catalog-item.created": async (event) => {
      const { itemId, title, subtitle, description } = event.data as {
        itemId: string;
        title: string;
        subtitle: string | null;
        description: string;
      };

      await db.query(
        `INSERT INTO discovery_item_detail_catalog_items (
          item_id,
          title,
          subtitle,
          description,
          status,
          updated_at
        ) VALUES ($1, $2, $3, $4, 'draft', $5)
        ON CONFLICT (item_id) DO UPDATE SET
          title = EXCLUDED.title,
          subtitle = EXCLUDED.subtitle,
          description = EXCLUDED.description,
          updated_at = EXCLUDED.updated_at`,
        [itemId, title, subtitle, description ?? "", event.timing.recordedAt],
      );

      await refreshDiscoveryItemDetailPage(db, itemId);
    },
    "catalog.catalog-item.blueprint-assigned": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { blueprintId } = event.data as { blueprintId: string };

      await db.query(
        `UPDATE discovery_item_detail_catalog_items
         SET blueprint_id = $2, updated_at = $3
         WHERE item_id = $1`,
        [itemId, blueprintId, event.timing.recordedAt],
      );

      await refreshDiscoveryItemDetailPage(db, itemId);
    },
    "catalog.catalog-item.field-value-set": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { fieldId, value } = event.data as { fieldId: string; value: unknown };

      await db.query(
        `UPDATE discovery_item_detail_catalog_items
         SET field_values = (
           SELECT COALESCE(jsonb_agg(field_value), '[]'::jsonb)
           FROM jsonb_array_elements(field_values) AS field_value
           WHERE field_value->>'fieldId' != $2
         ) || $3::jsonb,
         updated_at = $4
         WHERE item_id = $1`,
        [itemId, fieldId, JSON.stringify([{ fieldId, value }]), event.timing.recordedAt],
      );

      await refreshDiscoveryItemDetailPage(db, itemId);
    },
    "catalog.catalog-item.field-value-cleared": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { fieldId } = event.data as { fieldId: string };

      await db.query(
        `UPDATE discovery_item_detail_catalog_items
         SET field_values = (
           SELECT COALESCE(jsonb_agg(field_value), '[]'::jsonb)
           FROM jsonb_array_elements(field_values) AS field_value
           WHERE field_value->>'fieldId' != $2
         ),
         updated_at = $3
         WHERE item_id = $1`,
        [itemId, fieldId, event.timing.recordedAt],
      );

      await refreshDiscoveryItemDetailPage(db, itemId);
    },
    "catalog.catalog-item.category-assigned": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { categoryId } = event.data as { categoryId: string };

      await db.query(
        `UPDATE discovery_item_detail_catalog_items
         SET category_ids = category_ids || $2::jsonb,
             updated_at = $3
         WHERE item_id = $1`,
        [itemId, JSON.stringify([categoryId]), event.timing.recordedAt],
      );

      await refreshDiscoveryItemDetailPage(db, itemId);
    },
    "catalog.catalog-item.category-removed": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { categoryId } = event.data as { categoryId: string };

      await db.query(
        `UPDATE discovery_item_detail_catalog_items
         SET category_ids = (
           SELECT COALESCE(jsonb_agg(category_id), '[]'::jsonb)
           FROM jsonb_array_elements(category_ids) AS category_id
           WHERE category_id #>> '{}' != $2
         ),
         updated_at = $3
         WHERE item_id = $1`,
        [itemId, categoryId, event.timing.recordedAt],
      );

      await refreshDiscoveryItemDetailPage(db, itemId);
    },
    "catalog.catalog-item.published": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);

      await db.query(
        `UPDATE discovery_item_detail_catalog_items
         SET status = 'active', updated_at = $2
         WHERE item_id = $1`,
        [itemId, event.timing.recordedAt],
      );

      await refreshDiscoveryItemDetailPage(db, itemId);
    },
    "catalog.catalog-item.metadata-revised": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { title, subtitle, description } = event.data as {
        title: string;
        subtitle: string | null;
        description: string;
      };

      await db.query(
        `UPDATE discovery_item_detail_catalog_items
         SET title = $2,
             subtitle = $3,
             description = $4,
             updated_at = $5
         WHERE item_id = $1`,
        [itemId, title, subtitle, description ?? "", event.timing.recordedAt],
      );

      await refreshDiscoveryItemDetailPage(db, itemId);
    },
    "catalog.catalog-item.tags-set": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { tags } = event.data as { tags: string[] };

      await db.query(
        `UPDATE discovery_item_detail_catalog_items
         SET tags = $2,
             updated_at = $3
         WHERE item_id = $1`,
        [itemId, JSON.stringify(tags), event.timing.recordedAt],
      );

      await refreshDiscoveryItemDetailPage(db, itemId);
    },
    "catalog.catalog-item.image-urls-set": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const { imageUrls } = event.data as { imageUrls: string[] };

      await db.query(
        `UPDATE discovery_item_detail_catalog_items
         SET image_urls = $2,
             updated_at = $3
         WHERE item_id = $1`,
        [itemId, JSON.stringify(imageUrls), event.timing.recordedAt],
      );

      await refreshDiscoveryItemDetailPage(db, itemId);
    },
    "catalog.catalog-item.retired": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);

      await db.query(
        `UPDATE discovery_item_detail_catalog_items
         SET status = 'retired', updated_at = $2
         WHERE item_id = $1`,
        [itemId, event.timing.recordedAt],
      );

      await refreshDiscoveryItemDetailPage(db, itemId);
    },
    "catalog.catalog-item.archived": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);

      await db.query(
        `UPDATE discovery_item_detail_catalog_items
         SET status = 'archived', updated_at = $2
         WHERE item_id = $1`,
        [itemId, event.timing.recordedAt],
      );

      await refreshDiscoveryItemDetailPage(db, itemId);
    },

    "catalog.blueprint.created": async (event) => {
      const { blueprintId, name } = event.data as { blueprintId: string; name: string };

      await db.query(
        `INSERT INTO discovery_item_detail_catalog_blueprints (
          blueprint_id,
          name,
          updated_at
        ) VALUES ($1, $2, $3)
        ON CONFLICT (blueprint_id) DO UPDATE SET
          name = EXCLUDED.name,
          updated_at = EXCLUDED.updated_at`,
        [blueprintId, name, event.timing.recordedAt],
      );
    },
    "catalog.blueprint.revised": async (event) => {
      const blueprintId = extractIdFromStreamId(event.streamId, BLUEPRINT_STREAM_PREFIX);
      const { name } = event.data as { name: string };

      await db.query(
        `INSERT INTO discovery_item_detail_catalog_blueprints (
          blueprint_id,
          name,
          updated_at
        ) VALUES ($1, $2, $3)
        ON CONFLICT (blueprint_id) DO UPDATE SET
          name = EXCLUDED.name,
          updated_at = EXCLUDED.updated_at`,
        [blueprintId, name, event.timing.recordedAt],
      );

      await refreshItemsByBlueprint(db, blueprintId);
    },
    "catalog.blueprint.dimensions-set": async (event) => {
      const blueprintId = extractIdFromStreamId(event.streamId, BLUEPRINT_STREAM_PREFIX);
      const { dimensionRules } = event.data as { dimensionRules: unknown };

      await db.query(
        `INSERT INTO discovery_item_detail_catalog_blueprints (
          blueprint_id,
          name,
          dimension_rules,
          updated_at
        ) VALUES (
          $1,
          COALESCE((SELECT name FROM discovery_item_detail_catalog_blueprints WHERE blueprint_id = $1), $1),
          $2,
          $3
        )
        ON CONFLICT (blueprint_id) DO UPDATE SET
          dimension_rules = EXCLUDED.dimension_rules,
          updated_at = EXCLUDED.updated_at`,
        [blueprintId, JSON.stringify(dimensionRules), event.timing.recordedAt],
      );

      await refreshItemsByBlueprint(db, blueprintId);
    },
    "catalog.blueprint.version-rules-set": async (event) => {
      const blueprintId = extractIdFromStreamId(event.streamId, BLUEPRINT_STREAM_PREFIX);
      const { canonicalDimensionOrder } = event.data as { canonicalDimensionOrder: unknown };

      await db.query(
        `INSERT INTO discovery_item_detail_catalog_blueprints (
          blueprint_id,
          name,
          canonical_dimension_order,
          updated_at
        ) VALUES (
          $1,
          COALESCE((SELECT name FROM discovery_item_detail_catalog_blueprints WHERE blueprint_id = $1), $1),
          $2,
          $3
        )
        ON CONFLICT (blueprint_id) DO UPDATE SET
          canonical_dimension_order = EXCLUDED.canonical_dimension_order,
          updated_at = EXCLUDED.updated_at`,
        [blueprintId, JSON.stringify(canonicalDimensionOrder), event.timing.recordedAt],
      );

      await refreshItemsByBlueprint(db, blueprintId);
    },
    "catalog.blueprint.published": async (event) => {
      await refreshItemsByBlueprint(db, extractIdFromStreamId(event.streamId, BLUEPRINT_STREAM_PREFIX));
    },

    "catalog.category.created": async (event) => {
      const { categoryId, name } = event.data as { categoryId: string; name: string };

      await db.query(
        `INSERT INTO discovery_item_detail_catalog_categories (category_id, name, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (category_id) DO UPDATE SET
           name = EXCLUDED.name,
           updated_at = EXCLUDED.updated_at`,
        [categoryId, name, event.timing.recordedAt],
      );
    },
    "catalog.category.revised": async (event) => {
      const categoryId = extractIdFromStreamId(event.streamId, CATEGORY_STREAM_PREFIX);
      const { name } = event.data as { name: string };

      await db.query(
        `INSERT INTO discovery_item_detail_catalog_categories (category_id, name, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (category_id) DO UPDATE SET
           name = EXCLUDED.name,
           updated_at = EXCLUDED.updated_at`,
        [categoryId, name, event.timing.recordedAt],
      );

      await refreshItemsByCategory(db, categoryId);
    },

    "catalog.field.created": async (event) => {
      const { fieldId, name } = event.data as { fieldId: string; name: string };

      await db.query(
        `INSERT INTO discovery_item_detail_catalog_fields (field_id, name, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (field_id) DO UPDATE SET
           name = EXCLUDED.name,
           updated_at = EXCLUDED.updated_at`,
        [fieldId, name, event.timing.recordedAt],
      );

      await refreshAllItems(db);
    },
    "catalog.field.configured": async (event) => {
      const fieldId = extractIdFromStreamId(event.streamId, FIELD_STREAM_PREFIX);
      const { name } = event.data as { name: string };

      await db.query(
        `INSERT INTO discovery_item_detail_catalog_fields (field_id, name, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (field_id) DO UPDATE SET
           name = EXCLUDED.name,
           updated_at = EXCLUDED.updated_at`,
        [fieldId, name, event.timing.recordedAt],
      );

      await refreshAllItems(db);
    },

    "catalog.dimension.created": async (event) => {
      const { dimensionId, name } = event.data as { dimensionId: string; name: string };

      await db.query(
        `INSERT INTO discovery_item_detail_catalog_dimensions (dimension_id, name, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (dimension_id) DO UPDATE SET
           name = EXCLUDED.name,
           updated_at = EXCLUDED.updated_at`,
        [dimensionId, name, event.timing.recordedAt],
      );

      await refreshAllItems(db);
    },
    "catalog.dimension.revised": async (event) => {
      const dimensionId = extractIdFromStreamId(event.streamId, DIMENSION_STREAM_PREFIX);
      const { name } = event.data as { name: string };

      await db.query(
        `INSERT INTO discovery_item_detail_catalog_dimensions (dimension_id, name, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (dimension_id) DO UPDATE SET
           name = EXCLUDED.name,
           updated_at = EXCLUDED.updated_at`,
        [dimensionId, name, event.timing.recordedAt],
      );

      await refreshAllItems(db);
    },
    "catalog.dimension.choice-added": async (event) => {
      const dimensionId = extractIdFromStreamId(event.streamId, DIMENSION_STREAM_PREFIX);
      const { choiceId, code, labels } = event.data as {
        choiceId: string;
        code: string;
        labels: unknown;
      };

      await db.query(
        `INSERT INTO discovery_item_detail_catalog_dimension_choices (
          choice_id,
          dimension_id,
          code,
          labels,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (choice_id) DO UPDATE SET
          dimension_id = EXCLUDED.dimension_id,
          code = EXCLUDED.code,
          labels = EXCLUDED.labels,
          updated_at = EXCLUDED.updated_at`,
        [choiceId, dimensionId, code, JSON.stringify(Array.isArray(labels) ? labels : []), event.timing.recordedAt],
      );

      await refreshAllItems(db);
    },
    "catalog.dimension.choice-revised": async (event) => {
      const dimensionId = extractIdFromStreamId(event.streamId, DIMENSION_STREAM_PREFIX);
      const { choiceId, code, labels } = event.data as {
        choiceId: string;
        code: string;
        labels: unknown;
      };

      await db.query(
        `INSERT INTO discovery_item_detail_catalog_dimension_choices (
          choice_id,
          dimension_id,
          code,
          labels,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (choice_id) DO UPDATE SET
          dimension_id = EXCLUDED.dimension_id,
          code = EXCLUDED.code,
          labels = EXCLUDED.labels,
          updated_at = EXCLUDED.updated_at`,
        [choiceId, dimensionId, code, JSON.stringify(Array.isArray(labels) ? labels : []), event.timing.recordedAt],
      );

      await refreshAllItems(db);
    },
  };
}


