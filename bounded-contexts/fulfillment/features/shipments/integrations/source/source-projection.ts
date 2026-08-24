import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { extractIdFromStreamId } from "@chase-sets/event-core";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export function buildFulfillmentAccountProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "identity.account.created": async (event) => {
      const { accountId, displayName } = event.data as {
        accountId: string;
        displayName: string;
      };

      await db.query(
        `INSERT INTO fulfillment_account_pages (
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
        `INSERT INTO fulfillment_account_pages (
           account_id,
           display_name,
           status,
           updated_at
         ) VALUES (
           $1,
           $2,
           COALESCE((SELECT status FROM fulfillment_account_pages WHERE account_id = $1), 'active'),
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
        `UPDATE fulfillment_account_pages
         SET status = 'suspended',
             updated_at = $2
         WHERE account_id = $1`,
        [extractIdFromStreamId(event.streamId, "identity.account-"), event.timing.recordedAt],
      );
    },
    "identity.account.reactivated": async (event) => {
      await db.query(
        `UPDATE fulfillment_account_pages
         SET status = 'active',
             updated_at = $2
         WHERE account_id = $1`,
        [extractIdFromStreamId(event.streamId, "identity.account-"), event.timing.recordedAt],
      );
    },
    "identity.account.closed": async (event) => {
      await db.query(
        `UPDATE fulfillment_account_pages
         SET status = 'closed',
             updated_at = $2
         WHERE account_id = $1`,
        [extractIdFromStreamId(event.streamId, "identity.account-"), event.timing.recordedAt],
      );
    },
  };
}

