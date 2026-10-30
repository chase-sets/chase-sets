import { resolveProjectionDb, type ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { extractIdFromStreamId } from "@chase-sets/event-core";
import {
  localizedTextMapFromEnglish,
  normalizeLocaleCode,
  resolveLocalizedTextMap,
  type LocalizedTextMap,
} from "../../../support/runtime-support/common";

const STREAM_PREFIX = "catalog.item-";

export function buildCatalogItemProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "catalog.catalog-item.created": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      const { itemId, languageCode, title, subtitle, description } = event.data as {
        itemId: string;
        languageCode?: string;
        title: LocalizedTextMap | string;
        subtitle: LocalizedTextMap | string | null;
        description: LocalizedTextMap | string;
      };
      const titleI18n = coerceLocalizedTextMap(title);
      const subtitleI18n = subtitle ? coerceLocalizedTextMap(subtitle) : null;
      const descriptionI18n = coerceLocalizedTextMap(description ?? "");

      await projectionDb.query(
        `INSERT INTO catalog_items (
           catalog_item_id,
           language_code,
           title_i18n,
           title,
           subtitle_i18n,
           subtitle,
           description_i18n,
           description,
           status,
           updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft', $9)
         ON CONFLICT (catalog_item_id) DO UPDATE SET
           language_code = EXCLUDED.language_code,
           title_i18n = EXCLUDED.title_i18n,
           title = EXCLUDED.title,
           subtitle_i18n = EXCLUDED.subtitle_i18n,
           subtitle = EXCLUDED.subtitle,
           description_i18n = EXCLUDED.description_i18n,
           description = EXCLUDED.description,
           updated_at = EXCLUDED.updated_at`,
        [
          itemId,
          normalizeLocaleCode(languageCode ?? "en"),
          JSON.stringify(titleI18n),
          resolveLocalizedTextMap(titleI18n),
          subtitleI18n ? JSON.stringify(subtitleI18n) : null,
          subtitleI18n ? resolveLocalizedTextMap(subtitleI18n) : null,
          JSON.stringify(descriptionI18n),
          resolveLocalizedTextMap(descriptionI18n),
          event.timing.recordedAt,
        ],
      );
    },

    "catalog.catalog-item.blueprint-assigned": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      const itemId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { blueprintId } = event.data as { blueprintId: string };

      await projectionDb.query(
        `UPDATE catalog_items SET blueprint_id = $2, updated_at = $3 WHERE catalog_item_id = $1`,
        [itemId, blueprintId, event.timing.recordedAt],
      );
    },

    "catalog.catalog-item.field-value-set": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      const itemId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { fieldId, value } = event.data as { fieldId: string; value: unknown };

      await projectionDb.query(
        `UPDATE catalog_items
         SET field_values = (
           SELECT COALESCE(jsonb_agg(fv), '[]'::jsonb)
           FROM jsonb_array_elements(field_values) AS fv
           WHERE fv->>'fieldId' != $2
         ) || $3::jsonb,
         updated_at = $4
         WHERE catalog_item_id = $1`,
        [itemId, fieldId, JSON.stringify([{ fieldId, value }]), event.timing.recordedAt],
      );
    },

    "catalog.catalog-item.field-value-cleared": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      const itemId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { fieldId } = event.data as { fieldId: string };

      await projectionDb.query(
        `UPDATE catalog_items
         SET field_values = (
           SELECT COALESCE(jsonb_agg(fv), '[]'::jsonb)
           FROM jsonb_array_elements(field_values) AS fv
           WHERE fv->>'fieldId' != $2
         ), updated_at = $3
         WHERE catalog_item_id = $1`,
        [itemId, fieldId, event.timing.recordedAt],
      );
    },

    "catalog.catalog-item.category-assigned": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      const itemId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { categoryId } = event.data as { categoryId: string };

      await projectionDb.query(
        `UPDATE catalog_items
         SET category_ids = CASE
               WHEN category_ids @> $2::jsonb THEN category_ids
               ELSE category_ids || $2::jsonb
             END,
             updated_at = $3
         WHERE catalog_item_id = $1`,
        [itemId, JSON.stringify([categoryId]), event.timing.recordedAt],
      );
    },

    "catalog.catalog-item.category-removed": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      const itemId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { categoryId } = event.data as { categoryId: string };

      await projectionDb.query(
        `UPDATE catalog_items
         SET category_ids = (
           SELECT COALESCE(jsonb_agg(cid), '[]'::jsonb)
           FROM jsonb_array_elements(category_ids) AS cid
           WHERE cid #>> '{}' != $2
         ), updated_at = $3
         WHERE catalog_item_id = $1`,
        [itemId, categoryId, event.timing.recordedAt],
      );
    },

    "catalog.catalog-item.published": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      const itemId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);

      await projectionDb.query(
        `UPDATE catalog_items SET status = 'active', updated_at = $2 WHERE catalog_item_id = $1`,
        [itemId, event.timing.recordedAt],
      );
    },

    "catalog.catalog-item.metadata-revised": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      const itemId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { languageCode, title, subtitle, description } = event.data as {
        languageCode?: string;
        title: LocalizedTextMap | string;
        subtitle: LocalizedTextMap | string | null;
        description: LocalizedTextMap | string;
      };
      const titleI18n = coerceLocalizedTextMap(title);
      const subtitleI18n = subtitle ? coerceLocalizedTextMap(subtitle) : null;
      const descriptionI18n = coerceLocalizedTextMap(description ?? "");

      await projectionDb.query(
        `UPDATE catalog_items
         SET language_code = $2,
             title_i18n = $3,
             title = $4,
             subtitle_i18n = $5,
             subtitle = $6,
             description_i18n = $7,
             description = $8,
             updated_at = $9
         WHERE catalog_item_id = $1`,
        [
          itemId,
          normalizeLocaleCode(languageCode ?? "en"),
          JSON.stringify(titleI18n),
          resolveLocalizedTextMap(titleI18n),
          subtitleI18n ? JSON.stringify(subtitleI18n) : null,
          subtitleI18n ? resolveLocalizedTextMap(subtitleI18n) : null,
          JSON.stringify(descriptionI18n),
          resolveLocalizedTextMap(descriptionI18n),
          event.timing.recordedAt,
        ],
      );
    },

    "catalog.catalog-item.tags-set": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      const itemId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { tags } = event.data as { tags: string[] };

      await projectionDb.query(`UPDATE catalog_items SET tags = $2, updated_at = $3 WHERE catalog_item_id = $1`, [
        itemId,
        JSON.stringify(tags),
        event.timing.recordedAt,
      ]);
    },

    "catalog.catalog-item.image-urls-set": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      const itemId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { imageUrls } = event.data as { imageUrls: string[] };

      await projectionDb.query(`UPDATE catalog_items SET image_urls = $2, updated_at = $3 WHERE catalog_item_id = $1`, [
        itemId,
        JSON.stringify(imageUrls),
        event.timing.recordedAt,
      ]);
    },

    "catalog.catalog-item.product-asset-sets-set": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      const itemId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { productAssetSets } = event.data as { productAssetSets: unknown };

      await projectionDb.query(
        `UPDATE catalog_items SET product_asset_sets = $2, updated_at = $3 WHERE catalog_item_id = $1`,
        [itemId, JSON.stringify(Array.isArray(productAssetSets) ? productAssetSets : []), event.timing.recordedAt],
      );
    },

    "catalog.catalog-item.image-fallback-set": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      const itemId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { imageFallback } = event.data as { imageFallback: unknown };

      await projectionDb.query(
        `UPDATE catalog_items SET image_fallback = $2, updated_at = $3 WHERE catalog_item_id = $1`,
        [itemId, JSON.stringify(imageFallback), event.timing.recordedAt],
      );
    },

    "catalog.catalog-item.image-fallback-cleared": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      const itemId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);

      await projectionDb.query(
        `UPDATE catalog_items SET image_fallback = NULL, updated_at = $2 WHERE catalog_item_id = $1`,
        [itemId, event.timing.recordedAt],
      );
    },

    "catalog.catalog-item.external-product-reference-linked": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      const itemId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { providerKey, externalKey, selectedOptions } = event.data as {
        providerKey: string;
        externalKey: string;
        selectedOptions: unknown;
      };

      await projectionDb.query(
        `INSERT INTO catalog_external_product_references (
           provider_key,
           external_key,
           catalog_item_id,
           selected_options,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (provider_key, external_key) DO UPDATE SET
           catalog_item_id = EXCLUDED.catalog_item_id,
           selected_options = EXCLUDED.selected_options,
           updated_at = EXCLUDED.updated_at`,
        [
          providerKey,
          externalKey,
          itemId,
          JSON.stringify(Array.isArray(selectedOptions) ? selectedOptions : []),
          event.timing.recordedAt,
        ],
      );
    },

    "catalog.catalog-item.external-catalog-item-reference-linked": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      const itemId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { providerKey, externalKey } = event.data as {
        providerKey: string;
        externalKey: string;
      };

      await projectionDb.query(
        `INSERT INTO catalog_external_catalog_item_references (
           provider_key,
           external_key,
           catalog_item_id,
           updated_at
         ) VALUES ($1, $2, $3, $4)
         ON CONFLICT (provider_key, external_key) DO UPDATE SET
           catalog_item_id = EXCLUDED.catalog_item_id,
           updated_at = EXCLUDED.updated_at`,
        [providerKey, externalKey, itemId, event.timing.recordedAt],
      );
    },

    "catalog.catalog-item.external-product-reference-unlinked": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      const { providerKey, externalKey } = event.data as {
        providerKey: string;
        externalKey: string;
      };

      await projectionDb.query(
        `DELETE FROM catalog_external_product_references
         WHERE provider_key = $1
           AND external_key = $2`,
        [providerKey, externalKey],
      );
    },

    "catalog.catalog-item.external-catalog-item-reference-unlinked": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      const { providerKey, externalKey } = event.data as {
        providerKey: string;
        externalKey: string;
      };

      await projectionDb.query(
        `DELETE FROM catalog_external_catalog_item_references
         WHERE provider_key = $1
           AND external_key = $2`,
        [providerKey, externalKey],
      );
    },

    "catalog.catalog-item.gtin-linked": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      const itemId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { gtin, productForm } = event.data as {
        gtin: string;
        productForm: string | null;
      };

      await projectionDb.query(
        `INSERT INTO catalog_item_gtins (
           gtin,
           catalog_item_id,
           product_form,
           updated_at
         ) VALUES ($1, $2, $3, $4)
         ON CONFLICT (gtin) DO UPDATE SET
           catalog_item_id = EXCLUDED.catalog_item_id,
           product_form = EXCLUDED.product_form,
           updated_at = EXCLUDED.updated_at`,
        [gtin, itemId, productForm, event.timing.recordedAt],
      );
    },

    "catalog.catalog-item.gtin-unlinked": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      const { gtin } = event.data as { gtin: string };

      await projectionDb.query(`DELETE FROM catalog_item_gtins WHERE gtin = $1`, [gtin]);
    },

    "catalog.catalog-item.retired": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      const itemId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);

      await projectionDb.query(
        `UPDATE catalog_items SET status = 'archived', updated_at = $2 WHERE catalog_item_id = $1`,
        [itemId, event.timing.recordedAt],
      );
    },

    "catalog.catalog-item.archived": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      const itemId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);

      await projectionDb.query(
        `UPDATE catalog_items SET status = 'archived', updated_at = $2 WHERE catalog_item_id = $1`,
        [itemId, event.timing.recordedAt],
      );
    },

    "catalog.catalog-item.draft-removed": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      const itemId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);

      await projectionDb.query(`DELETE FROM catalog_items WHERE catalog_item_id = $1`, [itemId]);
    },
  };
}

function coerceLocalizedTextMap(value: LocalizedTextMap | string): LocalizedTextMap {
  return typeof value === "string" ? localizedTextMapFromEnglish(value) : value;
}
