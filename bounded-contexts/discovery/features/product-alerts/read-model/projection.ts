import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export function buildProductAlertPageProjectionHandlers(
  db: PgQueryable,
): ProjectorHandlerMap {
  return {
    "discovery.product-alert.created": async (event) => {
      const data = event.data as {
        alertId: string;
        accountId: string;
        marketSide: "listing" | "offer";
        catalogItemId: string;
        productId: string;
        selectedOptions: unknown;
        productSummary: string | null;
        thresholdAmount: string | null;
      };

      await db.query(
        `INSERT INTO discovery_product_alert_pages (
          alert_id,
          account_id,
          market_side,
          catalog_catalog_item_id,
          product_id,
          selected_options,
          product_summary,
          threshold_amount,
          status,
          created_at,
          updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, 'active', $9, $9
        )
        ON CONFLICT (alert_id) DO UPDATE SET
          account_id = EXCLUDED.account_id,
          market_side = EXCLUDED.market_side,
          catalog_catalog_item_id = EXCLUDED.catalog_catalog_item_id,
          product_id = EXCLUDED.product_id,
          selected_options = EXCLUDED.selected_options,
          product_summary = EXCLUDED.product_summary,
          threshold_amount = EXCLUDED.threshold_amount,
          status = EXCLUDED.status,
          updated_at = EXCLUDED.updated_at`,
        [
          data.alertId,
          data.accountId,
          data.marketSide,
          data.catalogItemId,
          data.productId,
          JSON.stringify(Array.isArray(data.selectedOptions) ? data.selectedOptions : []),
          data.productSummary,
          data.thresholdAmount,
          event.timing.recordedAt,
        ],
      );
    },
    "discovery.product-alert.paused": async (event) => {
      await db.query(
        `UPDATE discovery_product_alert_pages
         SET status = 'paused',
             updated_at = $2
         WHERE alert_id = $1`,
        [alertIdFromStream(event.streamId), event.timing.recordedAt],
      );
    },
    "discovery.product-alert.resumed": async (event) => {
      await db.query(
        `UPDATE discovery_product_alert_pages
         SET status = 'active',
             updated_at = $2
         WHERE alert_id = $1`,
        [alertIdFromStream(event.streamId), event.timing.recordedAt],
      );
    },
    "discovery.product-alert.deleted": async (event) => {
      await db.query(
        `UPDATE discovery_product_alert_pages
         SET status = 'deleted',
             updated_at = $2
         WHERE alert_id = $1`,
        [alertIdFromStream(event.streamId), event.timing.recordedAt],
      );
    },
  };
}

function alertIdFromStream(streamId: string) {
  const prefix = "discovery.product-alert-";
  if (!streamId.startsWith(prefix)) {
    throw new Error(`Unexpected Product Alert stream id '${streamId}'.`);
  }
  return streamId.slice(prefix.length);
}
