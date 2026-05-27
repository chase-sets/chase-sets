import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { coerceLocalizedTextMap } from "@chase-sets/localization";
import type { ProductMeasureSnapshot } from "@chase-sets/product-measures";

const DEFAULT_CANDIDATE_LIMIT = 50;

type DimensionRule = Readonly<{
  dimensionId: string;
  required: boolean;
  allowedOptionIds?: readonly string[];
  appliesWhen?: readonly Readonly<{ dimensionId: string; optionIds?: readonly string[] }>[];
}>;

type CatalogBlueprintRow = Readonly<{
  blueprint_id: string;
  dimension_rules: unknown;
  canonical_dimension_order: unknown;
}>;

type CatalogChoiceRow = Readonly<{
  option_id: string;
  code: string;
  label_i18n: unknown;
  label: string;
}>;

type CatalogRepresentativeCatalogItemRow = Readonly<{
  catalog_item_id: string;
  language_code: string;
  title: string;
  subtitle: string | null;
  blueprint_id: string | null;
  status: string;
  product_measure_snapshots: unknown;
  updated_at: string | Date;
}>;

export type CatalogRepresentativeProductSchema = Readonly<{
  canonicalDimensionOrder: readonly Readonly<{ dimensionId: string; dimensionName: string }>[];
  dimensions: readonly Readonly<{
    dimensionId: string;
    dimensionName: string;
    required: boolean;
    appliesWhen: readonly Readonly<{ dimensionId: string; optionIds: readonly string[] }>[];
    allowedOptions: readonly Readonly<{
      optionId: string;
      code: string;
      label_i18n?: unknown;
      label: string;
    }>[];
  }>[];
}>;

export type CatalogRepresentativeCatalogUsageCandidate = Readonly<{
  catalogItemId: string;
  languageCode: string;
  title: string;
  subtitle: string | null;
  blueprintId: string | null;
  status: "active";
  productSchema: CatalogRepresentativeProductSchema | null;
  productMeasureSnapshots: readonly ProductMeasureSnapshot[];
  updatedAt: string;
}>;

export async function loadRepresentativeCatalogUsageCandidates(
  db: Pick<PgQueryable, "query">,
  options: Readonly<{ limit?: number }> = {},
): Promise<readonly CatalogRepresentativeCatalogUsageCandidate[]> {
  const limit = normalizeRepresentativeCatalogCandidateLimit(options.limit);
  const result = await db.query<CatalogRepresentativeCatalogItemRow>(
    `SELECT
       item.catalog_item_id,
       item.language_code,
       item.title,
       item.subtitle,
       item.blueprint_id,
       item.status,
       COALESCE(
         jsonb_agg(measure.measure_snapshot ORDER BY measure.product_id)
           FILTER (WHERE measure.measure_snapshot IS NOT NULL),
         '[]'::jsonb
       ) AS product_measure_snapshots,
       item.updated_at
     FROM catalog_items item
     JOIN catalog_resolved_product_measures measure
       ON measure.catalog_item_id = item.catalog_item_id
      AND measure.measure_snapshot IS NOT NULL
     WHERE item.status = 'active'
     GROUP BY
       item.catalog_item_id,
       item.language_code,
       item.title,
       item.subtitle,
       item.blueprint_id,
       item.status,
       item.updated_at
     ORDER BY item.updated_at DESC, item.catalog_item_id ASC
     LIMIT $1`,
    [limit],
  );

  const productSchemaByBlueprintId = await loadProductSchemasByBlueprintId(db, [
    ...new Set(result.rows.map((row) => row.blueprint_id).filter((id): id is string => Boolean(id))),
  ]);

  return result.rows.map((row) => ({
    catalogItemId: row.catalog_item_id,
    languageCode: row.language_code,
    title: row.title,
    subtitle: row.subtitle,
    blueprintId: row.blueprint_id,
    status: "active",
    productSchema: row.blueprint_id ? (productSchemaByBlueprintId.get(row.blueprint_id) ?? null) : null,
    productMeasureSnapshots: parseProductMeasureSnapshots(row.product_measure_snapshots),
    updatedAt: new Date(row.updated_at).toISOString(),
  }));
}

