import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { withPgTransaction } from "@chase-sets/event-core-postgres";
import {
  createProjectionHandlerSet,
  resolveProjectionDb,
  type ProjectionHandlerSet,
} from "@chase-sets/event-core/projector";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { toJsonValue, type JsonObject } from "@chase-sets/primitives/json";
import type {
  ProductMeasureSnapshot,
  ProductPhysicalFlag,
  ProductMeasureStackBehavior,
  ProductMeasureConfidence,
} from "@chase-sets/product-measures";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import { listProductMeasureProfiles, listResolvedProductMeasures } from "../read-model/queries";

type ProductMeasureProfileInput = Readonly<{
  profileId: string;
  key: string;
  name: string;
  matchBlueprintId?: string | null;
  matchCategoryIds?: readonly string[];
  matchSelectedOptions?: readonly { dimensionId: string; optionId: string }[];
  precedence?: number;
  unitLengthInches: number;
  unitWidthInches: number;
  unitHeightInches: number;
  unitWeightOunces: number;
  physicalFlags: readonly ProductPhysicalFlag[];
  stackBehavior: ProductMeasureStackBehavior;
  confidence: ProductMeasureConfidence;
}>;

type CatalogProductRow = Readonly<{
  catalog_item_id: string;
  blueprint_id: string | null;
  category_ids: unknown;
  dimension_rules: unknown;
  canonical_dimension_order: unknown;
}>;

type ProductSchema = Readonly<{
  canonicalDimensionOrder?: readonly string[];
  dimensions?: readonly Readonly<{
    dimensionId?: string;
    required?: boolean;
    allowedOptions?: readonly Readonly<{ optionId?: string }>[];
    allowedOptionIds?: readonly string[];
    appliesWhen?: readonly Readonly<{
      dimensionId?: string;
      optionIds?: readonly string[];
    }>[];
  }>[];
}>;

type ProductDimension = NonNullable<ProductSchema["dimensions"]>[number];

