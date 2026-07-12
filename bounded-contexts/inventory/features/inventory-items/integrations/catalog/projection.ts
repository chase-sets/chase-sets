import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import { extractIdFromStreamId } from "@chase-sets/event-core";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  CATALOG_ITEM_STREAM_PREFIX,
  buildCatalogMirrorProjectionHandlers,
} from "@chase-sets/event-core-postgres/catalog-mirror";

export function buildInventoryCatalogItemProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    ...buildCatalogMirrorProjectionHandlers(db, {
      tablePrefix: "inventory_catalog",
      refreshProductSchemaOnItemPublished: true,
      blueprintDraftStatusOnUpsert: false,
      optionalHandlers: { displayIdentityResolved: true },
    }),
    "catalog.catalog-item.external-product-reference-linked": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, CATALOG_ITEM_STREAM_PREFIX);
      const { providerKey, externalKey, selectedOptions } = event.data as {
        providerKey: string;
        externalKey: string;
        selectedOptions: unknown;
      };

      await db.query(
        `INSERT INTO inventory_catalog_external_product_references (
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
    "catalog.catalog-item.external-catalog-item-reference-linked": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, CATALOG_ITEM_STREAM_PREFIX);
      const { providerKey, externalKey } = event.data as {
        providerKey: string;
        externalKey: string;
      };

      await db.query(
        `INSERT INTO inventory_catalog_external_catalog_item_references (
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
    "catalog.catalog-item.external-product-reference-unlinked": async (event) => {
      const { providerKey, externalKey } = event.data as {
        providerKey: string;
        externalKey: string;
      };

      await db.query(
        `DELETE FROM inventory_catalog_external_product_references
         WHERE provider_key = $1
           AND external_key = $2`,
        [providerKey, externalKey],
      );
    },
    "catalog.catalog-item.external-catalog-item-reference-unlinked": async (event) => {
      const { providerKey, externalKey } = event.data as {
        providerKey: string;
        externalKey: string;
      };

      await db.query(
        `DELETE FROM inventory_catalog_external_catalog_item_references
         WHERE provider_key = $1
           AND external_key = $2`,
        [providerKey, externalKey],
      );
    },
    "catalog.catalog-item.gtin-linked": async (event) => {
      const itemId = extractIdFromStreamId(event.streamId, CATALOG_ITEM_STREAM_PREFIX);
      const { gtin, productForm } = event.data as {
        gtin: string;
        productForm: string | null;
      };

      await db.query(
        `INSERT INTO inventory_catalog_gtins (
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
    "catalog.catalog-item.gtin-unlinked": async (event) => {
      const { gtin } = event.data as { gtin: string };

      await db.query(`DELETE FROM inventory_catalog_gtins WHERE gtin = $1`, [gtin]);
    },
  };
}
