import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  coerceLocalizedTextMap,
  resolveLocalizedTextMap,
  type LocalizedTextMap,
} from "@chase-sets/localization";
import { extractIdFromStreamId } from "../../../support/projection-support/extract-id-from-stream";

const STREAM_PREFIX = "catalog.blueprint-";

export function buildBlueprintProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "catalog.blueprint.created": async (event) => {
      const { blueprintId, key, name, description } = event.data as {
        blueprintId: string;
        key: string;
        name: LocalizedTextMap | string;
        description: LocalizedTextMap | string;
      };
      const nameI18n = coerceLocalizedTextMap(name);
      const descriptionI18n = coerceLocalizedTextMap(description ?? "");

      await db.query(
        `INSERT INTO catalog_blueprints (blueprint_id, key, name_i18n, name, description_i18n, description, status, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7)
         ON CONFLICT (blueprint_id) DO UPDATE SET key = $2, name_i18n = $3, name = $4, description_i18n = $5, description = $6, updated_at = $7`,
        [
          blueprintId,
          key,
          JSON.stringify(nameI18n),
          resolveLocalizedTextMap(nameI18n),
          JSON.stringify(descriptionI18n),
          resolveLocalizedTextMap(descriptionI18n),
          event.timing.recordedAt,
        ],
      );
    },

    "catalog.blueprint.revised": async (event) => {
      const blueprintId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { key, name, description } = event.data as {
        key: string;
        name: LocalizedTextMap | string;
        description: LocalizedTextMap | string;
      };
      const nameI18n = coerceLocalizedTextMap(name);
      const descriptionI18n = coerceLocalizedTextMap(description ?? "");

      await db.query(
        `UPDATE catalog_blueprints
         SET key = $2, name_i18n = $3, name = $4, description_i18n = $5, description = $6, updated_at = $7
         WHERE blueprint_id = $1`,
        [
          blueprintId,
          key,
          JSON.stringify(nameI18n),
          resolveLocalizedTextMap(nameI18n),
          JSON.stringify(descriptionI18n),
          resolveLocalizedTextMap(descriptionI18n),
          event.timing.recordedAt,
        ],
      );
    },

    "catalog.blueprint.component-attached": async (event) => {
      const blueprintId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { componentId } = event.data as { componentId: string };

      await db.query(
        `UPDATE catalog_blueprints
         SET component_ids = component_ids || $2::jsonb, updated_at = $3
         WHERE blueprint_id = $1`,
        [blueprintId, JSON.stringify([componentId]), event.timing.recordedAt],
      );
    },

    "catalog.blueprint.component-detached": async (event) => {
      const blueprintId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { componentId } = event.data as { componentId: string };

      await db.query(
        `UPDATE catalog_blueprints
         SET component_ids = (
           SELECT COALESCE(jsonb_agg(cid), '[]'::jsonb)
           FROM jsonb_array_elements(component_ids) AS cid
           WHERE cid #>> '{}' != $2
         ), updated_at = $3
         WHERE blueprint_id = $1`,
        [blueprintId, componentId, event.timing.recordedAt],
      );
    },

    "catalog.blueprint.fields-set": async (event) => {
      const blueprintId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { fieldRules } = event.data as { fieldRules: unknown };

      await db.query(
        `UPDATE catalog_blueprints SET field_rules = $2, updated_at = $3 WHERE blueprint_id = $1`,
        [blueprintId, JSON.stringify(fieldRules), event.timing.recordedAt],
      );
    },

    "catalog.blueprint.dimensions-set": async (event) => {
      const blueprintId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { dimensionRules } = event.data as { dimensionRules: unknown };

      await db.query(
        `UPDATE catalog_blueprints SET dimension_rules = $2, updated_at = $3 WHERE blueprint_id = $1`,
        [blueprintId, JSON.stringify(dimensionRules), event.timing.recordedAt],
      );
    },

    "catalog.blueprint.product-resolution-rules-set": async (event) => {
      const blueprintId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { canonicalDimensionOrder } = event.data as { canonicalDimensionOrder: unknown };

      await db.query(
        `UPDATE catalog_blueprints SET canonical_dimension_order = $2, updated_at = $3 WHERE blueprint_id = $1`,
        [blueprintId, JSON.stringify(canonicalDimensionOrder), event.timing.recordedAt],
      );
    },

    "catalog.blueprint.published": async (event) => {
      const blueprintId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);

      await db.query(
        `UPDATE catalog_blueprints SET status = 'active', updated_at = $2 WHERE blueprint_id = $1`,
        [blueprintId, event.timing.recordedAt],
      );
    },

    "catalog.blueprint.deprecated": async (event) => {
      const blueprintId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);

      await db.query(
        `UPDATE catalog_blueprints SET status = 'deprecated', updated_at = $2 WHERE blueprint_id = $1`,
        [blueprintId, event.timing.recordedAt],
      );
    },

    "catalog.blueprint.archived": async (event) => {
      const blueprintId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);

      await db.query(
        `UPDATE catalog_blueprints SET status = 'archived', updated_at = $2 WHERE blueprint_id = $1`,
        [blueprintId, event.timing.recordedAt],
      );
    },
  };
}


