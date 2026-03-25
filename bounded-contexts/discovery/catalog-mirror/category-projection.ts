import type { ProjectorHandlerMap } from "../../../contracts/event-core/projector";
import type { PgQueryable } from "../../../contracts/event-core/postgres/types";
import { extractIdFromStreamId } from "./helpers";

const STREAM_PREFIX = "catalog.category-";

export function buildCategoryProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "catalog.category.created": async (event) => {
      const { categoryId, key, name, description, parentCategoryId, displayOrder } = event.data as {
        categoryId: string;
        key: string;
        name: string;
        description: string;
        parentCategoryId: string | null;
        displayOrder: number;
      };

      await db.query(
        `INSERT INTO catalog_categories (category_id, key, name, description, status, parent_category_id, display_order, updated_at)
         VALUES ($1, $2, $3, $4, 'draft', $5, $6, $7)
         ON CONFLICT (category_id) DO UPDATE
         SET key = $2, name = $3, description = $4, parent_category_id = $5, display_order = $6, updated_at = $7`,
        [categoryId, key, name, description ?? "", parentCategoryId, displayOrder, event.timing.recordedAt],
      );
    },

    "catalog.category.revised": async (event) => {
      const categoryId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { key, name, description, parentCategoryId, displayOrder } = event.data as {
        key: string;
        name: string;
        description: string;
        parentCategoryId: string | null;
        displayOrder: number;
      };

      await db.query(
        `UPDATE catalog_categories
         SET key = $2, name = $3, description = $4, parent_category_id = $5, display_order = $6, updated_at = $7
         WHERE category_id = $1`,
        [categoryId, key, name, description ?? "", parentCategoryId, displayOrder, event.timing.recordedAt],
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

