import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

type DimensionRule = Readonly<{
  dimensionId: string;
  required: boolean;
  allowedChoiceIds?: string[];
  appliesWhen?: Array<{ dimensionId: string; choiceIds?: string[] }>;
}>;

type OrderingCatalogItemRow = Readonly<{
  item_id: string;
  title: string;
  subtitle: string | null;
  blueprint_id: string | null;
  status: string;
  updated_at: string;
}>;

type OrderingBlueprintRow = Readonly<{
  blueprint_id: string;
  name: string;
  dimension_rules: unknown;
  canonical_dimension_order: unknown;
}>;

type OrderingChoiceRow = Readonly<{
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

async function buildVersionSchema(
  db: PgQueryable,
  blueprintId: string,
): Promise<unknown | null> {
  const blueprintResult = await db.query<OrderingBlueprintRow>(
    `SELECT * FROM ordering_catalog_blueprints WHERE blueprint_id = $1`,
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
      ...dimensionRules.flatMap((rule) =>
        (rule.appliesWhen ?? []).map((clause) => clause.dimensionId),
      ),
      ...canonicalDimensionOrder,
    ]),
  ];
  const choiceIds = dimensionRules.flatMap((rule) => [
    ...(rule.allowedChoiceIds ?? []),
    ...(rule.appliesWhen ?? []).flatMap((clause) => clause.choiceIds ?? []),
  ]);

  const [dimensionNames, choiceRows] = await Promise.all([
    loadNameMap(
      db,
      "ordering_catalog_dimensions",
      "dimension_id",
      "name",
      dimensionIds,
    ),
    choiceIds.length > 0
      ? db.query<OrderingChoiceRow>(
          `SELECT choice_id, code, labels
           FROM ordering_catalog_dimension_choices
           WHERE choice_id = ANY($1)`,
          [choiceIds],
        ).then((result) => result.rows)
      : Promise.resolve([] as OrderingChoiceRow[]),
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
      appliesWhen: (rule.appliesWhen ?? []).map((clause) => ({
        dimensionId: clause.dimensionId,
        choiceIds: clause.choiceIds ?? [],
      })),
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

async function refreshOrderingCatalogItem(
  db: PgQueryable,
  itemId: string,
): Promise<void> {
  const result = await db.query<OrderingCatalogItemRow>(
    `SELECT item_id, title, subtitle, blueprint_id, status, updated_at
     FROM ordering_catalog_items
     WHERE item_id = $1`,
    [itemId],
  );
  const item = result.rows[0];

  if (!item) {
    return;
  }

  const versionSchema = item.blueprint_id
    ? await buildVersionSchema(db, item.blueprint_id)
    : null;

  await db.query(
    `UPDATE ordering_catalog_items
     SET version_schema = $2,
         updated_at = $3
     WHERE item_id = $1`,
    [
      itemId,
      versionSchema === null ? null : JSON.stringify(versionSchema),
      item.updated_at,
    ],
  );
}

async function refreshItemsByBlueprint(
  db: PgQueryable,
  blueprintId: string,
): Promise<void> {
  const result = await db.query<{ item_id: string }>(
    `SELECT item_id FROM ordering_catalog_items WHERE blueprint_id = $1`,
    [blueprintId],
  );

  await Promise.all(
    result.rows.map((row) => refreshOrderingCatalogItem(db, row.item_id)),
  );
}

async function refreshAllOrderingCatalogItems(db: PgQueryable): Promise<void> {
  const result = await db.query<{ item_id: string }>(
    `SELECT item_id FROM ordering_catalog_items ORDER BY item_id ASC`,
  );

  await Promise.all(
    result.rows.map((row) => refreshOrderingCatalogItem(db, row.item_id)),
  );
}

export function buildOrderingCatalogProjectionHandlers(
  db: PgQueryable,
): ProjectorHandlerMap {
  return {
    "catalog.catalog-item.created": async (event) => {
      const { itemId, title, subtitle } = event.data as {
        itemId: string;
        title: string;
        subtitle: string | null;
      };

      await db.query(
        `INSERT INTO ordering_catalog_items (
           item_id,
           title,
           subtitle,
           status,
           updated_at
         ) VALUES ($1, $2, $3, 'draft', $4)
         ON CONFLICT (item_id) DO UPDATE SET
           title = EXCLUDED.title,
           subtitle = EXCLUDED.subtitle,
           updated_at = EXCLUDED.updated_at`,
        [itemId, title, subtitle, event.timing.recordedAt],
      );

      await refreshOrderingCatalogItem(db, itemId);
    },
    "catalog.catalog-item.blueprint-assigned": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, "catalog.item-");
      const { blueprintId } = event.data as { blueprintId: string };

      await db.query(
        `UPDATE ordering_catalog_items
         SET blueprint_id = $2,
             updated_at = $3
         WHERE item_id = $1`,
        [itemId, blueprintId, event.timing.recordedAt],
      );

      await refreshOrderingCatalogItem(db, itemId);
    },
    "catalog.catalog-item.metadata-revised": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, "catalog.item-");
      const { title, subtitle } = event.data as {
        title: string;
        subtitle: string | null;
      };

      await db.query(
        `UPDATE ordering_catalog_items
         SET title = $2,
             subtitle = $3,
             updated_at = $4
         WHERE item_id = $1`,
        [itemId, title, subtitle, event.timing.recordedAt],
      );

      await refreshOrderingCatalogItem(db, itemId);
    },
    "catalog.catalog-item.published": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, "catalog.item-");

      await db.query(
        `UPDATE ordering_catalog_items
         SET status = 'active',
             updated_at = $2
         WHERE item_id = $1`,
        [itemId, event.timing.recordedAt],
      );
    },
    "catalog.catalog-item.retired": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, "catalog.item-");

      await db.query(
        `UPDATE ordering_catalog_items
         SET status = 'retired',
             updated_at = $2
         WHERE item_id = $1`,
        [itemId, event.timing.recordedAt],
      );
    },
    "catalog.catalog-item.archived": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, "catalog.item-");

      await db.query(
        `UPDATE ordering_catalog_items
         SET status = 'archived',
             updated_at = $2
         WHERE item_id = $1`,
        [itemId, event.timing.recordedAt],
      );
    },
    "catalog.blueprint.created": async (event) => {
      const { blueprintId, name } = event.data as {
        blueprintId: string;
        name: string;
      };

      await db.query(
        `INSERT INTO ordering_catalog_blueprints (
           blueprint_id,
           name,
           status,
           updated_at
         ) VALUES ($1, $2, 'draft', $3)
         ON CONFLICT (blueprint_id) DO UPDATE SET
           name = EXCLUDED.name,
           updated_at = EXCLUDED.updated_at`,
        [blueprintId, name, event.timing.recordedAt],
      );
    },
    "catalog.blueprint.revised": async (event) => {
      const blueprintId = extractIdFromStreamId(event.streamId, "catalog.blueprint-");
      const { name } = event.data as { name: string };

      await db.query(
        `INSERT INTO ordering_catalog_blueprints (
           blueprint_id,
           name,
           status,
           updated_at
         ) VALUES (
           $1,
           $2,
           COALESCE((SELECT status FROM ordering_catalog_blueprints WHERE blueprint_id = $1), 'draft'),
           $3
         )
         ON CONFLICT (blueprint_id) DO UPDATE SET
           name = EXCLUDED.name,
           updated_at = EXCLUDED.updated_at`,
        [blueprintId, name, event.timing.recordedAt],
      );

      await refreshItemsByBlueprint(db, blueprintId);
    },
    "catalog.blueprint.dimensions-set": async (event) => {
      const blueprintId = extractIdFromStreamId(event.streamId, "catalog.blueprint-");
      const { dimensionRules } = event.data as { dimensionRules: unknown };

      await db.query(
        `UPDATE ordering_catalog_blueprints
         SET dimension_rules = $2,
             updated_at = $3
         WHERE blueprint_id = $1`,
        [
          blueprintId,
          JSON.stringify(Array.isArray(dimensionRules) ? dimensionRules : []),
          event.timing.recordedAt,
        ],
      );

      await refreshItemsByBlueprint(db, blueprintId);
    },
    "catalog.blueprint.version-rules-set": async (event) => {
      const blueprintId = extractIdFromStreamId(event.streamId, "catalog.blueprint-");
      const { canonicalDimensionOrder } = event.data as {
        canonicalDimensionOrder: unknown;
      };

      await db.query(
        `UPDATE ordering_catalog_blueprints
         SET canonical_dimension_order = $2,
             updated_at = $3
         WHERE blueprint_id = $1`,
        [
          blueprintId,
          JSON.stringify(
            Array.isArray(canonicalDimensionOrder) ? canonicalDimensionOrder : [],
          ),
          event.timing.recordedAt,
        ],
      );

      await refreshItemsByBlueprint(db, blueprintId);
    },
    "catalog.blueprint.published": async (event) => {
      const blueprintId = extractIdFromStreamId(event.streamId, "catalog.blueprint-");

      await db.query(
        `UPDATE ordering_catalog_blueprints
         SET status = 'active',
             updated_at = $2
         WHERE blueprint_id = $1`,
        [blueprintId, event.timing.recordedAt],
      );

      await refreshItemsByBlueprint(db, blueprintId);
    },
    "catalog.dimension.created": async (event) => {
      const { dimensionId, name } = event.data as {
        dimensionId: string;
        name: string;
      };

      await db.query(
        `INSERT INTO ordering_catalog_dimensions (
           dimension_id,
           name,
           updated_at
         ) VALUES ($1, $2, $3)
         ON CONFLICT (dimension_id) DO UPDATE SET
           name = EXCLUDED.name,
           updated_at = EXCLUDED.updated_at`,
        [dimensionId, name, event.timing.recordedAt],
      );

      await refreshAllOrderingCatalogItems(db);
    },
    "catalog.dimension.revised": async (event) => {
      const dimensionId = extractIdFromStreamId(event.streamId, "catalog.dimension-");
      const { name } = event.data as { name: string };

      await db.query(
        `INSERT INTO ordering_catalog_dimensions (
           dimension_id,
           name,
           updated_at
         ) VALUES ($1, $2, $3)
         ON CONFLICT (dimension_id) DO UPDATE SET
           name = EXCLUDED.name,
           updated_at = EXCLUDED.updated_at`,
        [dimensionId, name, event.timing.recordedAt],
      );

      await refreshAllOrderingCatalogItems(db);
    },
    "catalog.dimension.choice-added": async (event) => {
      const dimensionId = extractIdFromStreamId(event.streamId, "catalog.dimension-");
      const { choiceId, code, labels } = event.data as {
        choiceId: string;
        code: string;
        labels: unknown;
      };

      await db.query(
        `INSERT INTO ordering_catalog_dimension_choices (
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
        [
          choiceId,
          dimensionId,
          code,
          JSON.stringify(Array.isArray(labels) ? labels : []),
          event.timing.recordedAt,
        ],
      );

      await refreshAllOrderingCatalogItems(db);
    },
    "catalog.dimension.choice-revised": async (event) => {
      const dimensionId = extractIdFromStreamId(event.streamId, "catalog.dimension-");
      const { choiceId, code, labels } = event.data as {
        choiceId: string;
        code: string;
        labels: unknown;
      };

      await db.query(
        `INSERT INTO ordering_catalog_dimension_choices (
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
        [
          choiceId,
          dimensionId,
          code,
          JSON.stringify(Array.isArray(labels) ? labels : []),
          event.timing.recordedAt,
        ],
      );

      await refreshAllOrderingCatalogItems(db);
    },
  };
}
