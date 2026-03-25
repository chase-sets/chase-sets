import type { ProjectorHandlerMap } from "../../../../contracts/event-core/projector";
import type { PgQueryable } from "../../../../contracts/event-core/postgres/types";
import { extractIdFromStreamId } from "../support/projections/extract-id-from-stream";

const STREAM_PREFIX = "catalog.field-";

export function buildFieldProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "catalog.field.created": async (event) => {
      const { fieldId, key, name, description, valueType, behavior } = event.data as {
        fieldId: string;
        key: string;
        name: string;
        description: string;
        valueType: string;
        behavior: { filterable: boolean; searchable: boolean; sortable: boolean };
      };

      await db.query(
        `INSERT INTO catalog_fields (field_id, key, name, description, status, value_type, filterable, searchable, sortable, updated_at)
         VALUES ($1, $2, $3, $4, 'draft', $5, $6, $7, $8, $9)
         ON CONFLICT (field_id) DO UPDATE
         SET key = $2, name = $3, description = $4, value_type = $5, filterable = $6, searchable = $7, sortable = $8, updated_at = $9`,
        [fieldId, key, name, description ?? "", valueType, behavior.filterable, behavior.searchable, behavior.sortable, event.timing.recordedAt],
      );
    },

    "catalog.field.configured": async (event) => {
      const fieldId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { key, name, description, valueType, behavior } = event.data as {
        key: string;
        name: string;
        description: string;
        valueType: string;
        behavior: { filterable: boolean; searchable: boolean; sortable: boolean };
      };

      await db.query(
        `UPDATE catalog_fields SET key = $2, name = $3, description = $4, value_type = $5, filterable = $6, searchable = $7, sortable = $8, updated_at = $9
         WHERE field_id = $1`,
        [fieldId, key, name, description ?? "", valueType, behavior.filterable, behavior.searchable, behavior.sortable, event.timing.recordedAt],
      );
    },

    "catalog.field.activated": async (event) => {
      const fieldId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);

      await db.query(
        `UPDATE catalog_fields SET status = 'active', updated_at = $2 WHERE field_id = $1`,
        [fieldId, event.timing.recordedAt],
      );
    },

    "catalog.field.deprecated": async (event) => {
      const fieldId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);

      await db.query(
        `UPDATE catalog_fields SET status = 'deprecated', updated_at = $2 WHERE field_id = $1`,
        [fieldId, event.timing.recordedAt],
      );
    },

    "catalog.field.archived": async (event) => {
      const fieldId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);

      await db.query(
        `UPDATE catalog_fields SET status = 'archived', updated_at = $2 WHERE field_id = $1`,
        [fieldId, event.timing.recordedAt],
      );
    },
  };
}


