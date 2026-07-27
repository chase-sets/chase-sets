import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { extractIdFromStreamId } from "@chase-sets/event-core";
import {
  asArray,
  type DimensionRule,
  type FieldRule,
  loadAdminProjectionDependencies,
} from "../../../support/projection-support/read-model-support";

const COMPONENT_STREAM_PREFIX = "catalog.component-";
const DIMENSION_STREAM_PREFIX = "catalog.dimension-";
const FIELD_STREAM_PREFIX = "catalog.field-";

type BaseComponentRow = Readonly<{
  component_id: string;
  key: string;
  name_i18n: unknown;
  name: string;
  description_i18n: unknown;
  description: string;
  status: string;
  field_rules: unknown;
  dimension_rules: unknown;
  updated_at: string;
}>;

export async function refreshCatalogAdminComponentDetailPage(db: PgQueryable, componentId: string): Promise<void> {
  const result = await db.query<BaseComponentRow>(`SELECT * FROM catalog_components WHERE component_id = $1`, [
    componentId,
  ]);

  const component = result.rows[0];

  if (!component) {
    await db.query(`DELETE FROM catalog_admin_component_detail_pages WHERE component_id = $1`, [componentId]);
    return;
  }

  const fieldRules = asArray<FieldRule>(component.field_rules);
  const dimensionRules = asArray<DimensionRule>(component.dimension_rules);
  const fieldIds = fieldRules.map((rule) => rule.fieldId);
  const dimensionIds = [
    ...new Set([
      ...dimensionRules.map((rule) => rule.dimensionId),
      ...dimensionRules.flatMap((rule) => (rule.appliesWhen ?? []).map((clause) => clause.dimensionId)),
    ]),
  ];
  const optionIds = dimensionRules.flatMap((rule) => [
    ...(rule.allowedOptionIds ?? []),
    ...(rule.appliesWhen ?? []).flatMap((clause) => clause.optionIds ?? []),
  ]);

  const { fieldNames, dimensionNames, optionCodes } = await loadAdminProjectionDependencies(db, {
    fieldIds,
    dimensionIds,
    optionIds,
  });

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

  await db.query(
    `INSERT INTO catalog_admin_component_detail_pages (
      component_id,
      key,
      name_i18n,
      name,
      description_i18n,
      description,
      status,
      field_rules,
      dimension_rules,
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (component_id) DO UPDATE SET
      key = EXCLUDED.key,
      name_i18n = EXCLUDED.name_i18n,
      name = EXCLUDED.name,
      description_i18n = EXCLUDED.description_i18n,
      description = EXCLUDED.description,
      status = EXCLUDED.status,
      field_rules = EXCLUDED.field_rules,
      dimension_rules = EXCLUDED.dimension_rules,
      updated_at = EXCLUDED.updated_at`,
    [
      component.component_id,
      component.key,
      JSON.stringify(component.name_i18n),
      component.name,
      JSON.stringify(component.description_i18n),
      component.description,
      component.status,
      JSON.stringify(namedFieldRules),
      JSON.stringify(namedDimensionRules),
      component.updated_at,
    ],
  );
}

async function findComponentIdsByField(db: PgQueryable, fieldId: string): Promise<string[]> {
  const result = await db.query<{ component_id: string }>(
    `SELECT component_id FROM catalog_components WHERE field_rules @> $1::jsonb`,
    [JSON.stringify([{ fieldId }])],
  );

  return result.rows.map((row) => row.component_id);
}

async function findComponentIdsByDimension(db: PgQueryable, dimensionId: string): Promise<string[]> {
  const result = await db.query<{ component_id: string }>(
    `SELECT component_id
     FROM catalog_components
     WHERE dimension_rules @> $1::jsonb
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(dimension_rules) AS rule
          WHERE EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(rule->'appliesWhen', '[]'::jsonb)) AS clause
            WHERE clause->>'dimensionId' = $2
          )
        )`,
    [JSON.stringify([{ dimensionId }]), dimensionId],
  );

  return result.rows.map((row) => row.component_id);
}

async function findComponentIdsByChoice(db: PgQueryable, optionId: string): Promise<string[]> {
  const result = await db.query<{ component_id: string }>(
    `SELECT component_id
     FROM catalog_components
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

  return result.rows.map((row) => row.component_id);
}

async function refreshComponentIds(db: PgQueryable, componentIds: readonly string[]): Promise<void> {
  for (const componentId of componentIds) {
    await refreshCatalogAdminComponentDetailPage(db, componentId);
  }
}

export function buildCatalogAdminComponentProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  async function refreshFieldDependents(fieldId: string) {
    await refreshComponentIds(db, await findComponentIdsByField(db, fieldId));
  }

  async function refreshDimensionDependents(dimensionId: string) {
    await refreshComponentIds(db, await findComponentIdsByDimension(db, dimensionId));
  }

  async function refreshOptionDependents(optionId: string) {
    await refreshComponentIds(db, await findComponentIdsByChoice(db, optionId));
  }

  return {
    "catalog.component.created": async (event) => {
      await refreshCatalogAdminComponentDetailPage(db, event.data.componentId as string);
    },
    "catalog.component.field-rule-added": async (event) => {
      await refreshCatalogAdminComponentDetailPage(db, extractIdFromStreamId(event.streamId, COMPONENT_STREAM_PREFIX));
    },
    "catalog.component.field-rule-removed": async (event) => {
      await refreshCatalogAdminComponentDetailPage(db, extractIdFromStreamId(event.streamId, COMPONENT_STREAM_PREFIX));
    },
    "catalog.component.dimension-rule-added": async (event) => {
      await refreshCatalogAdminComponentDetailPage(db, extractIdFromStreamId(event.streamId, COMPONENT_STREAM_PREFIX));
    },
    "catalog.component.dimension-rule-removed": async (event) => {
      await refreshCatalogAdminComponentDetailPage(db, extractIdFromStreamId(event.streamId, COMPONENT_STREAM_PREFIX));
    },
    "catalog.component.rules-configured": async (event) => {
      await refreshCatalogAdminComponentDetailPage(db, extractIdFromStreamId(event.streamId, COMPONENT_STREAM_PREFIX));
    },
    "catalog.component.activated": async (event) => {
      await refreshCatalogAdminComponentDetailPage(db, extractIdFromStreamId(event.streamId, COMPONENT_STREAM_PREFIX));
    },
    "catalog.component.deprecated": async (event) => {
      await refreshCatalogAdminComponentDetailPage(db, extractIdFromStreamId(event.streamId, COMPONENT_STREAM_PREFIX));
    },
    "catalog.component.archived": async (event) => {
      await refreshCatalogAdminComponentDetailPage(db, extractIdFromStreamId(event.streamId, COMPONENT_STREAM_PREFIX));
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
