import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type { PgQueryable, PgQueryResult } from "./types";
import { asArray, asStringArray, catalogMirrorTables } from "./catalog-mirror";

/**
 * Golden parity replay harness for catalog mirror projections.
 *
 * Replays a recorded catalog event fixture through a projection handler map against an
 * in-memory mirror database that records every emitted statement (whitespace-normalized
 * SQL plus parameters, reads and writes alike) and simulates just enough Postgres state
 * for the refresh cascades to flow. Identical recordings before and after a migration
 * prove the new handlers produce identical effects.
 */

export type CatalogMirrorReplayEffect = Readonly<{
  sql: string;
  params: readonly unknown[];
}>;

export type CatalogMirrorReplayResult = Readonly<{
  handledEventTypes: readonly string[];
  effects: readonly CatalogMirrorReplayEffect[];
  finalState: Readonly<{
    items: Readonly<Record<string, Record<string, unknown>>>;
    blueprints: Readonly<Record<string, Record<string, unknown>>>;
    dimensions: Readonly<Record<string, Record<string, unknown>>>;
    dimensionOptions: Readonly<Record<string, Record<string, unknown>>>;
  }>;
}>;

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function sortedRecord(map: Map<string, Record<string, unknown>>): Record<string, Record<string, unknown>> {
  return Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

type DimensionRule = Readonly<{
  dimensionId?: unknown;
  allowedOptionIds?: unknown;
  appliesWhen?: unknown;
}>;

type AppliesWhenClause = Readonly<{
  dimensionId?: unknown;
  optionIds?: unknown;
}>;

type ReplayDb = Readonly<{
  db: PgQueryable;
  effects: CatalogMirrorReplayEffect[];
  snapshotState: () => CatalogMirrorReplayResult["finalState"];
}>;

export function createCatalogMirrorReplayDb(tablePrefix: string): ReplayDb {
  const tables = catalogMirrorTables(tablePrefix);
  const items = new Map<string, Record<string, unknown>>();
  const blueprints = new Map<string, Record<string, unknown>>();
  const dimensions = new Map<string, Record<string, unknown>>();
  const dimensionOptions = new Map<string, Record<string, unknown>>();
  const effects: CatalogMirrorReplayEffect[] = [];

  function rowsResult<Row>(rows: Row[]): PgQueryResult<Row> {
    return { rows, rowCount: rows.length };
  }

  function emptyResult<Row>(): PgQueryResult<Row> {
    return { rows: [], rowCount: 0 };
  }

  function blueprintReferencesDimension(blueprint: Record<string, unknown>, dimensionId: string): boolean {
    const dimensionRules = asArray<DimensionRule>(blueprint.dimension_rules);
    const canonicalDimensionOrder = asStringArray(blueprint.canonical_dimension_order);

    return (
      canonicalDimensionOrder.includes(dimensionId) ||
      dimensionRules.some((rule) => {
        if (rule.dimensionId === dimensionId) {
          return true;
        }

        return asArray<AppliesWhenClause>(rule.appliesWhen).some((clause) => clause.dimensionId === dimensionId);
      })
    );
  }

  function blueprintReferencesOption(blueprint: Record<string, unknown>, optionId: string): boolean {
    return asArray<DimensionRule>(blueprint.dimension_rules).some((rule) => {
      if (asStringArray(rule.allowedOptionIds).includes(optionId)) {
        return true;
      }

      return asArray<AppliesWhenClause>(rule.appliesWhen).some((clause) =>
        asStringArray(clause.optionIds).includes(optionId),
      );
    });
  }

  async function query<Row = Record<string, unknown>>(
    sqlText: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    const sql = normalizeSql(sqlText);
    effects.push({ sql, params: [...values] });

    // Items.
    if (sql.startsWith(`INSERT INTO ${tables.items} (`)) {
      const [itemId, languageCode, title, subtitle, updatedAt] = values as [
        string,
        string,
        string,
        string | null,
        string,
      ];
      const existing = items.get(itemId);
      items.set(itemId, {
        catalog_item_id: itemId,
        language_code: languageCode,
        title,
        subtitle,
        blueprint_id: existing?.blueprint_id ?? null,
        status: existing?.status ?? "draft",
        product_schema: existing?.product_schema ?? null,
        updated_at: updatedAt,
      });
      return emptyResult();
    }

    if (
      sql.startsWith(
        `SELECT catalog_item_id, language_code, title, subtitle, blueprint_id, status, updated_at FROM ${tables.items} WHERE catalog_item_id = $1`,
      )
    ) {
      const item = items.get(String(values[0]));
      return rowsResult(item ? [item as Row] : []);
    }

    if (sql.startsWith(`UPDATE ${tables.items} SET product_schema = $2, updated_at = $3 WHERE catalog_item_id = $1`)) {
      const item = items.get(String(values[0]));
      if (item) {
        item.product_schema = values[1];
        item.updated_at = values[2];
      }
      return emptyResult();
    }

    if (
      sql.startsWith(
        `UPDATE ${tables.items} SET product_schema = $2::jsonb WHERE blueprint_id = $1 AND product_schema IS DISTINCT FROM $2::jsonb`,
      )
    ) {
      const blueprintId = String(values[0]);
      for (const item of items.values()) {
        if (item.blueprint_id === blueprintId && item.product_schema !== values[1]) {
          item.product_schema = values[1];
        }
      }
      return emptyResult();
    }

    if (sql.startsWith(`UPDATE ${tables.items} SET blueprint_id = $2, updated_at = $3 WHERE catalog_item_id = $1`)) {
      const item = items.get(String(values[0]));
      if (item) {
        item.blueprint_id = values[1];
        item.updated_at = values[2];
      }
      return emptyResult();
    }

    if (
      sql.startsWith(
        `UPDATE ${tables.items} SET language_code = $2, title = $3, subtitle = $4, updated_at = $5 WHERE catalog_item_id = $1`,
      )
    ) {
      const item = items.get(String(values[0]));
      if (item) {
        item.language_code = values[1];
        item.title = values[2];
        item.subtitle = values[3];
        item.updated_at = values[4];
      }
      return emptyResult();
    }

    if (sql.startsWith(`UPDATE ${tables.items} SET status = $2, updated_at = $3 WHERE catalog_item_id = $1`)) {
      const item = items.get(String(values[0]));
      if (item) {
        item.status = values[1];
        item.updated_at = values[2];
      }
      return emptyResult();
    }

    if (sql.startsWith(`SELECT catalog_item_id FROM ${tables.items} WHERE blueprint_id = $1`)) {
      const rows = [...items.values()]
        .filter((item) => item.blueprint_id === values[0])
        .map((item) => ({ catalog_item_id: item.catalog_item_id }));
      return rowsResult(rows as Row[]);
    }

    // Blueprints.
    if (sql.startsWith(`INSERT INTO ${tables.blueprints} (`)) {
      const [blueprintId, name, updatedAt] = values as [string, string, string];
      const existing = blueprints.get(blueprintId);
      if (existing) {
        existing.name = name;
        existing.updated_at = updatedAt;
      } else {
        blueprints.set(blueprintId, {
          blueprint_id: blueprintId,
          name,
          status: "draft",
          dimension_rules: [],
          canonical_dimension_order: [],
          updated_at: updatedAt,
        });
      }
      return emptyResult();
    }

    if (sql.startsWith(`SELECT * FROM ${tables.blueprints} WHERE blueprint_id = $1`)) {
      const blueprint = blueprints.get(String(values[0]));
      return rowsResult(blueprint ? [blueprint as Row] : []);
    }

    if (
      sql.startsWith(
        `SELECT blueprint_id FROM ${tables.blueprints} WHERE dimension_rules @> $1::jsonb OR canonical_dimension_order @> $2::jsonb`,
      )
    ) {
      const dimensionId = String(values[2]);
      const rows = [...blueprints.values()]
        .filter((blueprint) => blueprintReferencesDimension(blueprint, dimensionId))
        .map((blueprint) => ({ blueprint_id: String(blueprint.blueprint_id) }))
        .sort((left, right) => left.blueprint_id.localeCompare(right.blueprint_id));
      return rowsResult(rows as Row[]);
    }

    if (
      sql.startsWith(
        `SELECT blueprint_id FROM ${tables.blueprints} WHERE EXISTS ( SELECT 1 FROM jsonb_array_elements(dimension_rules) AS rule WHERE (rule->'allowedOptionIds') @> to_jsonb(ARRAY[$1]::text[])`,
      )
    ) {
      const optionId = String(values[0]);
      const rows = [...blueprints.values()]
        .filter((blueprint) => blueprintReferencesOption(blueprint, optionId))
        .map((blueprint) => ({ blueprint_id: String(blueprint.blueprint_id) }))
        .sort((left, right) => left.blueprint_id.localeCompare(right.blueprint_id));
      return rowsResult(rows as Row[]);
    }

    if (
      sql.startsWith(`UPDATE ${tables.blueprints} SET dimension_rules = $2, updated_at = $3 WHERE blueprint_id = $1`)
    ) {
      const blueprint = blueprints.get(String(values[0]));
      if (blueprint) {
        blueprint.dimension_rules = JSON.parse(String(values[1]));
        blueprint.updated_at = values[2];
      }
      return emptyResult();
    }

    if (
      sql.startsWith(
        `UPDATE ${tables.blueprints} SET canonical_dimension_order = $2, updated_at = $3 WHERE blueprint_id = $1`,
      )
    ) {
      const blueprint = blueprints.get(String(values[0]));
      if (blueprint) {
        blueprint.canonical_dimension_order = JSON.parse(String(values[1]));
        blueprint.updated_at = values[2];
      }
      return emptyResult();
    }

    if (sql.startsWith(`UPDATE ${tables.blueprints} SET status = 'active', updated_at = $2 WHERE blueprint_id = $1`)) {
      const blueprint = blueprints.get(String(values[0]));
      if (blueprint) {
        blueprint.status = "active";
        blueprint.updated_at = values[1];
      }
      return emptyResult();
    }

    // Dimensions.
    if (sql.startsWith(`INSERT INTO ${tables.dimensions} (`)) {
      const [dimensionId, name, updatedAt] = values as [string, string, string];
      dimensions.set(dimensionId, { dimension_id: dimensionId, name, updated_at: updatedAt });
      return emptyResult();
    }

    if (
      sql.startsWith(`SELECT dimension_id AS id, name AS name FROM ${tables.dimensions} WHERE dimension_id = ANY($1)`)
    ) {
      const ids = values[0] as readonly string[];
      const rows = ids
        .map((id) => dimensions.get(id))
        .filter((dimension): dimension is Record<string, unknown> => dimension !== undefined)
        .map((dimension) => ({ id: dimension.dimension_id, name: dimension.name }));
      return rowsResult(rows as Row[]);
    }

    // Dimension options.
    if (sql.startsWith(`INSERT INTO ${tables.dimensionOptions} (`)) {
      const [optionId, dimensionId, code, labelI18n, label, updatedAt] = values as [
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      dimensionOptions.set(optionId, {
        option_id: optionId,
        dimension_id: dimensionId,
        code,
        label_i18n: JSON.parse(labelI18n),
        label,
        updated_at: updatedAt,
      });
      return emptyResult();
    }

    if (
      sql.startsWith(
        `SELECT option_id, code, label_i18n, label FROM ${tables.dimensionOptions} WHERE option_id = ANY($1)`,
      )
    ) {
      const ids = values[0] as readonly string[];
      const rows = ids
        .map((id) => dimensionOptions.get(id))
        .filter((option): option is Record<string, unknown> => option !== undefined)
        .map((option) => ({
          option_id: option.option_id,
          code: option.code,
          label_i18n: option.label_i18n,
          label: option.label,
        }));
      return rowsResult(rows as Row[]);
    }

    // Anything else (bespoke consumer tables) is recorded without state simulation.
    return emptyResult();
  }

  return {
    db: { query: query as PgQueryable["query"] },
    effects,
    snapshotState: () => ({
      items: sortedRecord(items),
      blueprints: sortedRecord(blueprints),
      dimensions: sortedRecord(dimensions),
      dimensionOptions: sortedRecord(dimensionOptions),
    }),
  };
}

type FixtureEventInput = Readonly<{
  type: string;
  streamId: string;
  data: Record<string, unknown>;
  recordedAt: string;
}>;

function fixtureEvent(input: FixtureEventInput, index: number): TransportEvent {
  return {
    id: `evt_replay_${index + 1}` as never,
    type: input.type,
    streamId: input.streamId as never,
    streamVersion: (index + 1) as never,
    globalPosition: (index + 1) as never,
    tenantId: "tnt_replay" as never,
    data: input.data as never,
    metadata: {},
    audit: {
      performedByUserId: "usr_replay" as never,
      forAccountId: "acc_replay" as never,
    },
    trace: {},
    timing: {
      occurredAt: input.recordedAt as never,
      recordedAt: input.recordedAt as never,
    },
  };
}

function recordedAt(step: number): string {
  return `2026-06-01T00:${String(step).padStart(2, "0")}:00.000Z`;
}

/**
 * Recorded catalog event fixture covering every catalog event type consumed across the
 * checkout, inventory, and marketplace mirrors, including upsert re-deliveries and the
 * dimension/blueprint refresh cascades. Consumers replay the subset their handler map
 * declares; unhandled fixture events are skipped.
 */
export function catalogMirrorReplayEvents(): readonly TransportEvent[] {
  const inputs: FixtureEventInput[] = [
    {
      type: "catalog.dimension.created",
      streamId: "catalog.dimension-dim_condition",
      data: { dimensionId: "dim_condition", name: { defaultLocale: "en", values: { en: "Condition" } } },
      recordedAt: recordedAt(1),
    },
    {
      type: "catalog.dimension.option-added",
      streamId: "catalog.dimension-dim_condition",
      data: {
        optionId: "opt_near_mint",
        code: "NM",
        label: [
          { locale: "en", value: "Near Mint" },
          { locale: "ja", value: "ほぼ新品" },
        ],
      },
      recordedAt: recordedAt(2),
    },
    {
      type: "catalog.catalog-item.created",
      streamId: "catalog.item-cat_alpha",
      data: {
        itemId: "cat_alpha",
        languageCode: "ja",
        title: { defaultLocale: "en", values: { en: "Charizard", ja: "リザードン" } },
        subtitle: { defaultLocale: "en", values: { en: "Japanese Base Set", ja: "拡張パック" } },
      },
      recordedAt: recordedAt(3),
    },
    {
      type: "catalog.catalog-item.created",
      streamId: "catalog.item-cat_beta",
      data: { itemId: "cat_beta", title: "Plain String Title", subtitle: null },
      recordedAt: recordedAt(4),
    },
    {
      type: "catalog.blueprint.created",
      streamId: "catalog.blueprint-bp_main",
      data: { blueprintId: "bp_main", name: { defaultLocale: "en", values: { en: "Graded Card" } } },
      recordedAt: recordedAt(5),
    },
    {
      type: "catalog.blueprint.dimensions-set",
      streamId: "catalog.blueprint-bp_main",
      data: {
        dimensionRules: [
          {
            dimensionId: "dim_condition",
            required: true,
            allowedOptionIds: ["opt_near_mint", "opt_missing"],
            appliesWhen: [{ dimensionId: "dim_language", optionIds: ["opt_english"] }],
          },
          { dimensionId: "dim_language", required: false },
        ],
      },
      recordedAt: recordedAt(6),
    },
    {
      type: "catalog.catalog-item.blueprint-assigned",
      streamId: "catalog.item-cat_alpha",
      data: { blueprintId: "bp_main" },
      recordedAt: recordedAt(7),
    },
    {
      type: "catalog.blueprint.product-resolution-rules-set",
      streamId: "catalog.blueprint-bp_main",
      data: { canonicalDimensionOrder: ["dim_condition", "dim_language"] },
      recordedAt: recordedAt(8),
    },
    {
      type: "catalog.dimension.created",
      streamId: "catalog.dimension-dim_language",
      data: { dimensionId: "dim_language", name: { defaultLocale: "en", values: { en: "Language" } } },
      recordedAt: recordedAt(9),
    },
    {
      type: "catalog.dimension.revised",
      streamId: "catalog.dimension-dim_condition",
      data: { name: { defaultLocale: "en", values: { en: "Card Condition" } } },
      recordedAt: recordedAt(10),
    },
    {
      type: "catalog.dimension.option-revised",
      streamId: "catalog.dimension-dim_condition",
      data: {
        optionId: "opt_near_mint",
        code: "NM",
        labels: { defaultLocale: "en", values: { en: "Near Mint (revised)" } },
      },
      recordedAt: recordedAt(11),
    },
    {
      type: "catalog.blueprint.revised",
      streamId: "catalog.blueprint-bp_main",
      data: { name: { defaultLocale: "en", values: { en: "Graded Card (revised)" } } },
      recordedAt: recordedAt(12),
    },
    {
      type: "catalog.blueprint.revised",
      streamId: "catalog.blueprint-bp_unseen",
      data: { name: "Blueprint Revised Before Created" },
      recordedAt: recordedAt(13),
    },
    {
      type: "catalog.blueprint.published",
      streamId: "catalog.blueprint-bp_main",
      data: {},
      recordedAt: recordedAt(14),
    },
    {
      type: "catalog.catalog-item.metadata-revised",
      streamId: "catalog.item-cat_alpha",
      data: {
        languageCode: "en",
        title: { defaultLocale: "en", values: { en: "Charizard Holo" } },
        subtitle: null,
      },
      recordedAt: recordedAt(15),
    },
    {
      type: "catalog.catalog-item.display-identity-resolved",
      streamId: "catalog.item-cat_alpha",
      data: {
        catalogItemId: "cat_alpha",
        languageCode: "en",
        title: "Charizard 4/102",
        subtitle: "  Base Set Rare Holo  ",
      },
      recordedAt: recordedAt(16),
    },
    {
      type: "catalog.catalog-item.display-identity-resolved",
      streamId: "catalog.item-cat_beta",
      data: { catalogItemId: "cat_beta", title: "Plain Item", subtitle: "   " },
      recordedAt: recordedAt(17),
    },
    {
      type: "catalog.catalog-item.published",
      streamId: "catalog.item-cat_alpha",
      data: {},
      recordedAt: recordedAt(18),
    },
    {
      type: "catalog.catalog-item.external-product-reference-linked",
      streamId: "catalog.item-cat_alpha",
      data: {
        providerKey: "tcgplayer",
        externalKey: "tcg_sku_1",
        selectedOptions: [{ dimensionId: "dim_condition", optionId: "opt_near_mint" }],
      },
      recordedAt: recordedAt(19),
    },
    {
      type: "catalog.catalog-item.external-catalog-item-reference-linked",
      streamId: "catalog.item-cat_alpha",
      data: { providerKey: "tcgplayer", externalKey: "product:12345" },
      recordedAt: recordedAt(20),
    },
    {
      type: "catalog.catalog-item.product-measures-resolved",
      streamId: "catalog.item-cat_alpha",
      data: {
        catalogItemId: "cat_alpha",
        products: [{ productId: "prd_1", weightGrams: 12 }],
      },
      recordedAt: recordedAt(21),
    },
    {
      type: "catalog.catalog-item.created",
      streamId: "catalog.item-cat_alpha",
      data: { itemId: "cat_alpha", languageCode: "en", title: "Charizard (re-delivered)", subtitle: "Upsert path" },
      recordedAt: recordedAt(22),
    },
    {
      type: "catalog.catalog-item.retired",
      streamId: "catalog.item-cat_beta",
      data: {},
      recordedAt: recordedAt(23),
    },
    {
      type: "catalog.catalog-item.external-product-reference-unlinked",
      streamId: "catalog.item-cat_alpha",
      data: { providerKey: "tcgplayer", externalKey: "tcg_sku_1" },
      recordedAt: recordedAt(24),
    },
    {
      type: "catalog.catalog-item.external-catalog-item-reference-unlinked",
      streamId: "catalog.item-cat_alpha",
      data: { providerKey: "tcgplayer", externalKey: "product:12345" },
      recordedAt: recordedAt(25),
    },
    {
      type: "catalog.catalog-item.archived",
      streamId: "catalog.item-cat_alpha",
      data: {},
      recordedAt: recordedAt(26),
    },
  ];

  return inputs.map(fixtureEvent);
}

export async function replayCatalogMirror(
  options: Readonly<{
    tablePrefix: string;
    buildHandlers: (db: PgQueryable) => ProjectorHandlerMap;
    events?: readonly TransportEvent[];
  }>,
): Promise<CatalogMirrorReplayResult> {
  const replayDb = createCatalogMirrorReplayDb(options.tablePrefix);
  const handlers = options.buildHandlers(replayDb.db);
  const events = options.events ?? catalogMirrorReplayEvents();

  for (const event of events) {
    const handler = handlers[event.type];
    if (handler) {
      await handler(event);
    }
  }

  return {
    handledEventTypes: Object.keys(handlers).sort(),
    effects: replayDb.effects,
    finalState: replayDb.snapshotState(),
  };
}
