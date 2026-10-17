import type { ChaseSetsEventPayloads } from "@chase-sets/event-core/public-event-payloads";
import { defineProjectorHandlers, type ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

function requireAccountId(value: unknown, eventType: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${eventType} requires a non-empty seller account.`);
  }
  return value;
}

export function buildPricingOwnSaleObservationProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return defineProjectorHandlers<
    Pick<ChaseSetsEventPayloads, "inventory.external-channel-sale.recorded" | "inventory.item.offline-sale-recorded">
  >({
    "inventory.external-channel-sale.recorded": async (event) => {
      const accountId = requireAccountId(event.data.accountId, event.type);

      await db.query(
        `INSERT INTO pricing_own_sale_observations (
           sale_event_id,
           seller_account_id,
           inventory_item_id,
           catalog_catalog_item_id,
           product_id,
           source,
           provider_key,
           offline_channel,
           requested_quantity,
           applied_quantity,
           unit_price_amount,
           currency_code,
           shipping_collected_amount,
           channel_fee_amount,
           sold_at,
           recorded_at,
           updated_at
         )
         SELECT $1, $2, $3, item.catalog_catalog_item_id, item.product_id,
                'external-channel', $4, NULL, $5, $6, $7, $8, $9, $10, $11, $12, $12
         FROM (VALUES (1)) AS seed(single_row)
         LEFT JOIN pricing_inventory_item_inputs AS item ON item.item_id = $3
         ON CONFLICT (sale_event_id) DO NOTHING`,
        [
          event.id,
          accountId,
          event.data.inventoryItemId,
          event.data.saleKey.providerKey,
          event.data.requestedQuantity,
          event.data.result.appliedQuantity,
          event.data.unitPriceAmount ?? null,
          event.data.currencyCode ?? null,
          event.data.shippingCollectedAmount ?? null,
          event.data.channelFeeAmount ?? null,
          event.data.soldAt ?? null,
          event.timing.recordedAt,
        ],
      );
    },
    "inventory.item.offline-sale-recorded": async (event) => {
      const accountId = requireAccountId(event.audit.forAccountId, event.type);

      await db.query(
        `INSERT INTO pricing_own_sale_observations (
           sale_event_id,
           seller_account_id,
           inventory_item_id,
           catalog_catalog_item_id,
           product_id,
           source,
           provider_key,
           offline_channel,
           requested_quantity,
           applied_quantity,
           unit_price_amount,
           currency_code,
           shipping_collected_amount,
           channel_fee_amount,
           sold_at,
           recorded_at,
           updated_at
         )
         SELECT $1, $2, $3, item.catalog_catalog_item_id, item.product_id,
                'offline', NULL, $4, NULL, $5, $6, NULL, NULL, NULL, NULL, $7, $7
         FROM (VALUES (1)) AS seed(single_row)
         LEFT JOIN pricing_inventory_item_inputs AS item ON item.item_id = $3
         ON CONFLICT (sale_event_id) DO NOTHING`,
        [
          event.id,
          accountId,
          event.data.itemId,
          event.data.channel,
          event.data.quantity,
          event.data.salePriceAmount,
          event.timing.recordedAt,
        ],
      );
    },
  });
}
