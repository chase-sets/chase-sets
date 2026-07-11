import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

/**
 * Ordering's own `sourceType` wire values (`@chase-sets/checkout-order-source`
 * `OrderingOrderSourceType`), duck-typed here the same way every other
 * pricing source-projection handler reads its producing context's event data
 * -- via an inline shape, not a cross-context type import.
 */
type OrderCreatedSourceType = "cart-checkout" | "buy-now" | "offer-acceptance";

/**
 * Trades Tape sale-channel vocabulary. Ordering's internal `sourceType`
 * values are translated to the tape's own channel language so the tape reads
 * naturally to pricing/analytics consumers without leaking Ordering's
 * checkout-flow-shaped enum.
 */
export type PricingMarketTradeSaleChannel = "listing" | "offer-accepted" | "buy-now";

const SALE_CHANNEL_BY_ORDER_SOURCE_TYPE: Readonly<Record<OrderCreatedSourceType, PricingMarketTradeSaleChannel>> = {
  "cart-checkout": "listing",
  "buy-now": "buy-now",
  "offer-acceptance": "offer-accepted",
};

function resolveSaleChannel(sourceType: OrderCreatedSourceType): PricingMarketTradeSaleChannel {
  return SALE_CHANNEL_BY_ORDER_SOURCE_TYPE[sourceType];
}

/**
 * Trades Tape projection: normalizes Ordering and Fulfillment lifecycle
 * events into one row per order line in `pricing_market_trades`.
 *
 * Registered against BOTH the `ordering` and `fulfillment` event
 * subscriptions in `context.json` under the single
 * `pricing-market-trades-projection` projection name (mirrors the
 * multi-source `ordering-marketplace-supply-input-projection` pattern), so
 * the returned handler map covers every event type from either source and
 * each subscription selects its own subset via `filterToEventTypes`.
 */
export function buildPricingMarketTradesProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "ordering.order.created": async (event) => {
      const data = event.data as {
        orderId: string;
        sourceType: OrderCreatedSourceType;
        buyerAccountId: string;
        sellerAccountId: string;
        lines: Array<{
          lineId: string;
          catalogItemId: string;
          productId: string;
          unitPriceAmount: string;
          quantity: number;
        }>;
      };
      const saleChannel = resolveSaleChannel(data.sourceType);

      await db.query(`DELETE FROM pricing_market_trades WHERE order_id = $1`, [data.orderId]);

      for (const line of data.lines) {
        await db.query(
          `INSERT INTO pricing_market_trades (
             order_id,
             line_id,
             seller_account_id,
             buyer_account_id,
             catalog_catalog_item_id,
             product_id,
             unit_price_amount,
             quantity,
             sale_channel,
             shipment_id,
             sold_at,
             settled_at,
             verified,
             excluded,
             exclusion_reason,
             updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, NULL, NULL, false, false, NULL, $10
           )
           ON CONFLICT (order_id, line_id) DO UPDATE
           SET seller_account_id = EXCLUDED.seller_account_id,
               buyer_account_id = EXCLUDED.buyer_account_id,
               catalog_catalog_item_id = EXCLUDED.catalog_catalog_item_id,
               product_id = EXCLUDED.product_id,
               unit_price_amount = EXCLUDED.unit_price_amount,
               quantity = EXCLUDED.quantity,
               sale_channel = EXCLUDED.sale_channel,
               updated_at = EXCLUDED.updated_at`,
          [
            data.orderId,
            line.lineId,
            data.sellerAccountId,
            data.buyerAccountId,
            line.catalogItemId,
            line.productId,
            line.unitPriceAmount,
            line.quantity,
            saleChannel,
            event.timing.recordedAt,
          ],
        );
      }
    },
    "ordering.order.ready-for-fulfillment-recorded": async (event) => {
      const data = event.data as {
        orderId: string;
        readyForFulfillmentAt: string;
      };

      await db.query(
        `UPDATE pricing_market_trades
         SET sold_at = $2,
             updated_at = $2
         WHERE order_id = $1
           AND sold_at IS NULL`,
        [data.orderId, data.readyForFulfillmentAt],
      );
    },
    "ordering.order.cancelled": async (event) => {
      const data = event.data as {
        orderId: string;
        cancelledAt: string;
      };

      await db.query(
        `UPDATE pricing_market_trades
         SET excluded = true,
             exclusion_reason = 'cancelled',
             updated_at = $2
         WHERE order_id = $1
           AND excluded = false`,
        [data.orderId, data.cancelledAt],
      );
    },
    "fulfillment.shipment.created": async (event) => {
      const data = event.data as {
        shipmentId: string;
        orderId: string;
        lines: Array<{ orderLineId: string }>;
        createdAt: string;
      };

      for (const line of data.lines) {
        await db.query(
          `UPDATE pricing_market_trades
           SET shipment_id = $3,
               updated_at = $4
           WHERE order_id = $1
             AND line_id = $2`,
          [data.orderId, line.orderLineId, data.shipmentId, event.timing.recordedAt],
        );
      }
    },
    "fulfillment.shipment.delivered": async (event) => {
      const data = event.data as {
        shipmentId: string;
        deliveredAt: string;
      };

      await db.query(
        `UPDATE pricing_market_trades
         SET settled_at = $2,
             updated_at = $2
         WHERE shipment_id = $1
           AND settled_at IS NULL`,
        [data.shipmentId, data.deliveredAt],
      );
    },
    "fulfillment.shipment.returned": async (event) => {
      const data = event.data as {
        shipmentId: string;
        returnedAt: string;
      };

      await db.query(
        `UPDATE pricing_market_trades
         SET excluded = true,
             exclusion_reason = 'refunded',
             updated_at = $2
         WHERE shipment_id = $1
           AND excluded = false`,
        [data.shipmentId, data.returnedAt],
      );
    },
  };
}
