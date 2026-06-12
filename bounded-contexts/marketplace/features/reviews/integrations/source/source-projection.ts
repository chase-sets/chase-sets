import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import { extractIdFromStreamId, type PgQueryable } from "@chase-sets/event-core-postgres";

export function buildReviewAccountProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "identity.account.created": async (event) => {
      const { accountId, displayName } = event.data as {
        accountId: string;
        displayName: string;
      };

      await db.query(
        `INSERT INTO reputation_account_pages (
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
        `INSERT INTO reputation_account_pages (
           account_id,
           display_name,
           status,
           updated_at
         ) VALUES (
           $1,
           $2,
           COALESCE((SELECT status FROM reputation_account_pages WHERE account_id = $1), 'active'),
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
        `UPDATE reputation_account_pages
         SET status = 'suspended',
             updated_at = $2
         WHERE account_id = $1`,
        [extractIdFromStreamId(event.streamId, "identity.account-"), event.timing.recordedAt],
      );
    },
    "identity.account.reactivated": async (event) => {
      await db.query(
        `UPDATE reputation_account_pages
         SET status = 'active',
             updated_at = $2
         WHERE account_id = $1`,
        [extractIdFromStreamId(event.streamId, "identity.account-"), event.timing.recordedAt],
      );
    },
    "identity.account.closed": async (event) => {
      await db.query(
        `UPDATE reputation_account_pages
         SET status = 'closed',
             updated_at = $2
         WHERE account_id = $1`,
        [extractIdFromStreamId(event.streamId, "identity.account-"), event.timing.recordedAt],
      );
    },
  };
}

export function buildReputationOrderProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "ordering.order.created": async (event) => {
      const data = event.data as {
        orderId: string;
        buyerAccountId: string;
        sellerAccountId: string;
      };

      await db.query(
        `INSERT INTO reputation_order_sources (
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
      await restoreEligibilityIfDelivered(db, data.orderId, event.timing.recordedAt);
    },
    "ordering.order.pending-payment-recorded": async (event) => {
      const data = event.data as {
        orderId: string;
        pendingPaymentAt: string;
      };

      await db.query(
        `UPDATE reputation_order_sources
         SET status = 'pending-payment',
             updated_at = $2
         WHERE order_id = $1`,
        [data.orderId, data.pendingPaymentAt],
      );
    },
    "ordering.order.cancelled": async (event) => {
      const data = event.data as { orderId: string; cancelledAt: string };

      await db.query(
        `UPDATE reputation_order_sources
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
        `UPDATE reputation_order_sources
         SET status = 'ready-for-fulfillment',
             ready_for_fulfillment_at = $2,
             updated_at = $2
         WHERE order_id = $1`,
        [data.orderId, data.readyForFulfillmentAt],
      );
    },
  };
}

export function buildReputationShipmentProjectionHandlers(
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
        `INSERT INTO reputation_shipment_sources (
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
        `UPDATE reputation_shipment_sources
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
        `UPDATE reputation_shipment_sources
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
        `UPDATE reputation_shipment_sources
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
        `UPDATE reputation_shipment_sources
         SET status = 'exception',
             exception_raised_at = $2,
             updated_at = $2
         WHERE shipment_id = $1`,
        [data.shipmentId, data.raisedAt],
      );
    },
  };
}

async function restoreEligibilityIfDelivered(db: PgQueryable, orderId: string, eligibleAt: string) {
  const result = await db.query<{
    buyer_account_id: string;
    seller_account_id: string;
    delivered_at: string;
  }>(
    `SELECT
       order_source.buyer_account_id,
       order_source.seller_account_id,
       shipment_source.delivered_at::text AS delivered_at
     FROM reputation_order_sources order_source
     JOIN reputation_shipment_sources shipment_source
       ON shipment_source.order_id = order_source.order_id
      AND shipment_source.status = 'delivered'
     WHERE order_source.order_id = $1
     ORDER BY shipment_source.delivered_at ASC
     LIMIT 1`,
    [orderId],
  );
  const row = result.rows[0];
  if (!row) {
    return;
  }
  const restoredAt = row.delivered_at ?? eligibleAt;

  await db.query(
    `INSERT INTO reputation_review_eligibility_pages (
       order_id,
       author_account_id,
       subject_account_id,
       author_role,
       eligible_at,
       updated_at
     ) VALUES
       ($1, $2, $3, 'buyer', $4, $5),
       ($1, $3, $2, 'seller', $4, $5)
     ON CONFLICT (order_id, author_account_id, subject_account_id) DO UPDATE
     SET eligible_at = EXCLUDED.eligible_at,
         updated_at = EXCLUDED.updated_at`,
    [orderId, row.buyer_account_id, row.seller_account_id, restoredAt, eligibleAt],
  );
}

export function buildReputationSupportProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "support.support-request.opened": async (event) => {
      const data = event.data as { orderId: string };

      await db.query(
        `DELETE FROM reputation_review_eligibility_pages
         WHERE order_id = $1`,
        [data.orderId],
      );
    },
    "support.support-request.cancelled": async (event) => {
      const data = event.data as { orderId: string; cancelledAt: string };
      await restoreEligibilityIfDelivered(db, data.orderId, data.cancelledAt);
    },
    "support.support-request.resolved": async (event) => {
      const data = event.data as {
        orderId: string;
        resolution: { resolutionType: string; resolvedAt: string };
      };
      if (data.resolution.resolutionType === "no-action" || data.resolution.resolutionType === "support-reviewed") {
        await restoreEligibilityIfDelivered(db, data.orderId, data.resolution.resolvedAt);
      }
    },
  };
}
