import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { coerceLocalizedTextMap, resolveLocalizedTextMap, type LocalizedTextMap } from "@chase-sets/localization";
import { extractIdFromStreamId } from "@chase-sets/event-core";

const STREAM_PREFIX = "catalog.category-";

export function buildCategoryProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "catalog.category.created": async (event) => {
      const { categoryId, key, name, description, parentCategoryId, displayOrder } = event.data as {
        categoryId: string;
        key: string;
        name: LocalizedTextMap | string;
        description: LocalizedTextMap | string;
        parentCategoryId: string | null;
        displayOrder: number;
      };
      const nameI18n = coerceLocalizedTextMap(name);
      const descriptionI18n = coerceLocalizedTextMap(description ?? "");

      await db.query(
        `INSERT INTO catalog_categories (category_id, key, name_i18n, name, description_i18n, description, status, parent_category_id, display_order, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7, $8, $9)
         ON CONFLICT (category_id) DO UPDATE
         SET key = $2, name_i18n = $3, name = $4, description_i18n = $5, description = $6, parent_category_id = $7, display_order = $8, updated_at = $9`,
        [
          categoryId,
          key,
          JSON.stringify(nameI18n),
          resolveLocalizedTextMap(nameI18n),
          JSON.stringify(descriptionI18n),
          resolveLocalizedTextMap(descriptionI18n),
          parentCategoryId,
          displayOrder,
          event.timing.recordedAt,
        ],
      );
    },

    "catalog.category.revised": async (event) => {
      const categoryId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { key, name, description, parentCategoryId, displayOrder } = event.data as {
        key: string;
        name: LocalizedTextMap | string;
        description: LocalizedTextMap | string;
        parentCategoryId: string | null;
        displayOrder: number;
      };
      const nameI18n = coerceLocalizedTextMap(name);
      const descriptionI18n = coerceLocalizedTextMap(description ?? "");

      await db.query(
        `UPDATE catalog_categories
         SET key = $2, name_i18n = $3, name = $4, description_i18n = $5, description = $6, parent_category_id = $7, display_order = $8, updated_at = $9
         WHERE category_id = $1`,
        [
          categoryId,
          key,
          JSON.stringify(nameI18n),
          resolveLocalizedTextMap(nameI18n),
          JSON.stringify(descriptionI18n),
          resolveLocalizedTextMap(descriptionI18n),
          parentCategoryId,
          displayOrder,
          event.timing.recordedAt,
        ],
      );
    },

    "catalog.category.published": async (event) => {
      const categoryId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);

      await db.query(`UPDATE catalog_categories SET status = 'active', updated_at = $2 WHERE category_id = $1`, [
        categoryId,
        event.timing.recordedAt,
      ]);
    },

    "catalog.category.deprecated": async (event) => {
      const categoryId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);

      await db.query(`UPDATE catalog_categories SET status = 'deprecated', updated_at = $2 WHERE category_id = $1`, [
        categoryId,
        event.timing.recordedAt,
      ]);
    },

    "catalog.category.archived": async (event) => {
      const categoryId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);

      await db.query(`UPDATE catalog_categories SET status = 'archived', updated_at = $2 WHERE category_id = $1`, [
        categoryId,
        event.timing.recordedAt,
      ]);
    },
  };
}
