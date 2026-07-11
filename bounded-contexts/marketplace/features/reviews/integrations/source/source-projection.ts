import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import { extractIdFromStreamId } from "@chase-sets/event-core";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { syncReviewEligibilityForOrder } from "./eligibility-sync";

export function buildReviewAccountProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "identity.account.created": async (event) => {
      const { accountId, displayName } = event.data as {
        accountId: string;
        displayName: string;
      };

      await db.query(
        `INSERT INTO marketplace_review_account_sources (
           account_id,
           display_name,
           status,
           updated_at
         ) VALUES ($1, $2, 'active', $3)
         ON CONFLICT (account_id) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           status = EXCLUDED.status,
           updated_at = EXCLUDED.updated_at`,
        [accountId, displayName, event.timing.recordedAt],
      );
    },
    "identity.account.profile-updated": async (event) => {
      const accountId = extractIdFromStreamId(event.streamId, "identity.account-");
      const { displayName } = event.data as { displayName: string };

      await db.query(
        `INSERT INTO marketplace_review_account_sources (
           account_id,
           display_name,
           status,
           updated_at
         ) VALUES (
           $1,
           $2,
           COALESCE((SELECT status FROM marketplace_review_account_sources WHERE account_id = $1), 'active'),
           $3
         )
         ON CONFLICT (account_id) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           updated_at = EXCLUDED.updated_at`,
        [accountId, displayName, event.timing.recordedAt],
      );
    },
    "identity.account.suspended": async (event) => {
      await db.query(
        `UPDATE marketplace_review_account_sources
         SET status = 'suspended',
             updated_at = $2
         WHERE account_id = $1`,
        [extractIdFromStreamId(event.streamId, "identity.account-"), event.timing.recordedAt],
      );
    },
    "identity.account.reactivated": async (event) => {
      await db.query(
        `UPDATE marketplace_review_account_sources
         SET status = 'active',
             updated_at = $2
         WHERE account_id = $1`,
        [extractIdFromStreamId(event.streamId, "identity.account-"), event.timing.recordedAt],
      );
    },
    "identity.account.closed": async (event) => {
      await db.query(
        `UPDATE marketplace_review_account_sources
         SET status = 'closed',
             updated_at = $2
         WHERE account_id = $1`,
        [extractIdFromStreamId(event.streamId, "identity.account-"), event.timing.recordedAt],
      );
    },
  };
}

export function buildReviewOrderSourceProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "ordering.order.created": async (event) => {
      const data = event.data as {
        orderId: string;
        buyerAccountId: string;
        sellerAccountId: string;
      };

      await db.query(
        `INSERT INTO marketplace_review_order_sources (
           order_id,
           buyer_account_id,
           seller_account_id,
           status,
           created_at,
           updated_at,
           cancelled_at,
           ready_for_fulfillment_at
         ) VALUES ($1, $2, $3, 'pending-reservation', $4, $4, NULL, NULL)
         ON CONFLICT (order_id) DO UPDATE SET
           buyer_account_id = EXCLUDED.buyer_account_id,
           seller_account_id = EXCLUDED.seller_account_id,
           status = EXCLUDED.status,
           updated_at = EXCLUDED.updated_at,
           cancelled_at = EXCLUDED.cancelled_at`,
        [data.orderId, data.buyerAccountId, data.sellerAccountId, event.timing.recordedAt],
      );

      // The shipment projection drops the eligibility upsert when the order
      // source row has not landed yet, so heal that race once the order shows up.
      await syncReviewEligibilityForOrder(db, data.orderId, event.timing.recordedAt);
    },
    "ordering.order.pending-payment-recorded": async (event) => {
      const data = event.data as {
        orderId: string;
        pendingPaymentAt: string;
      };

      await db.query(
        `UPDATE marketplace_review_order_sources
         SET status = 'pending-payment',
             updated_at = $2
         WHERE order_id = $1`,
        [data.orderId, data.pendingPaymentAt],
      );
    },
    "ordering.order.cancelled": async (event) => {
      const data = event.data as { orderId: string; cancelledAt: string };

      await db.query(
        `UPDATE marketplace_review_order_sources
         SET status = 'cancelled',
             cancelled_at = $2,
             updated_at = $2
         WHERE order_id = $1`,
        [data.orderId, data.cancelledAt],
      );
    },
    "ordering.order.ready-for-fulfillment-recorded": async (event) => {
      const data = event.data as {
        orderId: string;
        readyForFulfillmentAt: string;
      };

      await db.query(
        `UPDATE marketplace_review_order_sources
         SET status = 'ready-for-fulfillment',
             ready_for_fulfillment_at = $2,
             updated_at = $2
         WHERE order_id = $1`,
        [data.orderId, data.readyForFulfillmentAt],
      );
    },
  };
}

