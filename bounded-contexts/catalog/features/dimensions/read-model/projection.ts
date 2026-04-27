import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { extractIdFromStreamId } from "../../../support/projection-support/extract-id-from-stream";

const STREAM_PREFIX = "catalog.dimension-";

export function buildDimensionProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "catalog.dimension.created": async (event) => {
      const { dimensionId, key, name, description } = event.data as {
        dimensionId: string;
        key: string;
        name: string;
        description: string;
      };

      await db.query(
        `INSERT INTO catalog_dimensions (dimension_id, key, name, description, status, updated_at)
         VALUES ($1, $2, $3, $4, 'draft', $5)
         ON CONFLICT (dimension_id) DO UPDATE SET key = $2, name = $3, description = $4, updated_at = $5`,
        [dimensionId, key, name, description ?? "", event.timing.recordedAt],
      );
    },

    "catalog.dimension.revised": async (event) => {
      const dimensionId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { key, name, description } = event.data as { key: string; name: string; description: string };

      await db.query(
        `UPDATE catalog_dimensions SET key = $2, name = $3, description = $4, updated_at = $5 WHERE dimension_id = $1`,
        [dimensionId, key, name, description ?? "", event.timing.recordedAt],
      );
    },

    "catalog.dimension.option-added": async (event) => {
      const dimensionId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { optionId, code, labels, displayOrder, numericValue, status } = event.data as {
        optionId: string;
        code: string;
        labels: unknown;
        displayOrder: number;
        numericValue: number | null;
        status: string;
      };

      await db.query(
        `INSERT INTO catalog_dimension_options (option_id, dimension_id, code, labels, display_order, numeric_value, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (dimension_id, option_id) DO UPDATE
         SET code = $3, labels = $4, display_order = $5, numeric_value = $6, status = $7`,
        [optionId, dimensionId, code, JSON.stringify(labels), displayOrder, numericValue, status],
      );
    },

    "catalog.dimension.option-revised": async (event) => {
      const dimensionId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { optionId, code, labels, displayOrder, numericValue, status } = event.data as {
        optionId: string;
        code: string;
        labels: unknown;
        displayOrder: number;
        numericValue: number | null;
        status: string;
      };

      await db.query(
        `UPDATE catalog_dimension_options
         SET code = $3, labels = $4, display_order = $5, numeric_value = $6, status = $7
         WHERE dimension_id = $1 AND option_id = $2`,
        [dimensionId, optionId, code, JSON.stringify(labels), displayOrder, numericValue, status],
      );
    },

    "catalog.dimension.options-reordered": async (event) => {
      const dimensionId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { optionIds } = event.data as { optionIds: string[] };

      for (let i = 0; i < optionIds.length; i++) {
        await db.query(
          `UPDATE catalog_dimension_options SET display_order = $3 WHERE dimension_id = $1 AND option_id = $2`,
          [dimensionId, optionIds[i], i],
        );
      }
    },

    "catalog.dimension.option-deprecated": async (event) => {
      const dimensionId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { optionId } = event.data as { optionId: string };

      await db.query(
        `UPDATE catalog_dimension_options SET status = 'deprecated' WHERE dimension_id = $1 AND option_id = $2`,
        [dimensionId, optionId],
      );
    },

    "catalog.dimension.option-reactivated": async (event) => {
      const dimensionId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { optionId } = event.data as { optionId: string };

      await db.query(
        `UPDATE catalog_dimension_options SET status = 'active' WHERE dimension_id = $1 AND option_id = $2`,
        [dimensionId, optionId],
      );
    },

    "catalog.dimension.activated": async (event) => {
      const dimensionId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);

      await db.query(
        `UPDATE catalog_dimensions SET status = 'active', updated_at = $2 WHERE dimension_id = $1`,
        [dimensionId, event.timing.recordedAt],
      );
    },

    "catalog.dimension.deprecated": async (event) => {
      const dimensionId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);

      await db.query(
        `UPDATE catalog_dimensions SET status = 'deprecated', updated_at = $2 WHERE dimension_id = $1`,
        [dimensionId, event.timing.recordedAt],
      );
    },

    "catalog.dimension.archived": async (event) => {
      const dimensionId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);

      await db.query(
        `UPDATE catalog_dimensions SET status = 'archived', updated_at = $2 WHERE dimension_id = $1`,
        [dimensionId, event.timing.recordedAt],
      );
    },
  };
}



