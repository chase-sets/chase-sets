import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { extractIdFromStreamId } from "@chase-sets/event-core";
import {
  asArray,
  asStringArray,
  type DimensionRule,
  type FieldRule,
  loadAdminProjectionDependencies,
} from "../../../support/projection-support/read-model-support";

const BLUEPRINT_STREAM_PREFIX = "catalog.blueprint-";
const COMPONENT_STREAM_PREFIX = "catalog.component-";
const DIMENSION_STREAM_PREFIX = "catalog.dimension-";
const FIELD_STREAM_PREFIX = "catalog.field-";

type BaseBlueprintRow = Readonly<{
  blueprint_id: string;
  key: string;
  name_i18n: unknown;
  name: string;
  description_i18n: unknown;
  description: string;
  status: string;
  component_ids: unknown;
  field_rules: unknown;
  dimension_rules: unknown;
  canonical_dimension_order: unknown;
  updated_at: string;
}>;

export async function refreshCatalogAdminBlueprintDetailPage(db: PgQueryable, blueprintId: string): Promise<void> {
  const result = await db.query<BaseBlueprintRow>(`SELECT * FROM catalog_blueprints WHERE blueprint_id = $1`, [
    blueprintId,
  ]);

  const blueprint = result.rows[0];

  if (!blueprint) {
    await db.query(`DELETE FROM catalog_admin_blueprint_detail_pages WHERE blueprint_id = $1`, [blueprintId]);
    return;
  }

  const componentIds = asStringArray(blueprint.component_ids);
  const fieldRules = asArray<FieldRule>(blueprint.field_rules);
  const dimensionRules = asArray<DimensionRule>(blueprint.dimension_rules);
  const canonicalDimensionOrder = asStringArray(blueprint.canonical_dimension_order);
  const fieldIds = fieldRules.map((rule) => rule.fieldId);
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

  const { componentNames, fieldNames, dimensionNames, optionCodes } = await loadAdminProjectionDependencies(db, {
    componentIds,
    fieldIds,
    dimensionIds,
    optionIds,
  });

  const namedComponents = componentIds.map((componentId) => ({
    componentId,
    name: componentNames.get(componentId) ?? componentId,
  }));

  const namedFieldRules = fieldRules.map((rule) => ({
    fieldId: rule.fieldId,
    fieldName: fieldNames.get(rule.fieldId) ?? rule.fieldId,
    required: rule.required,
  }));

  const namedDimensionRules = dimensionRules.map((rule) => ({
    dimensionId: rule.dimensionId,
    dimensionName: dimensionNames.get(rule.dimensionId) ?? rule.dimensionId,
    required: rule.required,
    allowedOptions: (rule.allowedOptionIds ?? []).map((optionId) => {
      const option = optionCodes.get(optionId);
      return {
        optionId,
        code: option?.code ?? optionId,
        label: option?.label ?? option?.code ?? optionId,
        displayOrder: option?.displayOrder,
        numericValue: option?.numericValue,
      };
    }),
    appliesWhen: (rule.appliesWhen ?? []).map((clause) => ({
      dimensionId: clause.dimensionId,
      dimensionName: dimensionNames.get(clause.dimensionId) ?? clause.dimensionId,
      optionIds: clause.optionIds ?? [],
      options: (clause.optionIds ?? []).map((optionId) => {
        const option = optionCodes.get(optionId);
        return {
          optionId,
          code: option?.code ?? optionId,
          label: option?.label ?? option?.code ?? optionId,
          displayOrder: option?.displayOrder,
          numericValue: option?.numericValue,
        };
      }),
    })),
  }));

  const namedCanonicalOrder = canonicalDimensionOrder.map((dimensionId) => ({
    dimensionId,
    dimensionName: dimensionNames.get(dimensionId) ?? dimensionId,
  }));

  await db.query(
    `INSERT INTO catalog_admin_blueprint_detail_pages (
      blueprint_id,
      key,
      name_i18n,
      name,
      description_i18n,
      description,
      status,
      components,
      field_rules,
      dimension_rules,
      canonical_dimension_order,
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    ON CONFLICT (blueprint_id) DO UPDATE SET
      key = EXCLUDED.key,
      name_i18n = EXCLUDED.name_i18n,
      name = EXCLUDED.name,
      description_i18n = EXCLUDED.description_i18n,
      description = EXCLUDED.description,
      status = EXCLUDED.status,
      components = EXCLUDED.components,
      field_rules = EXCLUDED.field_rules,
      dimension_rules = EXCLUDED.dimension_rules,
      canonical_dimension_order = EXCLUDED.canonical_dimension_order,
      updated_at = EXCLUDED.updated_at`,
    [
      blueprint.blueprint_id,
      blueprint.key,
      JSON.stringify(blueprint.name_i18n),
      blueprint.name,
      JSON.stringify(blueprint.description_i18n),
      blueprint.description,
      blueprint.status,
      JSON.stringify(namedComponents),
      JSON.stringify(namedFieldRules),
      JSON.stringify(namedDimensionRules),
      JSON.stringify(namedCanonicalOrder),
      blueprint.updated_at,
    ],
  );
}