export function normalizeRepresentativeCatalogCandidateLimit(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) {
    return DEFAULT_CANDIDATE_LIMIT;
  }

  return Math.max(1, Math.min(Math.trunc(value), 500));
}

async function loadProductSchemasByBlueprintId(
  db: Pick<PgQueryable, "query">,
  blueprintIds: readonly string[],
): Promise<ReadonlyMap<string, CatalogRepresentativeProductSchema>> {
  if (blueprintIds.length === 0) {
    return new Map();
  }

  const blueprintResult = await db.query<CatalogBlueprintRow>(
    `SELECT blueprint_id, dimension_rules, canonical_dimension_order
     FROM catalog_blueprints
     WHERE blueprint_id = ANY($1::text[])`,
    [blueprintIds],
  );

  const dimensionRules = blueprintResult.rows.flatMap((row) => asArray<DimensionRule>(row.dimension_rules));
  const canonicalDimensionOrder = blueprintResult.rows.flatMap((row) => asStringArray(row.canonical_dimension_order));
  const dimensionIds = [
    ...new Set([
      ...dimensionRules.map((rule) => rule.dimensionId),
      ...dimensionRules.flatMap((rule) => (rule.appliesWhen ?? []).map((clause) => clause.dimensionId)),
      ...canonicalDimensionOrder,
    ]),
  ];
  const optionIds = [
    ...new Set(
      dimensionRules.flatMap((rule) => [
        ...(rule.allowedOptionIds ?? []),
        ...(rule.appliesWhen ?? []).flatMap((clause) => clause.optionIds ?? []),
      ]),
    ),
  ];

  const [dimensionNameById, optionRows] = await Promise.all([
    loadNameMap(db, "catalog_dimensions", "dimension_id", "name", dimensionIds),
    optionIds.length > 0
      ? db
          .query<CatalogChoiceRow>(
            `SELECT option_id, code, label_i18n, label
             FROM catalog_dimension_options
             WHERE option_id = ANY($1::text[])`,
            [optionIds],
          )
          .then((result) => result.rows)
      : Promise.resolve([] as CatalogChoiceRow[]),
  ]);
  const optionById = new Map(optionRows.map((row) => [row.option_id, row]));

  return new Map(
    blueprintResult.rows.map((blueprint) => {
      const rules = asArray<DimensionRule>(blueprint.dimension_rules);
      const order = asStringArray(blueprint.canonical_dimension_order);

      return [
        blueprint.blueprint_id,
        {
          canonicalDimensionOrder: order.map((dimensionId) => ({
            dimensionId,
            dimensionName: dimensionNameById.get(dimensionId) ?? dimensionId,
          })),
          dimensions: rules.map((rule) => ({
            dimensionId: rule.dimensionId,
            dimensionName: dimensionNameById.get(rule.dimensionId) ?? rule.dimensionId,
            required: Boolean(rule.required),
            appliesWhen: (rule.appliesWhen ?? []).map((clause) => ({
              dimensionId: clause.dimensionId,
              optionIds: [...(clause.optionIds ?? [])],
            })),
            allowedOptions: (rule.allowedOptionIds ?? []).map((optionId) => {
              const option = optionById.get(optionId);

              return {
                optionId,
                code: option?.code ?? optionId,
                label_i18n: option?.label_i18n ?? coerceLocalizedTextMap(option?.label ?? optionId),
                label: option?.label ?? option?.code ?? optionId,
              };
            }),
          })),
        },
      ] as const;
    }),
  );
}

async function loadNameMap(
  db: Pick<PgQueryable, "query">,
  table: string,
  idColumn: string,
  nameColumn: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) {
    return new Map();
  }

  const result = await db.query<Record<string, string>>(
    `SELECT ${idColumn} AS id, ${nameColumn} AS name FROM ${table} WHERE ${idColumn} = ANY($1::text[])`,
    [ids],
  );

  return new Map(result.rows.map((row) => [row.id, row.name]));
}

function parseProductMeasureSnapshots(value: unknown): ProductMeasureSnapshot[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is ProductMeasureSnapshot => typeof entry === "object" && entry !== null)
    : [];
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asStringArray(value: unknown): string[] {
  return asArray<unknown>(value).filter((entry): entry is string => typeof entry === "string");
}
