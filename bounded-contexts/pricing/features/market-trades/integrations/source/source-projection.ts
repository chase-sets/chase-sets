import type { ChaseSetsEventPayloads } from "@chase-sets/event-core/public-event-payloads";
import { defineProjectorHandlers, type ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { lockPayoutReviewAccounts } from "../payout-review-lock";

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
 * Trades Tape projection: normalizes Ordering, Payments, and Fulfillment lifecycle
 * events into one row per order line in `pricing_market_trades`.
 *
 * Registered against the `ordering`, `payments`, and `fulfillment` event
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
          inventoryItemId?: string;
          catalogItemId: string;
          productId: string;
          unitPriceAmount: string;
          quantity: number;
        }>;
      };
      const saleChannel = resolveSaleChannel(data.sourceType);

      const accountIds = [data.sellerAccountId, data.buyerAccountId];
      await lockPayoutReviewAccounts(db, accountIds);
      await db.query(`DELETE FROM pricing_market_trades WHERE order_id = $1 AND NOT (line_id = ANY($2::text[]))`, [
        data.orderId,
        data.lines.map((line) => line.lineId),
      ]);

      for (const line of data.lines) {
        await db.query(
          `WITH linkage AS (
             SELECT EXISTS (
               SELECT 1
               FROM pricing_market_trade_linkage_clusters AS cluster
               WHERE cluster.flagged = true
                 AND cluster.account_ids @> ARRAY[$4, $5]::text[]
             ) AS self_dealing
           )
           INSERT INTO pricing_market_trades AS trade (
             order_id,
             line_id,
             inventory_item_id,
             seller_account_id,
             buyer_account_id,
             catalog_catalog_item_id,
             product_id,
             unit_price_amount,
             currency_code,
             quantity,
             sale_channel,
             order_created_at,
             shipment_id,
             sold_at,
             settled_at,
             verified,
             excluded,
             exclusion_reason,
             updated_at
           )
           SELECT
             $1, $2, $3, $4, $5, $6, $7, $8, denomination.currency_code, $9, $10, $11, NULL, NULL, NULL, false,
             linkage.self_dealing,
             CASE WHEN linkage.self_dealing THEN 'self-dealing' ELSE NULL END,
             GREATEST($11::timestamptz, denomination.captured_at)
           FROM linkage
           LEFT JOIN pricing_market_trade_denominations AS denomination ON denomination.order_id = $1
           ON CONFLICT (order_id, line_id) DO UPDATE
           SET inventory_item_id = EXCLUDED.inventory_item_id,
               seller_account_id = EXCLUDED.seller_account_id,
               buyer_account_id = EXCLUDED.buyer_account_id,
               catalog_catalog_item_id = EXCLUDED.catalog_catalog_item_id,
               product_id = EXCLUDED.product_id,
               unit_price_amount = EXCLUDED.unit_price_amount,
               quantity = EXCLUDED.quantity,
               sale_channel = EXCLUDED.sale_channel,
               order_created_at = COALESCE(trade.order_created_at, EXCLUDED.order_created_at)`,
          [
            data.orderId,
            line.lineId,
            line.inventoryItemId ?? null,
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

      // Creation replay fills the immutable time without resetting sold,
      // shipment or terminal exclusion state on retained rows.
      await db.query(
        `WITH cutoff AS (
           SELECT MAX(placed_at) AS placed_at
           FROM pricing_market_trade_payout_review_cutoffs
           WHERE account_id = ANY($2::text[])
         ), affected AS (
           UPDATE pricing_market_trades AS trade
           SET excluded = true,
               exclusion_reason = 'fraud-flagged',
               updated_at = GREATEST(trade.updated_at, cutoff.placed_at)
           FROM cutoff
           WHERE trade.order_id = $1
             AND trade.order_created_at <= cutoff.placed_at
             AND (trade.excluded = false OR trade.exclusion_reason = 'self-dealing')
           RETURNING catalog_catalog_item_id, product_id, sold_at, cutoff.placed_at
         )
         INSERT INTO pricing_market_trade_rollup_rederive_queue (
           catalog_catalog_item_id, product_id, day, queued_at, generation
         )
         SELECT DISTINCT catalog_catalog_item_id, product_id,
                (sold_at AT TIME ZONE 'UTC')::date, placed_at, 1
         FROM affected
         WHERE sold_at IS NOT NULL
         ON CONFLICT (catalog_catalog_item_id, product_id, day) DO UPDATE
         SET queued_at = GREATEST(pricing_market_trade_rollup_rederive_queue.queued_at, EXCLUDED.queued_at),
             generation = pricing_market_trade_rollup_rederive_queue.generation + 1`,
        [data.orderId, accountIds],
      );
    },
    "ordering.order.ready-for-fulfillment-recorded": async (event) => {
      const data = event.data as {
        orderId: string;
        readyForFulfillmentAt: string;
      };

      await db.query(
        `WITH affected AS (
           UPDATE pricing_market_trades
           SET sold_at = $2,
               updated_at = $2
           WHERE order_id = $1
             AND sold_at IS NULL
           RETURNING catalog_catalog_item_id, product_id, sold_at
         )
         INSERT INTO pricing_market_trade_rollup_rederive_queue (
           catalog_catalog_item_id, product_id, day, queued_at, generation
         )
         SELECT DISTINCT catalog_catalog_item_id, product_id,
                (sold_at AT TIME ZONE 'UTC')::date, $2, 1
         FROM affected
         ON CONFLICT (catalog_catalog_item_id, product_id, day) DO UPDATE
         SET queued_at = GREATEST(
               pricing_market_trade_rollup_rederive_queue.queued_at,
               EXCLUDED.queued_at
             ),
             generation = pricing_market_trade_rollup_rederive_queue.generation + 1`,
        [data.orderId, data.readyForFulfillmentAt],
      );
    },
    "payments.payment-captured": async (event) => {
      const data = event.data as { orderIds: readonly string[]; currencyCode: string; capturedAt: string };
      if (data.orderIds.length === 0) return;

      await db.query(
        `INSERT INTO pricing_market_trade_denominations (order_id, currency_code, captured_at)
         SELECT DISTINCT order_id, upper($2), $3::timestamptz
         FROM unnest($1::text[]) AS orders(order_id)
         ON CONFLICT (order_id) DO UPDATE
         SET currency_code = EXCLUDED.currency_code,
             captured_at = EXCLUDED.captured_at`,
        [data.orderIds, data.currencyCode, data.capturedAt],
      );
      await db.query(
        `WITH affected AS (
           UPDATE pricing_market_trades AS trade
           SET currency_code = denomination.currency_code,
               updated_at = GREATEST(trade.updated_at, $2::timestamptz)
           FROM pricing_market_trade_denominations AS denomination
           WHERE trade.order_id = denomination.order_id
             AND trade.order_id = ANY($1::text[])
             AND trade.currency_code IS DISTINCT FROM denomination.currency_code
           RETURNING trade.catalog_catalog_item_id, trade.product_id, trade.sold_at
         )
         INSERT INTO pricing_market_trade_rollup_rederive_queue (
           catalog_catalog_item_id, product_id, day, queued_at, generation
         )
         SELECT DISTINCT catalog_catalog_item_id, product_id,
                (sold_at AT TIME ZONE 'UTC')::date, $2, 1
         FROM affected
         WHERE sold_at IS NOT NULL
         ON CONFLICT (catalog_catalog_item_id, product_id, day) DO UPDATE
         SET queued_at = GREATEST(pricing_market_trade_rollup_rederive_queue.queued_at, EXCLUDED.queued_at),
             generation = pricing_market_trade_rollup_rederive_queue.generation + 1`,
        [data.orderIds, data.capturedAt],
      );
    },
    "ordering.order.cancelled": async (event) => {
      const data = event.data as {
        orderId: string;
        cancelledAt: string;
      };

      await db.query(
        `WITH affected AS (
           UPDATE pricing_market_trades
           SET excluded = true,
               exclusion_reason = 'cancelled',
               updated_at = $2
           WHERE order_id = $1
             AND (excluded = false OR exclusion_reason = 'self-dealing')
           RETURNING catalog_catalog_item_id, product_id, sold_at
         )
         INSERT INTO pricing_market_trade_rollup_rederive_queue (
           catalog_catalog_item_id, product_id, day, queued_at, generation
         )
         SELECT DISTINCT catalog_catalog_item_id, product_id,
                (sold_at AT TIME ZONE 'UTC')::date, $2, 1
         FROM affected
         WHERE sold_at IS NOT NULL
         ON CONFLICT (catalog_catalog_item_id, product_id, day) DO UPDATE
         SET queued_at = GREATEST(
               pricing_market_trade_rollup_rederive_queue.queued_at,
               EXCLUDED.queued_at
             ),
             generation = pricing_market_trade_rollup_rederive_queue.generation + 1`,
        [data.orderId, data.cancelledAt],
      );
    },
    ...defineProjectorHandlers<
      Pick<ChaseSetsEventPayloads, "fulfillment.shipment.created" | "fulfillment.shipment.delivered">
    >({
      "fulfillment.shipment.created": async (event) => {
        const { data } = event;

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
        const { data } = event;

        await db.query(
          `UPDATE pricing_market_trades
         SET settled_at = $2,
             updated_at = $2
         WHERE shipment_id = $1
           AND settled_at IS NULL`,
          [data.shipmentId, data.deliveredAt],
        );
      },
    }),
    "fulfillment.shipment.returned": async (event) => {
      const data = event.data as {
        shipmentId: string;
        returnedAt: string;
      };

      await db.query(
        `WITH affected AS (
           UPDATE pricing_market_trades
           SET excluded = true,
               exclusion_reason = 'refunded',
               updated_at = $2
           WHERE shipment_id = $1
             AND (excluded = false OR exclusion_reason = 'self-dealing')
           RETURNING catalog_catalog_item_id, product_id, sold_at
         )
         INSERT INTO pricing_market_trade_rollup_rederive_queue (
           catalog_catalog_item_id, product_id, day, queued_at, generation
         )
         SELECT DISTINCT catalog_catalog_item_id, product_id,
                (sold_at AT TIME ZONE 'UTC')::date, $2, 1
         FROM affected
         WHERE sold_at IS NOT NULL
         ON CONFLICT (catalog_catalog_item_id, product_id, day) DO UPDATE
         SET queued_at = GREATEST(
               pricing_market_trade_rollup_rederive_queue.queued_at,
               EXCLUDED.queued_at
             ),
             generation = pricing_market_trade_rollup_rederive_queue.generation + 1`,
        [data.shipmentId, data.returnedAt],
      );
    },
  };
}