async function findBlueprintIdsByField(db: PgQueryable, fieldId: string): Promise<string[]> {
  const result = await db.query<{ blueprint_id: string }>(
    `SELECT blueprint_id FROM catalog_blueprints WHERE field_rules @> $1::jsonb`,
    [JSON.stringify([{ fieldId }])],
  );

  return result.rows.map((row) => row.blueprint_id);
}

async function findBlueprintIdsByDimension(db: PgQueryable, dimensionId: string): Promise<string[]> {
  const result = await db.query<{ blueprint_id: string }>(
    `SELECT blueprint_id
     FROM catalog_blueprints
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
        )`,
    [JSON.stringify([{ dimensionId }]), JSON.stringify([dimensionId]), dimensionId],
  );

  return result.rows.map((row) => row.blueprint_id);
}

async function findBlueprintIdsByChoice(db: PgQueryable, optionId: string): Promise<string[]> {
  const result = await db.query<{ blueprint_id: string }>(
    `SELECT blueprint_id
     FROM catalog_blueprints
     WHERE EXISTS (
       SELECT 1
       FROM jsonb_array_elements(dimension_rules) AS rule
       WHERE (rule->'allowedOptionIds') @> to_jsonb(ARRAY[$1]::text[])
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(rule->'appliesWhen', '[]'::jsonb)) AS clause
            WHERE (clause->'optionIds') @> to_jsonb(ARRAY[$1]::text[])
          )
     )`,
    [optionId],
  );

  return result.rows.map((row) => row.blueprint_id);
}

async function findBlueprintIdsByComponent(db: PgQueryable, componentId: string): Promise<string[]> {
  const result = await db.query<{ blueprint_id: string }>(
    `SELECT blueprint_id FROM catalog_blueprints WHERE component_ids @> $1::jsonb`,
    [JSON.stringify([componentId])],
  );

  return result.rows.map((row) => row.blueprint_id);
}

async function refreshBlueprintIds(db: PgQueryable, blueprintIds: readonly string[]): Promise<void> {
  for (const blueprintId of blueprintIds) {
    await refreshCatalogAdminBlueprintDetailPage(db, blueprintId);
  }
}

export function buildCatalogAdminBlueprintProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  async function refreshFieldDependents(fieldId: string) {
    await refreshBlueprintIds(db, await findBlueprintIdsByField(db, fieldId));
  }

  async function refreshDimensionDependents(dimensionId: string) {
    await refreshBlueprintIds(db, await findBlueprintIdsByDimension(db, dimensionId));
  }

  async function refreshOptionDependents(optionId: string) {
    await refreshBlueprintIds(db, await findBlueprintIdsByChoice(db, optionId));
  }

  async function refreshComponentDependents(componentId: string) {
    await refreshBlueprintIds(db, await findBlueprintIdsByComponent(db, componentId));
  }

  return {
    "catalog.blueprint.created": async (event) => {
      await refreshCatalogAdminBlueprintDetailPage(db, event.data.blueprintId as string);
    },
    "catalog.blueprint.revised": async (event) => {
      await refreshCatalogAdminBlueprintDetailPage(db, extractIdFromStreamId(event.streamId, BLUEPRINT_STREAM_PREFIX));
    },
    "catalog.blueprint.component-attached": async (event) => {
      await refreshCatalogAdminBlueprintDetailPage(db, extractIdFromStreamId(event.streamId, BLUEPRINT_STREAM_PREFIX));
    },
    "catalog.blueprint.component-detached": async (event) => {
      await refreshCatalogAdminBlueprintDetailPage(db, extractIdFromStreamId(event.streamId, BLUEPRINT_STREAM_PREFIX));
    },
    "catalog.blueprint.fields-set": async (event) => {
      await refreshCatalogAdminBlueprintDetailPage(db, extractIdFromStreamId(event.streamId, BLUEPRINT_STREAM_PREFIX));
    },
    "catalog.blueprint.dimensions-set": async (event) => {
      await refreshCatalogAdminBlueprintDetailPage(db, extractIdFromStreamId(event.streamId, BLUEPRINT_STREAM_PREFIX));
    },
    "catalog.blueprint.product-resolution-rules-set": async (event) => {
      await refreshCatalogAdminBlueprintDetailPage(db, extractIdFromStreamId(event.streamId, BLUEPRINT_STREAM_PREFIX));
    },
    "catalog.blueprint.published": async (event) => {
      await refreshCatalogAdminBlueprintDetailPage(db, extractIdFromStreamId(event.streamId, BLUEPRINT_STREAM_PREFIX));
    },
    "catalog.blueprint.deprecated": async (event) => {
      await refreshCatalogAdminBlueprintDetailPage(db, extractIdFromStreamId(event.streamId, BLUEPRINT_STREAM_PREFIX));
    },
    "catalog.blueprint.archived": async (event) => {
      await refreshCatalogAdminBlueprintDetailPage(db, extractIdFromStreamId(event.streamId, BLUEPRINT_STREAM_PREFIX));
    },

    "catalog.component.created": async (event) => {
      await refreshComponentDependents(event.data.componentId as string);
    },
    "catalog.component.rules-configured": async (event) => {
      await refreshComponentDependents(extractIdFromStreamId(event.streamId, COMPONENT_STREAM_PREFIX));
    },
    "catalog.component.activated": async (event) => {
      await refreshComponentDependents(extractIdFromStreamId(event.streamId, COMPONENT_STREAM_PREFIX));
    },
    "catalog.component.deprecated": async (event) => {
      await refreshComponentDependents(extractIdFromStreamId(event.streamId, COMPONENT_STREAM_PREFIX));
    },
    "catalog.component.archived": async (event) => {
      await refreshComponentDependents(extractIdFromStreamId(event.streamId, COMPONENT_STREAM_PREFIX));
    },

    "catalog.field.created": async (event) => {
      await refreshFieldDependents(event.data.fieldId as string);
    },
    "catalog.field.configured": async (event) => {
      await refreshFieldDependents(extractIdFromStreamId(event.streamId, FIELD_STREAM_PREFIX));
    },
    "catalog.field.activated": async (event) => {
      await refreshFieldDependents(extractIdFromStreamId(event.streamId, FIELD_STREAM_PREFIX));
    },
    "catalog.field.deprecated": async (event) => {
      await refreshFieldDependents(extractIdFromStreamId(event.streamId, FIELD_STREAM_PREFIX));
    },
    "catalog.field.archived": async (event) => {
      await refreshFieldDependents(extractIdFromStreamId(event.streamId, FIELD_STREAM_PREFIX));
    },

    "catalog.dimension.created": async (event) => {
      await refreshDimensionDependents(event.data.dimensionId as string);
    },
    "catalog.dimension.revised": async (event) => {
      await refreshDimensionDependents(extractIdFromStreamId(event.streamId, DIMENSION_STREAM_PREFIX));
    },
    "catalog.dimension.option-added": async (event) => {
      await refreshOptionDependents(event.data.optionId as string);
    },
    "catalog.dimension.option-revised": async (event) => {
      await refreshOptionDependents(event.data.optionId as string);
    },
    "catalog.dimension.options-reordered": async (event) => {
      await refreshDimensionDependents(extractIdFromStreamId(event.streamId, DIMENSION_STREAM_PREFIX));
    },
    "catalog.dimension.option-deprecated": async (event) => {
      await refreshOptionDependents(event.data.optionId as string);
    },
    "catalog.dimension.option-reactivated": async (event) => {
      await refreshOptionDependents(event.data.optionId as string);
    },
    "catalog.dimension.activated": async (event) => {
      await refreshDimensionDependents(extractIdFromStreamId(event.streamId, DIMENSION_STREAM_PREFIX));
    },
    "catalog.dimension.deprecated": async (event) => {
      await refreshDimensionDependents(extractIdFromStreamId(event.streamId, DIMENSION_STREAM_PREFIX));
    },
    "catalog.dimension.archived": async (event) => {
      await refreshDimensionDependents(extractIdFromStreamId(event.streamId, DIMENSION_STREAM_PREFIX));
    },
  };
}
