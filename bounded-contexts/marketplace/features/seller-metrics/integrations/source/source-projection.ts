import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { refreshSellerBehavioralMetrics } from "../../read-model/projection";

type SourceProjectionOptions = Readonly<{
  /** Threaded through to the summary recompute so window/threshold revisions apply without a replay. */
  resolvePolicy?: PolicyRuntime["resolvePolicy"];
}>;

export function buildSellerMetricsOrderSourceProjectionHandlers(
  db: PgQueryable,
  options: SourceProjectionOptions = {},
): ProjectorHandlerMap {
  return {
    "ordering.order.created": async (event) => {
      const data = event.data as { orderId: string; sellerAccountId: string };

      await db.query(
        `INSERT INTO marketplace_seller_metrics_order_sources (
           order_id,
           seller_account_id,
           created_at,
           ready_for_fulfillment_at,
           cancelled_at,
           cancellation_reason,
           updated_at
         ) VALUES ($1, $2, $3, NULL, NULL, NULL, $3)
         ON CONFLICT (order_id) DO UPDATE SET
           seller_account_id = EXCLUDED.seller_account_id,
           updated_at = EXCLUDED.updated_at`,
        [data.orderId, data.sellerAccountId, event.timing.recordedAt],
      );

      await refreshSellerBehavioralMetrics(db, data.sellerAccountId, event.timing.recordedAt, options.resolvePolicy);
    },
    "ordering.order.ready-for-fulfillment-recorded": async (event) => {
      const data = event.data as { orderId: string; readyForFulfillmentAt: string };

      const result = await db.query<{ seller_account_id: string }>(
        `UPDATE marketplace_seller_metrics_order_sources
         SET ready_for_fulfillment_at = $2,
             updated_at = $2
         WHERE order_id = $1
         RETURNING seller_account_id`,
        [data.orderId, data.readyForFulfillmentAt],
      );

      const sellerAccountId = result.rows[0]?.seller_account_id;
      if (sellerAccountId) {
        await refreshSellerBehavioralMetrics(db, sellerAccountId, data.readyForFulfillmentAt, options.resolvePolicy);
      }
    },
    "ordering.order.cancelled": async (event) => {
      const data = event.data as { orderId: string; cancelledAt: string; reason: string };

      const result = await db.query<{ seller_account_id: string }>(
        `UPDATE marketplace_seller_metrics_order_sources
         SET cancelled_at = $2,
             cancellation_reason = $3,
             updated_at = $2
         WHERE order_id = $1
         RETURNING seller_account_id`,
        [data.orderId, data.cancelledAt, data.reason],
      );

      const sellerAccountId = result.rows[0]?.seller_account_id;
      if (sellerAccountId) {
        await refreshSellerBehavioralMetrics(db, sellerAccountId, data.cancelledAt, options.resolvePolicy);
      }
    },
  };
}

export function buildSellerMetricsShipmentSourceProjectionHandlers(
  db: PgQueryable,
  options: SourceProjectionOptions = {},
): ProjectorHandlerMap {
  return {
    "fulfillment.shipment.created": async (event) => {
      const data = event.data as {
        shipmentId: string;
        orderId: string;
        sellerAccountId: string;
        createdAt: string;
      };

      await db.query(
        `INSERT INTO marketplace_seller_metrics_shipment_sources (
           shipment_id,
           order_id,
           seller_account_id,
           created_at,
           dispatched_at,
           updated_at
         ) VALUES ($1, $2, $3, $4, NULL, $4)
         ON CONFLICT (shipment_id) DO UPDATE SET
           order_id = EXCLUDED.order_id,
           seller_account_id = EXCLUDED.seller_account_id,
           updated_at = EXCLUDED.updated_at`,
        [data.shipmentId, data.orderId, data.sellerAccountId, data.createdAt],
      );
    },
    "fulfillment.shipment.dispatched": async (event) => {
      const data = event.data as { shipmentId: string; dispatchedAt: string };

      const result = await db.query<{ seller_account_id: string }>(
        `UPDATE marketplace_seller_metrics_shipment_sources
         SET dispatched_at = $2,
             updated_at = $2
         WHERE shipment_id = $1
         RETURNING seller_account_id`,
        [data.shipmentId, data.dispatchedAt],
      );

      const sellerAccountId = result.rows[0]?.seller_account_id;
      if (sellerAccountId) {
        await refreshSellerBehavioralMetrics(db, sellerAccountId, data.dispatchedAt, options.resolvePolicy);
      }
    },
  };
}

export function buildSellerMetricsSupportSourceProjectionHandlers(
  db: PgQueryable,
  options: SourceProjectionOptions = {},
): ProjectorHandlerMap {
  return {
    "support.support-request.resolved": async (event) => {
      const data = event.data as {
        supportRequestId: string;
        orderId: string;
        sellerAccountId: string;
        flowType?: string | null;
        resolution: { resolutionType: string; resolvedAt: string };
      };

      await db.query(
        `INSERT INTO marketplace_seller_metrics_support_request_sources (
           support_request_id,
           order_id,
           seller_account_id,
           resolution_type,
           flow_type,
           resolved_at,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $6)
         ON CONFLICT (support_request_id) DO UPDATE SET
           order_id = EXCLUDED.order_id,
           seller_account_id = EXCLUDED.seller_account_id,
           resolution_type = EXCLUDED.resolution_type,
           flow_type = EXCLUDED.flow_type,
           resolved_at = EXCLUDED.resolved_at,
           updated_at = EXCLUDED.updated_at`,
        [
          data.supportRequestId,
          data.orderId,
          data.sellerAccountId,
          data.resolution.resolutionType,
          data.flowType ?? null,
          data.resolution.resolvedAt,
        ],
      );

      await refreshSellerBehavioralMetrics(db, data.sellerAccountId, data.resolution.resolvedAt, options.resolvePolicy);
    },
  };
}