export function buildReviewShipmentSourceProjectionHandlers(
  db: PgQueryable,
  options: Readonly<{
    onDeliveredShipment?: (params: { shipmentId: string; deliveredAt: string }) => Promise<void>;
  }> = {},
): ProjectorHandlerMap {
  return {
    "fulfillment.shipment.created": async (event) => {
      const data = event.data as {
        shipmentId: string;
        orderId: string;
        createdAt: string;
      };

      await db.query(
        `INSERT INTO marketplace_review_shipment_sources (
           shipment_id,
           order_id,
           status,
           created_at,
           updated_at,
           dispatched_at,
           delivered_at,
           returned_at,
           exception_raised_at
         ) VALUES ($1, $2, 'awaiting-package', $3, $3, NULL, NULL, NULL, NULL)
         ON CONFLICT (shipment_id) DO UPDATE SET
           order_id = EXCLUDED.order_id,
           updated_at = EXCLUDED.updated_at`,
        [data.shipmentId, data.orderId, data.createdAt],
      );
    },
    "fulfillment.shipment.dispatched": async (event) => {
      const data = event.data as {
        shipmentId: string;
        dispatchedAt: string;
      };

      await db.query(
        `UPDATE marketplace_review_shipment_sources
         SET status = 'dispatched',
             dispatched_at = $2,
             updated_at = $2
         WHERE shipment_id = $1`,
        [data.shipmentId, data.dispatchedAt],
      );
    },
    "fulfillment.shipment.delivered": async (event) => {
      const data = event.data as {
        shipmentId: string;
        deliveredAt: string;
      };

      await db.query(
        `UPDATE marketplace_review_shipment_sources
         SET status = 'delivered',
             delivered_at = $2,
             updated_at = $2
         WHERE shipment_id = $1`,
        [data.shipmentId, data.deliveredAt],
      );

      await options.onDeliveredShipment?.(data);
    },
    "fulfillment.shipment.returned": async (event) => {
      const data = event.data as {
        shipmentId: string;
        returnedAt: string;
      };

      await db.query(
        `UPDATE marketplace_review_shipment_sources
         SET status = 'returned',
             returned_at = $2,
             updated_at = $2
         WHERE shipment_id = $1`,
        [data.shipmentId, data.returnedAt],
      );
    },
    "fulfillment.shipment.exception-raised": async (event) => {
      const data = event.data as {
        shipmentId: string;
        raisedAt: string;
      };

      await db.query(
        `UPDATE marketplace_review_shipment_sources
         SET status = 'exception',
             exception_raised_at = $2,
             updated_at = $2
         WHERE shipment_id = $1`,
        [data.shipmentId, data.raisedAt],
      );
    },
  };
}

export function buildReviewSupportSourceProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "support.support-request.opened": async (event) => {
      const data = event.data as { supportRequestId: string; orderId: string; openedAt: string };

      await db.query(
        `INSERT INTO marketplace_review_support_request_sources (
           support_request_id,
           order_id,
           status,
           resolution_type,
           flow_type,
           opened_at,
           updated_at,
           cancelled_at,
           resolved_at
         ) VALUES ($1, $2, 'open', NULL, NULL, $3, $3, NULL, NULL)
         ON CONFLICT (support_request_id) DO UPDATE
         SET order_id = EXCLUDED.order_id,
             status = EXCLUDED.status,
             resolution_type = EXCLUDED.resolution_type,
             flow_type = EXCLUDED.flow_type,
             opened_at = COALESCE(marketplace_review_support_request_sources.opened_at, EXCLUDED.opened_at),
             updated_at = EXCLUDED.updated_at,
             cancelled_at = EXCLUDED.cancelled_at,
             resolved_at = EXCLUDED.resolved_at`,
        [data.supportRequestId, data.orderId, data.openedAt],
      );

      await syncReviewEligibilityForOrder(db, data.orderId, data.openedAt);
    },
    "support.support-request.cancelled": async (event) => {
      const data = event.data as { supportRequestId: string; orderId: string; cancelledAt: string };

      await db.query(
        `INSERT INTO marketplace_review_support_request_sources (
           support_request_id,
           order_id,
           status,
           resolution_type,
           flow_type,
           opened_at,
           updated_at,
           cancelled_at,
           resolved_at
         ) VALUES ($1, $2, 'cancelled', NULL, NULL, NULL, $3, $3, NULL)
         ON CONFLICT (support_request_id) DO UPDATE
         SET order_id = EXCLUDED.order_id,
             status = EXCLUDED.status,
             resolution_type = EXCLUDED.resolution_type,
             flow_type = EXCLUDED.flow_type,
             updated_at = EXCLUDED.updated_at,
             cancelled_at = EXCLUDED.cancelled_at,
             resolved_at = EXCLUDED.resolved_at`,
        [data.supportRequestId, data.orderId, data.cancelledAt],
      );

      await syncReviewEligibilityForOrder(db, data.orderId, data.cancelledAt);
    },
    "support.support-request.resolved": async (event) => {
      const data = event.data as {
        supportRequestId: string;
        orderId: string;
        flowType?: string | null;
        resolution: { resolutionType: string; resolvedAt: string };
      };

      await db.query(
        `INSERT INTO marketplace_review_support_request_sources (
           support_request_id,
           order_id,
           status,
           resolution_type,
           flow_type,
           opened_at,
           updated_at,
           cancelled_at,
           resolved_at
         ) VALUES ($1, $2, 'resolved', $3, $4, NULL, $5, NULL, $5)
         ON CONFLICT (support_request_id) DO UPDATE
         SET order_id = EXCLUDED.order_id,
             status = EXCLUDED.status,
             resolution_type = EXCLUDED.resolution_type,
             flow_type = EXCLUDED.flow_type,
             updated_at = EXCLUDED.updated_at,
             cancelled_at = EXCLUDED.cancelled_at,
             resolved_at = EXCLUDED.resolved_at`,
        [
          data.supportRequestId,
          data.orderId,
          data.resolution.resolutionType,
          data.flowType ?? null,
          data.resolution.resolvedAt,
        ],
      );

      await syncReviewEligibilityForOrder(db, data.orderId, data.resolution.resolvedAt);
    },
  };
}
