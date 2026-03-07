import type { ProjectorHandlerMap } from "../../../../contracts/event-core/projector";
import type { PgQueryable } from "../../../../contracts/event-core/postgres/types";
import { extractIdFromStreamId } from "./helpers";

const STREAM_PREFIX = "catalog.dimension-";

export function buildDimensionProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "catalog.dimension.created": async (event) => {
      const { dimensionId, key, name } = event.data as {
        dimensionId: string;
        key: string;
        name: string;
      };

      await db.query(
        `INSERT INTO catalog_dimensions (dimension_id, key, name, status, updated_at)
         VALUES ($1, $2, $3, 'draft', $4)
         ON CONFLICT (dimension_id) DO UPDATE SET key = $2, name = $3, updated_at = $4`,
        [dimensionId, key, name, event.timing.recordedAt],
      );
    },

    "catalog.dimension.revised": async (event) => {
      const dimensionId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { key, name } = event.data as { key: string; name: string };

      await db.query(
        `UPDATE catalog_dimensions SET key = $2, name = $3, updated_at = $4 WHERE dimension_id = $1`,
        [dimensionId, key, name, event.timing.recordedAt],
      );
    },

    "catalog.dimension.choice-added": async (event) => {
      const dimensionId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { choiceId, code, labels, displayOrder, numericValue, status } = event.data as {
        choiceId: string;
        code: string;
        labels: unknown;
        displayOrder: number;
        numericValue: number | null;
        status: string;
      };

      await db.query(
        `INSERT INTO catalog_dimension_choices (choice_id, dimension_id, code, labels, display_order, numeric_value, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (dimension_id, choice_id) DO UPDATE
         SET code = $3, labels = $4, display_order = $5, numeric_value = $6, status = $7`,
        [choiceId, dimensionId, code, JSON.stringify(labels), displayOrder, numericValue, status],
      );
    },

    "catalog.dimension.choice-revised": async (event) => {
      const dimensionId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { choiceId, code, labels, displayOrder, numericValue, status } = event.data as {
        choiceId: string;
        code: string;
        labels: unknown;
        displayOrder: number;
        numericValue: number | null;
        status: string;
      };

      await db.query(
        `UPDATE catalog_dimension_choices
         SET code = $3, labels = $4, display_order = $5, numeric_value = $6, status = $7
         WHERE dimension_id = $1 AND choice_id = $2`,
        [dimensionId, choiceId, code, JSON.stringify(labels), displayOrder, numericValue, status],
      );
    },

    "catalog.dimension.choices-reordered": async (event) => {
      const dimensionId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { choiceIds } = event.data as { choiceIds: string[] };

      for (let i = 0; i < choiceIds.length; i++) {
        await db.query(
          `UPDATE catalog_dimension_choices SET display_order = $3 WHERE dimension_id = $1 AND choice_id = $2`,
          [dimensionId, choiceIds[i], i],
        );
      }
    },

    "catalog.dimension.choice-deprecated": async (event) => {
      const dimensionId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { choiceId } = event.data as { choiceId: string };

      await db.query(
        `UPDATE catalog_dimension_choices SET status = 'deprecated' WHERE dimension_id = $1 AND choice_id = $2`,
        [dimensionId, choiceId],
      );
    },

    "catalog.dimension.choice-reactivated": async (event) => {
      const dimensionId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { choiceId } = event.data as { choiceId: string };

      await db.query(
        `UPDATE catalog_dimension_choices SET status = 'active' WHERE dimension_id = $1 AND choice_id = $2`,
        [dimensionId, choiceId],
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
