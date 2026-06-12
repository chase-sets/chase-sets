import { extractIdFromStreamId } from "@chase-sets/event-core";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import { transitionStatus, upsertRow, type PgQueryable } from "@chase-sets/event-core-postgres";

const PRODUCT_ALERT_STREAM_PREFIX = "discovery.product-alert-";
const PRODUCT_ALERT_PAGES_TABLE = "discovery_product_alert_pages";
const PRODUCT_ALERT_PAGE_INSERT_COLUMNS = [
  "alert_id",
  "account_id",
  "market_side",
  "catalog_catalog_item_id",
  "product_id",
  "selected_options",
  "product_summary",
  "threshold_amount",
  "status",
  "created_at",
  "updated_at",
] as const;
const PRODUCT_ALERT_PAGE_UPDATE_COLUMNS = [
  "account_id",
  "market_side",
  "catalog_catalog_item_id",
  "product_id",
  "selected_options",
  "product_summary",
  "threshold_amount",
  "status",
  "updated_at",
] as const;

export function buildProductAlertPageProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
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

      await upsertRow(db, {
        table: PRODUCT_ALERT_PAGES_TABLE,
        insertColumns: PRODUCT_ALERT_PAGE_INSERT_COLUMNS,
        conflictColumns: ["alert_id"],
        updateColumns: PRODUCT_ALERT_PAGE_UPDATE_COLUMNS,
        values: {
          alert_id: data.alertId,
          account_id: data.accountId,
          market_side: data.marketSide,
          catalog_catalog_item_id: data.catalogItemId,
          product_id: data.productId,
          selected_options: Array.isArray(data.selectedOptions) ? data.selectedOptions : [],
          product_summary: data.productSummary,
          threshold_amount: data.thresholdAmount,
          status: "active",
          created_at: event.timing.recordedAt,
          updated_at: event.timing.recordedAt,
        },
        casts: { selected_options: "jsonb" },
      });
    },
    "discovery.product-alert.paused": async (event) => {
      await transitionStatus(db, {
        table: PRODUCT_ALERT_PAGES_TABLE,
        idColumn: "alert_id",
        id: extractIdFromStreamId(event.streamId, PRODUCT_ALERT_STREAM_PREFIX),
        status: "paused",
        updatedAt: event.timing.recordedAt,
      });
    },
    "discovery.product-alert.resumed": async (event) => {
      await transitionStatus(db, {
        table: PRODUCT_ALERT_PAGES_TABLE,
        idColumn: "alert_id",
        id: extractIdFromStreamId(event.streamId, PRODUCT_ALERT_STREAM_PREFIX),
        status: "active",
        updatedAt: event.timing.recordedAt,
      });
    },
    "discovery.product-alert.deleted": async (event) => {
      await transitionStatus(db, {
        table: PRODUCT_ALERT_PAGES_TABLE,
        idColumn: "alert_id",
        id: extractIdFromStreamId(event.streamId, PRODUCT_ALERT_STREAM_PREFIX),
        status: "deleted",
        updatedAt: event.timing.recordedAt,
      });
    },
  };
}
