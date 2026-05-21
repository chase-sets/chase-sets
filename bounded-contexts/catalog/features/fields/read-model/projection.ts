import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { coerceLocalizedTextMap, resolveLocalizedTextMap, type LocalizedTextMap } from "@chase-sets/localization";
import { extractIdFromStreamId } from "../../../support/projection-support/extract-id-from-stream";

const STREAM_PREFIX = "catalog.field-";

export function buildFieldProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "catalog.field.created": async (event) => {
      const { fieldId, key, name, description, valueType, behavior } = event.data as {
        fieldId: string;
        key: string;
        name: LocalizedTextMap | string;
        description: LocalizedTextMap | string;
        valueType: string;
        behavior: { filterable: boolean; searchable: boolean; sortable: boolean };
      };
      const nameI18n = coerceLocalizedTextMap(name);
      const descriptionI18n = coerceLocalizedTextMap(description ?? "");

      await db.query(
        `INSERT INTO catalog_fields (field_id, key, name_i18n, name, description_i18n, description, status, value_type, filterable, searchable, sortable, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7, $8, $9, $10, $11)
         ON CONFLICT (field_id) DO UPDATE
         SET key = $2, name_i18n = $3, name = $4, description_i18n = $5, description = $6, value_type = $7, filterable = $8, searchable = $9, sortable = $10, updated_at = $11`,
        [
          fieldId,
          key,
          JSON.stringify(nameI18n),
          resolveLocalizedTextMap(nameI18n),
          JSON.stringify(descriptionI18n),
          resolveLocalizedTextMap(descriptionI18n),
          valueType,
          behavior.filterable,
          behavior.searchable,
          behavior.sortable,
          event.timing.recordedAt,
        ],
      );
    },

    "catalog.field.configured": async (event) => {
      const fieldId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { key, name, description, valueType, behavior } = event.data as {
        key: string;
        name: LocalizedTextMap | string;
        description: LocalizedTextMap | string;
        valueType: string;
        behavior: { filterable: boolean; searchable: boolean; sortable: boolean };
      };
      const nameI18n = coerceLocalizedTextMap(name);
      const descriptionI18n = coerceLocalizedTextMap(description ?? "");

      await db.query(
        `UPDATE catalog_fields
         SET key = $2, name_i18n = $3, name = $4, description_i18n = $5, description = $6, value_type = $7, filterable = $8, searchable = $9, sortable = $10, updated_at = $11
         WHERE field_id = $1`,
        [
          fieldId,
          key,
          JSON.stringify(nameI18n),
          resolveLocalizedTextMap(nameI18n),
          JSON.stringify(descriptionI18n),
          resolveLocalizedTextMap(descriptionI18n),
          valueType,
          behavior.filterable,
          behavior.searchable,
          behavior.sortable,
          event.timing.recordedAt,
        ],
      );
    },

    "catalog.field.activated": async (event) => {
      const fieldId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);

      await db.query(`UPDATE catalog_fields SET status = 'active', updated_at = $2 WHERE field_id = $1`, [
        fieldId,
        event.timing.recordedAt,
      ]);
    },

    "catalog.field.deprecated": async (event) => {
      const fieldId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);

      await db.query(`UPDATE catalog_fields SET status = 'deprecated', updated_at = $2 WHERE field_id = $1`, [
        fieldId,
        event.timing.recordedAt,
      ]);
    },

    "catalog.field.archived": async (event) => {
      const fieldId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);

      await db.query(`UPDATE catalog_fields SET status = 'archived', updated_at = $2 WHERE field_id = $1`, [
        fieldId,
        event.timing.recordedAt,
      ]);
    },
  };
}
