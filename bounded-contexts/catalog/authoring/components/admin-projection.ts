import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core/postgres/types";
import { extractIdFromStreamId } from "../projection-support/extract-id-from-stream";
import {
  asArray,
  type DimensionRule,
  type FieldRule,
  loadChoiceCodeMap,
  loadNameMap,
} from "../projection-support/read-model-support";

const COMPONENT_STREAM_PREFIX = "catalog.component-";
const DIMENSION_STREAM_PREFIX = "catalog.dimension-";
const FIELD_STREAM_PREFIX = "catalog.field-";

type BaseComponentRow = Readonly<{
  component_id: string;
  key: string;
  name: string;
  description: string;
  status: string;
  field_rules: unknown;
  dimension_rules: unknown;
  updated_at: string;
}>;

export async function refreshCatalogAdminComponentDetailPage(
  db: PgQueryable,
  componentId: string,
): Promise<void> {
  const result = await db.query<BaseComponentRow>(
    `SELECT * FROM catalog_components WHERE component_id = $1`,
    [componentId],
  );

  const component = result.rows[0];

  if (!component) {
    await db.query(`DELETE FROM catalog_admin_component_detail_pages WHERE component_id = $1`, [componentId]);
    return;
  }

  const fieldRules = asArray<FieldRule>(component.field_rules);
  const dimensionRules = asArray<DimensionRule>(component.dimension_rules);
  const fieldIds = fieldRules.map((rule) => rule.fieldId);
  const dimensionIds = dimensionRules.map((rule) => rule.dimensionId);
  const choiceIds = dimensionRules.flatMap((rule) => rule.allowedChoiceIds ?? []);

  const [fieldNames, dimensionNames, choiceCodes] = await Promise.all([
    loadNameMap(db, "catalog_fields", "field_id", "name", fieldIds),
    loadNameMap(db, "catalog_dimensions", "dimension_id", "name", dimensionIds),
    loadChoiceCodeMap(db, choiceIds),
  ]);

  const namedFieldRules = fieldRules.map((rule) => ({
    fieldId: rule.fieldId,
    fieldName: fieldNames.get(rule.fieldId) ?? rule.fieldId,
    required: rule.required,
  }));

  const namedDimensionRules = dimensionRules.map((rule) => ({
    dimensionId: rule.dimensionId,
    dimensionName: dimensionNames.get(rule.dimensionId) ?? rule.dimensionId,
    required: rule.required,
    allowedChoices: (rule.allowedChoiceIds ?? []).map((choiceId) => ({
      choiceId,
      code: choiceCodes.get(choiceId) ?? choiceId,
    })),
  }));

  await db.query(
    `INSERT INTO catalog_admin_component_detail_pages (
      component_id,
      key,
      name,
      description,
      status,
      field_rules,
      dimension_rules,
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (component_id) DO UPDATE SET
      key = EXCLUDED.key,
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      status = EXCLUDED.status,
      field_rules = EXCLUDED.field_rules,
      dimension_rules = EXCLUDED.dimension_rules,
      updated_at = EXCLUDED.updated_at`,
    [
      component.component_id,
      component.key,
      component.name,
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
    `SELECT component_id FROM catalog_components WHERE dimension_rules @> $1::jsonb`,
    [JSON.stringify([{ dimensionId }])],
  );

  return result.rows.map((row) => row.component_id);
}

async function findComponentIdsByChoice(db: PgQueryable, choiceId: string): Promise<string[]> {
  const result = await db.query<{ component_id: string }>(
    `SELECT component_id
     FROM catalog_components
     WHERE EXISTS (
       SELECT 1
       FROM jsonb_array_elements(dimension_rules) AS rule
       WHERE (rule->'allowedChoiceIds') @> to_jsonb(ARRAY[$1]::text[])
     )`,
    [choiceId],
  );

  return result.rows.map((row) => row.component_id);
}

async function refreshComponentIds(db: PgQueryable, componentIds: readonly string[]): Promise<void> {
  await Promise.all(componentIds.map((componentId) => refreshCatalogAdminComponentDetailPage(db, componentId)));
}

export function buildCatalogAdminComponentProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  async function refreshFieldDependents(fieldId: string) {
    await refreshComponentIds(db, await findComponentIdsByField(db, fieldId));
  }

  async function refreshDimensionDependents(dimensionId: string) {
    await refreshComponentIds(db, await findComponentIdsByDimension(db, dimensionId));
  }

  async function refreshChoiceDependents(choiceId: string) {
    await refreshComponentIds(db, await findComponentIdsByChoice(db, choiceId));
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
    "catalog.dimension.choice-added": async (event) => {
      await refreshChoiceDependents(event.data.choiceId as string);
    },
    "catalog.dimension.choice-revised": async (event) => {
      await refreshChoiceDependents(event.data.choiceId as string);
    },
    "catalog.dimension.choices-reordered": async () => {
      // Choice order is not rendered in component detail pages.
    },
    "catalog.dimension.choice-deprecated": async (event) => {
      await refreshChoiceDependents(event.data.choiceId as string);
    },
    "catalog.dimension.choice-reactivated": async (event) => {
      await refreshChoiceDependents(event.data.choiceId as string);
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