export function buildFulfillmentOrderProjectionHandlers(
  db: PgQueryable,
  options: Readonly<{
    onReadyForFulfillment?: (params: {
      orderId: string;
      readyForFulfillmentAt: string;
      context: EventStoreContext;
      sourceIdentity: Readonly<{ eventId: string; streamId: string; streamVersion: number; eventType: string }>;
    }) => Promise<void>;
    onOrderCancelled?: (params: {
      orderId: string;
      cancelledAt: string;
      context: EventStoreContext;
      sourceIdentity: Readonly<{ eventId: string; streamId: string; streamVersion: number; eventType: string }>;
    }) => Promise<void>;
    onFraudWarningReceived?: (params: {
      orderId: string;
      receivedAt: string;
      context: EventStoreContext;
      sourceIdentity: Readonly<{ eventId: string; streamId: string; streamVersion: number; eventType: string }>;
    }) => Promise<void>;
  }> = {},
): ProjectorHandlerMap {
  return {
    "ordering.order.created": async (event) => {
      const data = event.data as {
        orderId: string;
        buyerAccountId: string;
        sellerAccountId: string;
        shippingOption: string;
        shippingDestinationSnapshot: unknown;
        shippingOriginSnapshot: unknown;
        shippingPlanSnapshot?: unknown;
        lines: Array<{
          lineId: string;
          catalogItemId: string;
          productId: string;
          itemTitle: string;
          itemSubtitle: string | null;
          productSummary: string | null;
          quantity: number;
        }>;
      };

      await db.query(
        `INSERT INTO fulfillment_order_sources (
           order_id,
           buyer_account_id,
           seller_account_id,
           shipping_option,
           shipping_destination_snapshot,
           shipping_origin_snapshot,
           shipping_plan_snapshot,
           status,
           created_at,
           updated_at,
           ready_for_fulfillment_at,
           cancelled_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending-reservation', $8, $8, NULL, NULL)
         ON CONFLICT (order_id) DO UPDATE SET
           buyer_account_id = EXCLUDED.buyer_account_id,
           seller_account_id = EXCLUDED.seller_account_id,
           shipping_option = EXCLUDED.shipping_option,
           shipping_destination_snapshot = EXCLUDED.shipping_destination_snapshot,
           shipping_origin_snapshot = EXCLUDED.shipping_origin_snapshot,
           shipping_plan_snapshot = EXCLUDED.shipping_plan_snapshot,
           status = EXCLUDED.status,
           updated_at = EXCLUDED.updated_at,
           cancelled_at = EXCLUDED.cancelled_at`,
        [
          data.orderId,
          data.buyerAccountId,
          data.sellerAccountId,
          data.shippingOption,
          JSON.stringify(data.shippingDestinationSnapshot),
          JSON.stringify(data.shippingOriginSnapshot),
          JSON.stringify(data.shippingPlanSnapshot ?? {}),
          event.timing.recordedAt,
        ],
      );

      await db.query(`DELETE FROM fulfillment_order_source_lines WHERE order_id = $1`, [data.orderId]);

      for (const [index, line] of data.lines.entries()) {
        await db.query(
          `INSERT INTO fulfillment_order_source_lines (
             order_id,
             line_id,
             line_index,
             catalog_catalog_item_id,
             product_id,
             item_title,
             item_subtitle,
             product_summary,
             quantity
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (order_id, line_id) DO UPDATE SET
             line_index = EXCLUDED.line_index,
             catalog_catalog_item_id = EXCLUDED.catalog_catalog_item_id,
             product_id = EXCLUDED.product_id,
             item_title = EXCLUDED.item_title,
             item_subtitle = EXCLUDED.item_subtitle,
             product_summary = EXCLUDED.product_summary,
             quantity = EXCLUDED.quantity`,
          [
            data.orderId,
            line.lineId,
            index,
            line.catalogItemId,
            line.productId,
            line.itemTitle,
            line.itemSubtitle,
            line.productSummary,
            line.quantity,
          ],
        );
      }
    },
    "ordering.order.pending-payment-recorded": async (event) => {
      const data = event.data as {
        orderId: string;
        pendingPaymentAt: string;
      };

      await db.query(
        `UPDATE fulfillment_order_sources
         SET status = 'pending-payment',
             updated_at = $2
         WHERE order_id = $1`,
        [data.orderId, data.pendingPaymentAt],
      );
    },
    "ordering.order.cancelled": async (event) => {
      const data = event.data as {
        orderId: string;
        cancelledAt: string;
      };

      await db.query(
        `UPDATE fulfillment_order_sources
         SET status = 'cancelled',
             cancelled_at = $2,
             updated_at = $2
         WHERE order_id = $1`,
        [data.orderId, data.cancelledAt],
      );

      await options.onOrderCancelled?.({
        orderId: data.orderId,
        cancelledAt: data.cancelledAt,
        context: {
          tenantId: event.tenantId,
          audit: event.audit,
          trace: event.trace,
        } as EventStoreContext,
        sourceIdentity: {
          eventId: String(event.id),
          streamId: event.streamId,
          streamVersion: event.streamVersion,
          eventType: event.type,
        },
      });
    },
    "payments.payment-fraud-warning-received": async (event) => {
      const data = event.data as {
        orderIds: string[];
        receivedAt: string;
      };

      for (const orderId of data.orderIds ?? []) {
        await options.onFraudWarningReceived?.({
          orderId,
          receivedAt: data.receivedAt,
          context: {
            tenantId: event.tenantId,
            audit: event.audit,
            trace: event.trace,
          } as EventStoreContext,
          sourceIdentity: {
            eventId: String(event.id),
            streamId: event.streamId,
            streamVersion: event.streamVersion,
            eventType: event.type,
          },
        });
      }
    },
    "payments.payment-fraud-review-opened": async (event) => {
      const data = event.data as {
        paymentId: string;
        orderIds: string[];
        buyerAccountId: string;
        providerReviewId: string;
        openedAt: string;
      };

      await db.query(
        `INSERT INTO fulfillment_payment_fraud_review_holds (
           provider_review_id,
           payment_id,
           order_ids,
           buyer_account_id,
           status,
           outcome,
           opened_at,
           closed_at,
           updated_at,
           last_stream_version
         ) VALUES ($1, $2, $3::jsonb, $4, 'opened', NULL, $5, NULL, $5, $6)
         ON CONFLICT (provider_review_id) DO UPDATE
         SET payment_id = EXCLUDED.payment_id,
             order_ids = EXCLUDED.order_ids,
             buyer_account_id = EXCLUDED.buyer_account_id,
             status = 'opened',
             outcome = NULL,
             opened_at = EXCLUDED.opened_at,
             closed_at = NULL,
             updated_at = EXCLUDED.updated_at,
             last_stream_version = EXCLUDED.last_stream_version
         WHERE fulfillment_payment_fraud_review_holds.last_stream_version < EXCLUDED.last_stream_version`,
        [
          data.providerReviewId,
          data.paymentId,
          JSON.stringify(data.orderIds ?? []),
          data.buyerAccountId,
          data.openedAt,
          event.streamVersion,
        ],
      );
    },
    "payments.payment-fraud-review-closed": async (event) => {
      const data = event.data as {
        providerReviewId: string;
        outcome: string | null;
        closedAt: string;
      };

      await db.query(
        `UPDATE fulfillment_payment_fraud_review_holds
         SET status = 'closed',
             outcome = $2,
             closed_at = $3,
             updated_at = $3,
             last_stream_version = $4
         WHERE provider_review_id = $1
           AND last_stream_version < $4`,
        [data.providerReviewId, data.outcome, data.closedAt, event.streamVersion],
      );
    },
    "ordering.order.ready-for-fulfillment-recorded": async (event) => {
      const data = event.data as {
        orderId: string;
        readyForFulfillmentAt: string;
      };

      await db.query(
        `UPDATE fulfillment_order_sources
         SET status = 'ready-for-fulfillment',
             ready_for_fulfillment_at = $2,
             updated_at = $2
         WHERE order_id = $1`,
        [data.orderId, data.readyForFulfillmentAt],
      );

      await options.onReadyForFulfillment?.({
        orderId: data.orderId,
        readyForFulfillmentAt: data.readyForFulfillmentAt,
        context: {
          tenantId: event.tenantId,
          audit: event.audit,
          trace: event.trace,
        } as EventStoreContext,
        sourceIdentity: {
          eventId: String(event.id),
          streamId: event.streamId,
          streamVersion: event.streamVersion,
          eventType: event.type,
        },
      });
    },
  };
}