export type ProductMeasureServices = Readonly<{
  upsertProfile: (profile: ProductMeasureProfileInput) => Promise<void>;
  resolveCatalogItemMeasures: (catalogItemId: string, context?: EventStoreContext) => Promise<void>;
  resolveAllCatalogItemMeasures: (context?: EventStoreContext) => Promise<void>;
  listProductMeasureProfiles: () => ReturnType<typeof listProductMeasureProfiles>;
  listResolvedProductMeasures: (catalogItemId?: string | null) => ReturnType<typeof listResolvedProductMeasures>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createProductMeasureRuntime(deps: CatalogRuntimeDeps): ProductMeasureServices {
  return {
    upsertProfile: (profile) => upsertProfile(deps.db, profile),
    resolveCatalogItemMeasures: (catalogItemId, context) => resolveCatalogItemMeasures(deps, catalogItemId, context),
    resolveAllCatalogItemMeasures: (context) => resolveAllCatalogItemMeasures(deps, context),
    listProductMeasureProfiles: () => listProductMeasureProfiles(deps.db),
    listResolvedProductMeasures: (catalogItemId) => listResolvedProductMeasures(deps.db, catalogItemId),
    projectors: [
      createProjectionHandlerSet({
        projectionName: "catalog-product-measures-projection",
        handlers: {
          "catalog.catalog-item.product-measures-resolved": async (event, context) => {
            const data = event.data as { catalogItemId: string; products: ProductMeasureSnapshot[] };
            await replaceResolvedProductMeasures(
              resolveProjectionDb(context, deps.db),
              data.catalogItemId,
              data.products,
            );
          },
        },
      }),
    ],
  };
}

async function upsertProfile(db: PgQueryable, profile: ProductMeasureProfileInput) {
  const measure: Omit<ProductMeasureSnapshot, "catalogItemId" | "productId" | "selectedOptions"> = {
    measureVersion: `${profile.key}:v1`,
    unitLengthInches: profile.unitLengthInches,
    unitWidthInches: profile.unitWidthInches,
    unitHeightInches: profile.unitHeightInches,
    unitWeightOunces: profile.unitWeightOunces,
    physicalFlags: [...profile.physicalFlags],
    stackBehavior: profile.stackBehavior,
    source: "profile",
    confidence: profile.confidence,
  };

  await db.query(
    `INSERT INTO catalog_product_measure_profiles (
       profile_id,
       key,
       name,
       status,
       match_blueprint_id,
       match_category_ids,
       match_selected_options,
       measure_snapshot,
       precedence,
       updated_at
     ) VALUES ($1, $2, $3, 'active', $4, $5, $6, $7, $8, now())
     ON CONFLICT (profile_id) DO UPDATE SET
       key = EXCLUDED.key,
       name = EXCLUDED.name,
       status = EXCLUDED.status,
       match_blueprint_id = EXCLUDED.match_blueprint_id,
       match_category_ids = EXCLUDED.match_category_ids,
       match_selected_options = EXCLUDED.match_selected_options,
       measure_snapshot = EXCLUDED.measure_snapshot,
       precedence = EXCLUDED.precedence,
       updated_at = EXCLUDED.updated_at`,
    [
      profile.profileId,
      profile.key,
      profile.name,
      profile.matchBlueprintId ?? null,
      JSON.stringify(profile.matchCategoryIds ?? []),
      JSON.stringify(profile.matchSelectedOptions ?? []),
      JSON.stringify(measure),
      profile.precedence ?? 100,
    ],
  );
}

async function resolveAllCatalogItemMeasures(deps: CatalogRuntimeDeps, context?: EventStoreContext) {
  const result = await deps.db.query<{ catalog_item_id: string }>(
    `SELECT catalog_item_id FROM catalog_items ORDER BY catalog_item_id ASC`,
  );

  for (const row of result.rows) {
    await resolveCatalogItemMeasures(deps, row.catalog_item_id, context);
  }
}

async function resolveCatalogItemMeasures(
  deps: CatalogRuntimeDeps,
  catalogItemId: string,
  context?: EventStoreContext,
) {
  const db = deps.db;
  const item = await loadCatalogProductRow(db, catalogItemId);
  if (!item) {
    return;
  }

  const profiles = await listProductMeasureProfiles(db);
  const products = enumerateProducts(item);
  const resolvedProducts = resolveProductMeasures(item, products, profiles);

  if (context) {
    const streamId = `catalog.product-measures-${catalogItemId}`;
    // `currentVersion` is the expected version this append is guarded on and
    // `lastResolved` decides whether to append at all, so both are complete-
    // history facts: a capped prefix would guard on a stale version and
    // re-append an already-resolved payload.
    const existingEvents = await readCompleteStream(deps.eventStore, { streamId });
    const currentVersion = existingEvents[existingEvents.length - 1]?.streamVersion ?? 0;
    const lastResolved = [...existingEvents]
      .reverse()
      .find((event) => event.eventType === "catalog.catalog-item.product-measures-resolved");
    if (
      JSON.stringify(lastResolved?.payload ?? null) === JSON.stringify({ catalogItemId, products: resolvedProducts })
    ) {
      return;
    }
    await deps.eventStore.appendToStream({
      streamId,
      expectedVersion: currentVersion,
      context,
      events: [
        {
          eventType: "catalog.catalog-item.product-measures-resolved",
          payload: {
            catalogItemId,
            products: toJsonValue(resolvedProducts),
          } as JsonObject,
        },
      ],
    });
    return;
  }

  await replaceResolvedProductMeasuresAtomically(db, catalogItemId, resolvedProducts);
}

async function replaceResolvedProductMeasuresAtomically(
  db: PgQueryable,
  catalogItemId: string,
  resolvedProducts: readonly ProductMeasureSnapshot[],
): Promise<void> {
  if (isPgTransactionalPool(db)) {
    await withPgTransaction(db, (client) => replaceResolvedProductMeasures(client, catalogItemId, resolvedProducts));
    return;
  }

  await replaceResolvedProductMeasures(db, catalogItemId, resolvedProducts);
}

function isPgTransactionalPool(db: PgQueryable): db is PgTransactionalPool {
  return typeof (db as { connect?: unknown }).connect === "function";
}

function resolveProductMeasures(
  item: CatalogProductRow,
  products: readonly Readonly<{
    productId: string;
    selectedOptions: readonly { dimensionId: string; optionId: string }[];
  }>[],
  profiles: Awaited<ReturnType<typeof listProductMeasureProfiles>>,
): ProductMeasureSnapshot[] {
  return products.flatMap((product) => {
    const profile = profiles.find((candidate) => profileMatches(candidate, item, product.selectedOptions));
    return profile
      ? [
          {
            ...profile.measure_snapshot,
            catalogItemId: item.catalog_item_id,
            productId: product.productId,
            selectedOptions: product.selectedOptions,
          },
        ]
      : [];
  });
}

async function replaceResolvedProductMeasures(
  db: PgQueryable,
  catalogItemId: string,
  resolvedProducts: readonly ProductMeasureSnapshot[],
): Promise<void> {
  await db.query(`DELETE FROM catalog_resolved_product_measures WHERE catalog_item_id = $1`, [catalogItemId]);
  for (const measure of resolvedProducts) {
    await db.query(
      `INSERT INTO catalog_resolved_product_measures (
         product_id,
         catalog_item_id,
         selected_options,
         measure_snapshot,
         missing_reason,
         updated_at
       ) VALUES ($1, $2, $3, $4, NULL, now())
       ON CONFLICT (product_id) DO UPDATE SET
         catalog_item_id = EXCLUDED.catalog_item_id,
         selected_options = EXCLUDED.selected_options,
         measure_snapshot = EXCLUDED.measure_snapshot,
         missing_reason = EXCLUDED.missing_reason,
         updated_at = EXCLUDED.updated_at`,
      [measure.productId, catalogItemId, JSON.stringify(measure.selectedOptions), JSON.stringify(measure)],
    );
  }
}

async function loadCatalogProductRow(db: PgQueryable, catalogItemId: string): Promise<CatalogProductRow | null> {
  const result = await db.query<CatalogProductRow>(
    `SELECT item.catalog_item_id,
       item.blueprint_id,
       item.category_ids,
       COALESCE(blueprint.dimension_rules, '[]'::jsonb) AS dimension_rules,
       COALESCE(blueprint.canonical_dimension_order, '[]'::jsonb) AS canonical_dimension_order
     FROM catalog_items AS item
     LEFT JOIN catalog_blueprints AS blueprint
       ON blueprint.blueprint_id = item.blueprint_id
     WHERE item.catalog_item_id = $1`,
    [catalogItemId],
  );
  return result.rows[0] ?? null;
}

function enumerateProducts(item: CatalogProductRow) {
  const schema = productSchemaFromCatalogProduct(item);
  if (!schema?.dimensions || schema.dimensions.length === 0) {
    return [
      {
        productId: `${item.catalog_item_id}::`,
        selectedOptions: [] as { dimensionId: string; optionId: string }[],
      },
    ];
  }

  const dimensions = schema.dimensions
    .map((dimension) => ({
      dimensionId: String(dimension.dimensionId ?? ""),
      required: Boolean(dimension.required),
      optionIds: (dimension.allowedOptions ?? [])
        .map((option) => String(option.optionId ?? ""))
        .filter((optionId) => optionId.length > 0)
        .concat((dimension.allowedOptionIds ?? []).map(String)),
      appliesWhen: (dimension.appliesWhen ?? []).map((clause) => ({
        dimensionId: String(clause.dimensionId ?? ""),
        optionIds: (clause.optionIds ?? []).map(String),
      })),
    }))
    .filter((dimension) => dimension.dimensionId.length > 0);
  const order = (schema.canonicalDimensionOrder ?? dimensions.map((dimension) => dimension.dimensionId)).map(String);
  const products: Array<{
    productId: string;
    selectedOptions: { dimensionId: string; optionId: string }[];
  }> = [];

  const visit = (index: number, selectedOptions: { dimensionId: string; optionId: string }[]) => {
    if (index >= order.length) {
      const selectedByDimension = new Map(selectedOptions.map((entry) => [entry.dimensionId, entry.optionId]));
      products.push({
        productId: `${item.catalog_item_id}::${order
          .map((dimensionId) => `${dimensionId}:${selectedByDimension.get(dimensionId) ?? "-"}`)
          .join("|")}`,
        selectedOptions: order
          .map((dimensionId) => {
            const optionId = selectedByDimension.get(dimensionId);
            return optionId ? { dimensionId, optionId } : null;
          })
          .filter((entry): entry is { dimensionId: string; optionId: string } => entry !== null),
      });
      return;
    }

    const dimensionId = order[index];
    const dimension = dimensions.find((candidate) => candidate.dimensionId === dimensionId);
    if (!dimension || !dimensionActive(dimension, selectedOptions)) {
      visit(index + 1, selectedOptions);
      return;
    }
    if (!dimension.required && dimension.optionIds.length === 0) {
      visit(index + 1, selectedOptions);
      return;
    }

    for (const optionId of [...new Set(dimension.optionIds)]) {
      visit(index + 1, [...selectedOptions, { dimensionId, optionId }]);
    }
  };

  visit(0, []);
  return products;
}

function productSchemaFromCatalogProduct(item: CatalogProductRow): ProductSchema {
  return {
    canonicalDimensionOrder: Array.isArray(item.canonical_dimension_order)
      ? item.canonical_dimension_order.map(String)
      : [],
    dimensions: Array.isArray(item.dimension_rules)
      ? item.dimension_rules.map((dimension) =>
          typeof dimension === "object" && dimension !== null
            ? (dimension as ProductDimension)
            : ({} as ProductDimension),
        )
      : [],
  };
}

function dimensionActive(
  dimension: Readonly<{
    appliesWhen: readonly Readonly<{ dimensionId: string; optionIds: readonly string[] }>[];
  }>,
  selectedOptions: readonly { dimensionId: string; optionId: string }[],
) {
  return dimension.appliesWhen.every((clause) => {
    const selectedOptionId = selectedOptions.find((entry) => entry.dimensionId === clause.dimensionId)?.optionId;
    return selectedOptionId ? clause.optionIds.includes(selectedOptionId) : false;
  });
}

function profileMatches(
  profile: Awaited<ReturnType<typeof listProductMeasureProfiles>>[number],
  item: CatalogProductRow,
  selectedOptions: readonly { dimensionId: string; optionId: string }[],
) {
  if (profile.status !== "active") {
    return false;
  }
  if (profile.match_blueprint_id && profile.match_blueprint_id !== item.blueprint_id) {
    return false;
  }
  const categoryIds = Array.isArray(item.category_ids) ? item.category_ids.map(String) : [];
  if (
    profile.match_category_ids.length > 0 &&
    !profile.match_category_ids.every((categoryId) => categoryIds.includes(categoryId))
  ) {
    return false;
  }
  return profile.match_selected_options.every((required) =>
    selectedOptions.some(
      (selected) => selected.dimensionId === required.dimensionId && selected.optionId === required.optionId,
    ),
  );
}
