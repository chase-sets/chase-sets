import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { extractIdFromStreamId } from "../projection-support/extract-id-from-stream";

const STREAM_PREFIX = "catalog.item-";

export function buildCatalogItemProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "catalog.catalog-item.created": async (event) => {
      const { itemId, title, subtitle, description } = event.data as {
        itemId: string;
        title: string;
        subtitle: string | null;
        description: string;
      };

      await db.query(
        `INSERT INTO catalog_items (item_id, title, subtitle, description, status, updated_at)
         VALUES ($1, $2, $3, $4, 'draft', $5)
         ON CONFLICT (item_id) DO UPDATE SET title = $2, subtitle = $3, description = $4, updated_at = $5`,
        [itemId, title, subtitle, description ?? "", event.timing.recordedAt],
      );
    },

    "catalog.catalog-item.blueprint-assigned": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { blueprintId } = event.data as { blueprintId: string };

      await db.query(
        `UPDATE catalog_items SET blueprint_id = $2, updated_at = $3 WHERE item_id = $1`,
        [itemId, blueprintId, event.timing.recordedAt],
      );
    },

    "catalog.catalog-item.field-value-set": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { fieldId, value } = event.data as { fieldId: string; value: unknown };

      await db.query(
        `UPDATE catalog_items
         SET field_values = (
           SELECT COALESCE(jsonb_agg(fv), '[]'::jsonb)
           FROM jsonb_array_elements(field_values) AS fv
           WHERE fv->>'fieldId' != $2
         ) || $3::jsonb,
         updated_at = $4
         WHERE item_id = $1`,
        [itemId, fieldId, JSON.stringify([{ fieldId, value }]), event.timing.recordedAt],
      );
    },

    "catalog.catalog-item.field-value-cleared": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { fieldId } = event.data as { fieldId: string };

      await db.query(
        `UPDATE catalog_items
         SET field_values = (
           SELECT COALESCE(jsonb_agg(fv), '[]'::jsonb)
           FROM jsonb_array_elements(field_values) AS fv
           WHERE fv->>'fieldId' != $2
         ), updated_at = $3
         WHERE item_id = $1`,
        [itemId, fieldId, event.timing.recordedAt],
      );
    },

    "catalog.catalog-item.category-assigned": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { categoryId } = event.data as { categoryId: string };

      await db.query(
        `UPDATE catalog_items
         SET category_ids = category_ids || $2::jsonb, updated_at = $3
         WHERE item_id = $1`,
        [itemId, JSON.stringify([categoryId]), event.timing.recordedAt],
      );
    },

    "catalog.catalog-item.category-removed": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { categoryId } = event.data as { categoryId: string };

      await db.query(
        `UPDATE catalog_items
         SET category_ids = (
           SELECT COALESCE(jsonb_agg(cid), '[]'::jsonb)
           FROM jsonb_array_elements(category_ids) AS cid
           WHERE cid #>> '{}' != $2
         ), updated_at = $3
         WHERE item_id = $1`,
        [itemId, categoryId, event.timing.recordedAt],
      );
    },

    "catalog.catalog-item.published": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);

      await db.query(
        `UPDATE catalog_items SET status = 'active', updated_at = $2 WHERE item_id = $1`,
        [itemId, event.timing.recordedAt],
      );
    },

    "catalog.catalog-item.metadata-revised": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { title, subtitle, description } = event.data as { title: string; subtitle: string | null; description: string };

      await db.query(
        `UPDATE catalog_items SET title = $2, subtitle = $3, description = $4, updated_at = $5 WHERE item_id = $1`,
        [itemId, title, subtitle, description ?? "", event.timing.recordedAt],
      );
    },

    "catalog.catalog-item.tags-set": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { tags } = event.data as { tags: string[] };

      await db.query(
        `UPDATE catalog_items SET tags = $2, updated_at = $3 WHERE item_id = $1`,
        [itemId, JSON.stringify(tags), event.timing.recordedAt],
      );
    },

    "catalog.catalog-item.image-urls-set": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { imageUrls } = event.data as { imageUrls: string[] };

      await db.query(
        `UPDATE catalog_items SET image_urls = $2, updated_at = $3 WHERE item_id = $1`,
        [itemId, JSON.stringify(imageUrls), event.timing.recordedAt],
      );
    },

    "catalog.catalog-item.retired": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);

      await db.query(
        `UPDATE catalog_items SET status = 'retired', updated_at = $2 WHERE item_id = $1`,
        [itemId, event.timing.recordedAt],
      );
    },

    "catalog.catalog-item.archived": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);

      await db.query(
        `UPDATE catalog_items SET status = 'archived', updated_at = $2 WHERE item_id = $1`,
        [itemId, event.timing.recordedAt],
      );
    },
  };
}



