import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { coerceLocalizedTextMap, resolveLocalizedTextMap, type LocalizedTextMap } from "@chase-sets/localization";
import { extractIdFromStreamId } from "../../../support/projection-support/extract-id-from-stream";

const STREAM_PREFIX = "catalog.component-";

export function buildComponentProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "catalog.component.created": async (event) => {
      const { componentId, key, name, description } = event.data as {
        componentId: string;
        key: string;
        name: LocalizedTextMap | string;
        description: LocalizedTextMap | string;
      };
      const nameI18n = coerceLocalizedTextMap(name);
      const descriptionI18n = coerceLocalizedTextMap(description ?? "");

      await db.query(
        `INSERT INTO catalog_components (component_id, key, name_i18n, name, description_i18n, description, status, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7)
         ON CONFLICT (component_id) DO UPDATE SET key = $2, name_i18n = $3, name = $4, description_i18n = $5, description = $6, updated_at = $7`,
        [
          componentId,
          key,
          JSON.stringify(nameI18n),
          resolveLocalizedTextMap(nameI18n),
          JSON.stringify(descriptionI18n),
          resolveLocalizedTextMap(descriptionI18n),
          event.timing.recordedAt,
        ],
      );
    },

    "catalog.component.field-rule-added": async (event) => {
      const componentId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { fieldId, required } = event.data as { fieldId: string; required: boolean };

      await db.query(
        `UPDATE catalog_components
         SET field_rules = field_rules || $2::jsonb, updated_at = $3
         WHERE component_id = $1`,
        [componentId, JSON.stringify([{ fieldId, required }]), event.timing.recordedAt],
      );
    },

    "catalog.component.field-rule-removed": async (event) => {
      const componentId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { fieldId } = event.data as { fieldId: string };

      await db.query(
        `UPDATE catalog_components
         SET field_rules = (
           SELECT COALESCE(jsonb_agg(rule), '[]'::jsonb)
           FROM jsonb_array_elements(field_rules) AS rule
           WHERE rule->>'fieldId' != $2
         ), updated_at = $3
         WHERE component_id = $1`,
        [componentId, fieldId, event.timing.recordedAt],
      );
    },

    "catalog.component.dimension-rule-added": async (event) => {
      const componentId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const rule = event.data;

      await db.query(
        `UPDATE catalog_components
         SET dimension_rules = dimension_rules || $2::jsonb, updated_at = $3
         WHERE component_id = $1`,
        [componentId, JSON.stringify([rule]), event.timing.recordedAt],
      );
    },

    "catalog.component.dimension-rule-removed": async (event) => {
      const componentId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { dimensionId } = event.data as { dimensionId: string };

      await db.query(
        `UPDATE catalog_components
         SET dimension_rules = (
           SELECT COALESCE(jsonb_agg(rule), '[]'::jsonb)
           FROM jsonb_array_elements(dimension_rules) AS rule
           WHERE rule->>'dimensionId' != $2
         ), updated_at = $3
         WHERE component_id = $1`,
        [componentId, dimensionId, event.timing.recordedAt],
      );
    },

    "catalog.component.rules-configured": async (event) => {
      const componentId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { key, name, description, fieldRules, dimensionRules } = event.data as {
        key: string;
        name: LocalizedTextMap | string;
        description: LocalizedTextMap | string;
        fieldRules: unknown;
        dimensionRules: unknown;
      };
      const nameI18n = coerceLocalizedTextMap(name);
      const descriptionI18n = coerceLocalizedTextMap(description ?? "");

      await db.query(
        `UPDATE catalog_components
         SET key = $2, name_i18n = $3, name = $4, description_i18n = $5, description = $6, field_rules = $7, dimension_rules = $8, updated_at = $9
         WHERE component_id = $1`,
        [
          componentId,
          key,
          JSON.stringify(nameI18n),
          resolveLocalizedTextMap(nameI18n),
          JSON.stringify(descriptionI18n),
          resolveLocalizedTextMap(descriptionI18n),
          JSON.stringify(fieldRules),
          JSON.stringify(dimensionRules),
          event.timing.recordedAt,
        ],
      );
    },

    "catalog.component.activated": async (event) => {
      const componentId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);

      await db.query(`UPDATE catalog_components SET status = 'active', updated_at = $2 WHERE component_id = $1`, [
        componentId,
        event.timing.recordedAt,
      ]);
    },

    "catalog.component.deprecated": async (event) => {
      const componentId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);

      await db.query(`UPDATE catalog_components SET status = 'deprecated', updated_at = $2 WHERE component_id = $1`, [
        componentId,
        event.timing.recordedAt,
      ]);
    },

    "catalog.component.archived": async (event) => {
      const componentId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);

      await db.query(`UPDATE catalog_components SET status = 'archived', updated_at = $2 WHERE component_id = $1`, [
        componentId,
        event.timing.recordedAt,
      ]);
    },
  };
}
