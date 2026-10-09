import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { hashChannelDesiredState } from "../../listing-composition/domain/canonical";
import { tcgplayerSaleKey } from "../../tcgplayer-orders/domain/contracts";
import { tcgplayerExternalListingId } from "../../tcgplayer-csv/domain/composition";
import { fulfillmentFixture } from "../../order-fulfillment-observations/tests/fixtures";

/** Synthetic upstream mapping/sale facts only. Fulfillment acceptance must run through its real owner. */
export async function seedOrderPullSale(db: PgQueryable, connectionId: string, accountId: string, reference: string) {
  const fixture = fulfillmentFixture(reference);
  const line = fixture.lines[0]!;
  const saleKey = tcgplayerSaleKey(accountId, connectionId, reference, line);
  const observation = { ...fixture, lines: [{ ...line, providerOrderLineIdentity: saleKey.orderLineIdentity }] };
  const itemId = "item_pull_owner";
  await db.query(
    `INSERT INTO channels_inventory_item_facts
    (item_id,account_id,catalog_item_id,storage_location_id,total_quantity,updated_at,item_stream_version)
    VALUES ($1,$2,'catalog_pull_owner','location_transport',10,now(),1) ON CONFLICT DO NOTHING`,
    [itemId, accountId],
  );
  await db.query(
    `INSERT INTO channel_fulfillment_item_facts VALUES ($1,$2,'catalog_pull_owner::raw') ON CONFLICT DO NOTHING`,
    [itemId, accountId],
  );
  await db.query(
    `INSERT INTO channels_listing_publication_facts
    (listing_id,account_id,inventory_item_id,catalog_item_id,price_amount,price_currency_code,quantity_cap,
      selected_options,selected_option_key,listing_status,updated_at,listing_stream_version,item_title)
    VALUES ('listing_pull_owner',$1,$2,'catalog_pull_owner','10.00','USD',10,'[]','key','active',now(),1,'Synthetic item')
    ON CONFLICT DO NOTHING`,
    [accountId, itemId],
  );
  await db.query(
    `INSERT INTO channels_channel_listing_links
    (connection_id,listing_id,channel_listing_id,external_listing_id,last_desired_state_sequence,last_desired_listing_revision,
      last_desired_state_hash,last_desired_intent,last_desired_payload,publish_state,updated_at,last_stream_version)
    VALUES ($1,'listing_pull_owner',$2,$3,1,1,$4,'update','{}','published',now(),1) ON CONFLICT DO NOTHING`,
    [connectionId, `link_${connectionId}`, tcgplayerExternalListingId("101", "Near Mint"), "1".repeat(64)],
  );
  await db.query(
    `INSERT INTO channel_order_lines
    (connection_id,sale_key_fingerprint,facts_fingerprint,committed_sale,backdated) VALUES ($1,$2,$3,$4,false)
    ON CONFLICT DO NOTHING`,
    [
      connectionId,
      hashChannelDesiredState(saleKey),
      hashChannelDesiredState({
        productId: line.productId,
        skuId: line.skuId,
        quantity: line.quantity,
        unitPriceAmount: line.unitPriceAmount,
        soldAt: observation.orderedAt,
        currencyCode: "USD",
      }),
      JSON.stringify({
        saleKey,
        accountId,
        inventoryItemId: itemId,
        storageLocationId: "location_transport",
        requestedQuantity: line.quantity,
      }),
    ],
  );
  return observation;
}
