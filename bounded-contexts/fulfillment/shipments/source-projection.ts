import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

function extractIdFromStreamId(streamId: string, prefix: string): string {
  if (!streamId.startsWith(prefix)) {
    throw new Error(`Stream ID "${streamId}" does not start with prefix "${prefix}".`);
  }

  return streamId.slice(prefix.length);
}

export function buildFulfillmentAccountProjectionHandlers(
  db: PgQueryable,
): ProjectorHandlerMap {
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
        lines: Array<{
          lineId: string;
          catalogItemId: string;
          catalogVersionKey: string;
          itemTitle: string;
          itemSubtitle: string | null;
          versionSummary: string | null;
          quantity: number;
        }>;
      };

      await db.query(
        `INSERT INTO fulfillment_order_sources (
           order_id,
           buyer_account_id,
           seller_account_id,
           shipping_option,
           status,
           created_at,
           updated_at,
           ready_for_fulfillment_at,
           cancelled_at
         ) VALUES ($1, $2, $3, $4, 'pending-reservation', $5, $5, NULL, NULL)
         ON CONFLICT (order_id) DO UPDATE SET
           buyer_account_id = EXCLUDED.buyer_account_id,
           seller_account_id = EXCLUDED.seller_account_id,
           shipping_option = EXCLUDED.shipping_option,
           status = EXCLUDED.status,
           updated_at = EXCLUDED.updated_at,
           cancelled_at = EXCLUDED.cancelled_at`,
        [
          data.orderId,
          data.buyerAccountId,
          data.sellerAccountId,
          data.shippingOption,
          event.timing.recordedAt,
        ],
      );

      await db.query(
        `DELETE FROM fulfillment_order_source_lines WHERE order_id = $1`,
        [data.orderId],
      );

      for (const [index, line] of data.lines.entries()) {
        await db.query(
          `INSERT INTO fulfillment_order_source_lines (
             order_id,
             line_id,
             line_index,
             catalog_item_id,
             catalog_version_key,
             item_title,
             item_subtitle,
             version_summary,
             quantity
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (order_id, line_id) DO UPDATE SET
             line_index = EXCLUDED.line_index,
             catalog_item_id = EXCLUDED.catalog_item_id,
             catalog_version_key = EXCLUDED.catalog_version_key,
             item_title = EXCLUDED.item_title,
             item_subtitle = EXCLUDED.item_subtitle,
             version_summary = EXCLUDED.version_summary,
             quantity = EXCLUDED.quantity`,
          [
            data.orderId,
            line.lineId,
            index,
            line.catalogItemId,
            line.catalogVersionKey,
            line.itemTitle,
            line.itemSubtitle,
            line.versionSummary,
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
      });
    },
  };
}
