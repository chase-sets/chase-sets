import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  coerceLocalizedTextMap,
  resolveLocalizedTextMap,
  type LocalizedTextMap,
} from "@chase-sets/localization";

type DimensionRule = Readonly<{
  dimensionId: string;
  required: boolean;
  allowedOptionIds?: string[];
  appliesWhen?: Array<{ dimensionId: string; optionIds?: string[] }>;
}>;

type MarketplaceCatalogItemRow = Readonly<{
  catalog_item_id: string;
  language_code: string;
  title: string;
  subtitle: string | null;
  blueprint_id: string | null;
  status: string;
  updated_at: string;
}>;

type MarketplaceBlueprintRow = Readonly<{
  blueprint_id: string;
  name: string;
  dimension_rules: unknown;
  canonical_dimension_order: unknown;
}>;

type MarketplaceChoiceRow = Readonly<{
  option_id: string;
  code: string;
  label_i18n: unknown;
  label: string;
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
  const blueprintResult = await db.query<MarketplaceBlueprintRow>(
    `SELECT * FROM marketplace_catalog_blueprints WHERE blueprint_id = $1`,
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
  const optionIds = dimensionRules.flatMap((rule) => [
    ...(rule.allowedOptionIds ?? []),
    ...(rule.appliesWhen ?? []).flatMap((clause) => clause.optionIds ?? []),
  ]);

  const [dimensionNames, choiceRows] = await Promise.all([
    loadNameMap(
      db,
      "marketplace_catalog_dimensions",
      "dimension_id",
      "name",
      dimensionIds,
    ),
    optionIds.length > 0
      ? db.query<MarketplaceChoiceRow>(
          `SELECT option_id, code, label_i18n, label
           FROM marketplace_catalog_dimension_options
           WHERE option_id = ANY($1)`,
          [optionIds],
        ).then((result) => result.rows)
      : Promise.resolve([] as MarketplaceChoiceRow[]),
  ]);

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

async function refreshMarketplaceCatalogItem(
  db: PgQueryable,
  itemId: string,
): Promise<void> {
  const result = await db.query<MarketplaceCatalogItemRow>(
    `SELECT catalog_item_id, language_code, title, subtitle, blueprint_id, status, updated_at
     FROM marketplace_catalog_items
     WHERE catalog_item_id = $1`,
    [itemId],
  );

  const item = result.rows[0];
  if (!item) {
    return;
  }

  const productSchema = item.blueprint_id
    ? await buildVersionSchema(db, item.blueprint_id)
    : null;

  await db.query(
    `UPDATE marketplace_catalog_items
     SET product_schema = $2,
         updated_at = $3
     WHERE catalog_item_id = $1`,
    [
      itemId,
      productSchema === null ? null : JSON.stringify(productSchema),
      item.updated_at,
    ],
  );
}

async function refreshItemsByBlueprint(
  db: PgQueryable,
  blueprintId: string,
): Promise<void> {
  const result = await db.query<{ catalog_item_id: string }>(
    `SELECT catalog_item_id FROM marketplace_catalog_items WHERE blueprint_id = $1`,
    [blueprintId],
  );

  await Promise.all(
    result.rows.map((row) => refreshMarketplaceCatalogItem(db, row.catalog_item_id)),
  );
}

async function refreshAllMarketplaceCatalogItems(db: PgQueryable): Promise<void> {
  const result = await db.query<{ catalog_item_id: string }>(
    `SELECT catalog_item_id FROM marketplace_catalog_items ORDER BY catalog_item_id ASC`,
  );

  await Promise.all(
    result.rows.map((row) => refreshMarketplaceCatalogItem(db, row.catalog_item_id)),
  );
}

export function buildMarketplaceAccountProjectionHandlers(
  db: PgQueryable,
): ProjectorHandlerMap {
  return {
    "identity.account.created": async (event) => {
      const { accountId, displayName } = event.data as {
        accountId: string;
        displayName: string;
      };

      await db.query(
        `INSERT INTO marketplace_account_pages (
           account_id,
           display_name,
           status,
           updated_at
         ) VALUES ($1, $2, 'active', $3)
         ON CONFLICT (account_id) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           status = EXCLUDED.status,
           updated_at = EXCLUDED.updated_at`,
        [accountId, displayName, event.timing.recordedAt],
      );
    },
    "identity.account.profile-updated": async (event) => {
      const accountId = extractIdFromStreamId(event.streamId, "identity.account-");
      const { displayName } = event.data as { displayName: string };

      await db.query(
        `INSERT INTO marketplace_account_pages (
           account_id,
           display_name,
           status,
           updated_at
         ) VALUES (
           $1,
           $2,
           COALESCE((SELECT status FROM marketplace_account_pages WHERE account_id = $1), 'active'),
           $3
         )
         ON CONFLICT (account_id) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           updated_at = EXCLUDED.updated_at`,
        [accountId, displayName, event.timing.recordedAt],
      );
    },
    "identity.account.suspended": async (event) => {
      await db.query(
        `UPDATE marketplace_account_pages
         SET status = 'suspended',
             updated_at = $2
         WHERE account_id = $1`,
        [extractIdFromStreamId(event.streamId, "identity.account-"), event.timing.recordedAt],
      );
    },
    "identity.account.reactivated": async (event) => {
      await db.query(
        `UPDATE marketplace_account_pages
         SET status = 'active',
             updated_at = $2
         WHERE account_id = $1`,
        [extractIdFromStreamId(event.streamId, "identity.account-"), event.timing.recordedAt],
      );
    },
    "identity.account.closed": async (event) => {
      await db.query(
        `UPDATE marketplace_account_pages
         SET status = 'closed',
             updated_at = $2
         WHERE account_id = $1`,
        [extractIdFromStreamId(event.streamId, "identity.account-"), event.timing.recordedAt],
      );
    },
  };
}

export function buildMarketplaceCatalogProjectionHandlers(
  db: PgQueryable,
): ProjectorHandlerMap {
  return {
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
        `INSERT INTO marketplace_catalog_items (
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

      await refreshMarketplaceCatalogItem(db, itemId);
    },
    "catalog.catalog-item.blueprint-assigned": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, "catalog.item-");
      const { blueprintId } = event.data as { blueprintId: string };

      await db.query(
        `UPDATE marketplace_catalog_items
         SET blueprint_id = $2,
             updated_at = $3
         WHERE catalog_item_id = $1`,
        [itemId, blueprintId, event.timing.recordedAt],
      );

      await refreshMarketplaceCatalogItem(db, itemId);
    },
    "catalog.catalog-item.metadata-revised": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, "catalog.item-");
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
        `UPDATE marketplace_catalog_items
         SET language_code = $2,
             title = $3,
             subtitle = $4,
             updated_at = $5
         WHERE catalog_item_id = $1`,
        [itemId, languageCode ?? "en", titleText, subtitleText, event.timing.recordedAt],
      );

      await refreshMarketplaceCatalogItem(db, itemId);
    },
    "catalog.catalog-item.published": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, "catalog.item-");

      await db.query(
        `UPDATE marketplace_catalog_items
         SET status = 'active',
             updated_at = $2
         WHERE catalog_item_id = $1`,
        [itemId, event.timing.recordedAt],
      );
    },
    "catalog.catalog-item.retired": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, "catalog.item-");

      await db.query(
        `UPDATE marketplace_catalog_items
         SET status = 'retired',
             updated_at = $2
         WHERE catalog_item_id = $1`,
        [itemId, event.timing.recordedAt],
      );
    },
    "catalog.catalog-item.archived": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, "catalog.item-");

      await db.query(
        `UPDATE marketplace_catalog_items
         SET status = 'archived',
             updated_at = $2
         WHERE catalog_item_id = $1`,
        [itemId, event.timing.recordedAt],
      );
    },
    "catalog.blueprint.created": async (event) => {
      const { blueprintId, name } = event.data as {
        blueprintId: string;
        name: unknown;
      };
      const resolvedName = resolveLocalizedTextMap(coerceLocalizedTextMap(name));

      await db.query(
        `INSERT INTO marketplace_catalog_blueprints (
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
    },
    "catalog.blueprint.revised": async (event) => {
      const blueprintId = extractIdFromStreamId(event.streamId, "catalog.blueprint-");
      const { name } = event.data as { name: unknown };
      const resolvedName = resolveLocalizedTextMap(coerceLocalizedTextMap(name));

      await db.query(
        `INSERT INTO marketplace_catalog_blueprints (
          blueprint_id,
          name,
          status,
          updated_at
        ) VALUES (
          $1,
          $2,
          COALESCE((SELECT status FROM marketplace_catalog_blueprints WHERE blueprint_id = $1), 'draft'),
          $3
        )
        ON CONFLICT (blueprint_id) DO UPDATE SET
          name = EXCLUDED.name,
          updated_at = EXCLUDED.updated_at`,
        [blueprintId, resolvedName, event.timing.recordedAt],
      );

      await refreshItemsByBlueprint(db, blueprintId);
    },
    "catalog.blueprint.dimensions-set": async (event) => {
      const blueprintId = extractIdFromStreamId(event.streamId, "catalog.blueprint-");
      const { dimensionRules } = event.data as { dimensionRules: unknown };

      await db.query(
        `UPDATE marketplace_catalog_blueprints
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
    "catalog.blueprint.product-resolution-rules-set": async (event) => {
      const blueprintId = extractIdFromStreamId(event.streamId, "catalog.blueprint-");
      const { canonicalDimensionOrder } = event.data as {
        canonicalDimensionOrder: unknown;
      };

      await db.query(
        `UPDATE marketplace_catalog_blueprints
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
        `UPDATE marketplace_catalog_blueprints
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
        name: unknown;
      };
      const resolvedName = resolveLocalizedTextMap(coerceLocalizedTextMap(name));

      await db.query(
        `INSERT INTO marketplace_catalog_dimensions (
          dimension_id,
          name,
          updated_at
        ) VALUES ($1, $2, $3)
        ON CONFLICT (dimension_id) DO UPDATE SET
          name = EXCLUDED.name,
          updated_at = EXCLUDED.updated_at`,
        [dimensionId, resolvedName, event.timing.recordedAt],
      );

      await refreshAllMarketplaceCatalogItems(db);
    },
    "catalog.dimension.revised": async (event) => {
      const dimensionId = extractIdFromStreamId(event.streamId, "catalog.dimension-");
      const { name } = event.data as { name: unknown };
      const resolvedName = resolveLocalizedTextMap(coerceLocalizedTextMap(name));

      await db.query(
        `INSERT INTO marketplace_catalog_dimensions (
          dimension_id,
          name,
          updated_at
        ) VALUES ($1, $2, $3)
        ON CONFLICT (dimension_id) DO UPDATE SET
          name = EXCLUDED.name,
          updated_at = EXCLUDED.updated_at`,
        [dimensionId, resolvedName, event.timing.recordedAt],
      );

      await refreshAllMarketplaceCatalogItems(db);
    },
    "catalog.dimension.option-added": async (event) => {
      const dimensionId = extractIdFromStreamId(event.streamId, "catalog.dimension-");
      const { optionId, code, label, labels } = event.data as {
        optionId: string;
        code: string;
        label?: unknown;
        labels?: unknown;
      };
      const labelI18n = coerceDimensionOptionLabel(label ?? labels);

      await db.query(
        `INSERT INTO marketplace_catalog_dimension_options (
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

      await refreshAllMarketplaceCatalogItems(db);
    },
    "catalog.dimension.option-revised": async (event) => {
      const dimensionId = extractIdFromStreamId(event.streamId, "catalog.dimension-");
      const { optionId, code, label, labels } = event.data as {
        optionId: string;
        code: string;
        label?: unknown;
        labels?: unknown;
      };
      const labelI18n = coerceDimensionOptionLabel(label ?? labels);

      await db.query(
        `INSERT INTO marketplace_catalog_dimension_options (
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

      await refreshAllMarketplaceCatalogItems(db);
    },
  };
}

function coerceDimensionOptionLabel(value: unknown): LocalizedTextMap {
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

export function buildMarketplaceInventoryProjectionHandlers(
  db: PgQueryable,
  options: Readonly<{
    onInventoryItemChanged?: (itemId: string) => Promise<void>;
  }> = {},
): ProjectorHandlerMap {
  return {
    "inventory.storage-location.created": async (event) => {
      const data = event.data as {
        storageLocationId: string;
        accountId: string;
        name: string;
        shipFromCode: string;
        shipFromAddress: unknown;
      };

      await db.query(
        `INSERT INTO marketplace_supply_locations (
           storage_location_id,
           account_id,
           name,
           ship_from_code,
           ship_from_address,
           is_archived,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5, false, $6)
         ON CONFLICT (storage_location_id) DO UPDATE SET
           account_id = EXCLUDED.account_id,
           name = EXCLUDED.name,
           ship_from_code = EXCLUDED.ship_from_code,
           ship_from_address = EXCLUDED.ship_from_address,
           is_archived = false,
           updated_at = EXCLUDED.updated_at`,
        [
          data.storageLocationId,
          data.accountId,
          data.name,
          data.shipFromCode,
          JSON.stringify(data.shipFromAddress),
          event.timing.recordedAt,
        ],
      );
    },
    "inventory.storage-location.updated": async (event) => {
      const data = event.data as {
        storageLocationId: string;
        name: string;
        shipFromCode: string;
        shipFromAddress: unknown;
      };

      await db.query(
        `UPDATE marketplace_supply_locations
         SET name = $2,
             ship_from_code = $3,
             ship_from_address = $4,
             updated_at = $5
         WHERE storage_location_id = $1`,
        [
          data.storageLocationId,
          data.name,
          data.shipFromCode,
          JSON.stringify(data.shipFromAddress),
          event.timing.recordedAt,
        ],
      );
    },
    "inventory.storage-location.archived": async (event) => {
      const { storageLocationId } = event.data as { storageLocationId: string };

      await db.query(
        `UPDATE marketplace_supply_locations
         SET is_archived = true,
             updated_at = $2
         WHERE storage_location_id = $1`,
        [storageLocationId, event.timing.recordedAt],
      );
    },
    "inventory.item.created": async (event) => {
      const data = event.data as {
        itemId: string;
        accountId: string;
        catalogItemId: string;
        productId: string;
        selectedOptions: unknown;
        gradedCard: unknown;
        storageLocationId: string;
        totalQuantity: number;
        acquisitionCostAmount: string | null;
      };

      await db.query(
        `INSERT INTO marketplace_supply_items (
           item_id,
           account_id,
           catalog_catalog_item_id,
           product_id,
           selected_options,
           graded_card,
           storage_location_id,
           total_quantity,
           acquisition_cost_amount,
           last_stream_version,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (item_id) DO UPDATE SET
           account_id = EXCLUDED.account_id,
           catalog_catalog_item_id = EXCLUDED.catalog_catalog_item_id,
           product_id = EXCLUDED.product_id,
           selected_options = EXCLUDED.selected_options,
           graded_card = EXCLUDED.graded_card,
           storage_location_id = EXCLUDED.storage_location_id,
           total_quantity = EXCLUDED.total_quantity,
           acquisition_cost_amount = EXCLUDED.acquisition_cost_amount,
           last_stream_version = EXCLUDED.last_stream_version,
           updated_at = EXCLUDED.updated_at
         WHERE marketplace_supply_items.last_stream_version < EXCLUDED.last_stream_version`,
        [
          data.itemId,
          data.accountId,
          data.catalogItemId,
          data.productId,
          JSON.stringify(Array.isArray(data.selectedOptions) ? data.selectedOptions : []),
          data.gradedCard === null || typeof data.gradedCard !== "object"
            ? null
            : JSON.stringify(data.gradedCard),
          data.storageLocationId,
          data.totalQuantity,
          data.acquisitionCostAmount,
          event.streamVersion,
          event.timing.recordedAt,
        ],
      );

      await options.onInventoryItemChanged?.(data.itemId);
    },
    "inventory.item.adjusted": async (event) => {
      const data = event.data as {
        itemId: string;
        quantityDelta: number;
      };

      await db.query(
        `UPDATE marketplace_supply_items
         SET total_quantity = total_quantity + $2,
             updated_at = $3,
             last_stream_version = $4
         WHERE item_id = $1
           AND last_stream_version < $4`,
        [data.itemId, data.quantityDelta, event.timing.recordedAt, event.streamVersion],
      );

      await options.onInventoryItemChanged?.(data.itemId);
    },
    "inventory.hold.placed": async (event) => {
      const data = event.data as {
        holdId: string;
        accountId: string;
        itemId: string;
        quantity: number;
      };

      await db.query(
        `INSERT INTO marketplace_supply_holds (
           hold_id,
           account_id,
           item_id,
           quantity,
           status,
           released_at,
           last_stream_version,
           updated_at
         ) VALUES ($1, $2, $3, $4, 'active', NULL, $5, $6)
         ON CONFLICT (hold_id) DO UPDATE SET
           account_id = EXCLUDED.account_id,
           item_id = EXCLUDED.item_id,
           quantity = EXCLUDED.quantity,
           status = EXCLUDED.status,
           released_at = EXCLUDED.released_at,
           last_stream_version = EXCLUDED.last_stream_version,
           updated_at = EXCLUDED.updated_at
         WHERE marketplace_supply_holds.last_stream_version < EXCLUDED.last_stream_version`,
        [
          data.holdId,
          data.accountId,
          data.itemId,
          data.quantity,
          event.streamVersion,
          event.timing.recordedAt,
        ],
      );

      await options.onInventoryItemChanged?.(data.itemId);
    },
    "inventory.hold.released": async (event) => {
      const data = event.data as {
        holdId: string;
        releasedAt: string;
      };

      const released = await db.query<{ item_id: string }>(
        `UPDATE marketplace_supply_holds
         SET status = 'released',
             released_at = $2,
             updated_at = $3,
             last_stream_version = $4
         WHERE hold_id = $1
           AND last_stream_version < $4
         RETURNING item_id`,
        [
          data.holdId,
          data.releasedAt,
          event.timing.recordedAt,
          event.streamVersion,
        ],
      );

      const itemId = released.rows[0]?.item_id;
      if (itemId) {
        await options.onInventoryItemChanged?.(itemId);
      }
    },
  };
}
