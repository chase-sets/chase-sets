import type { ProjectorHandlerMap } from "../../../../contracts/event-core/projector";
import type { PgQueryable } from "../../../../contracts/event-core/postgres/types";
import { extractIdFromStreamId } from "./helpers";

const STREAM_PREFIX = "catalog.category-";

export function buildCategoryProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "catalog.category.created": async (event) => {
      const { categoryId, key, name, parentCategoryId, displayOrder } = event.data as {
        categoryId: string;
        key: string;
        name: string;
        parentCategoryId: string | null;
        displayOrder: number;
      };

      await db.query(
        `INSERT INTO catalog_categories (category_id, key, name, status, parent_category_id, display_order, updated_at)
         VALUES ($1, $2, $3, 'draft', $4, $5, $6)
         ON CONFLICT (category_id) DO UPDATE
         SET key = $2, name = $3, parent_category_id = $4, display_order = $5, updated_at = $6`,
        [categoryId, key, name, parentCategoryId, displayOrder, event.timing.recordedAt],
      );
    },

    "catalog.category.revised": async (event) => {
      const categoryId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { key, name, parentCategoryId, displayOrder } = event.data as {
        key: string;
        name: string;
        parentCategoryId: string | null;
        displayOrder: number;
      };

      await db.query(
        `UPDATE catalog_categories
         SET key = $2, name = $3, parent_category_id = $4, display_order = $5, updated_at = $6
         WHERE category_id = $1`,
        [categoryId, key, name, parentCategoryId, displayOrder, event.timing.recordedAt],
      );
    },

    "catalog.category.published": async (event) => {
      const categoryId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);

      await db.query(
        `UPDATE catalog_categories SET status = 'active', updated_at = $2 WHERE category_id = $1`,
        [categoryId, event.timing.recordedAt],
      );
    },

    "catalog.category.deprecated": async (event) => {
      const categoryId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);

      await db.query(
        `UPDATE catalog_categories SET status = 'deprecated', updated_at = $2 WHERE category_id = $1`,
        [categoryId, event.timing.recordedAt],
      );
    },

    "catalog.category.archived": async (event) => {
      const categoryId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);

      await db.query(
        `UPDATE catalog_categories SET status = 'archived', updated_at = $2 WHERE category_id = $1`,
        [categoryId, event.timing.recordedAt],
      );
    },
  };
}
