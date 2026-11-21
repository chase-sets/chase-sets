import { describe, expect, it } from "vitest";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { buildMarketplaceOfferProjectionHandlers } from "./projection";

describe("Offer realtime topics", () => {
  it("publishes a seller's Match only on their Offer Match topic and the buyer's Offer on the Offers topic", async () => {
    const offerColumns = {
      offer_id: "off_one",
      buyer_account_id: "acc_buyer",
      catalog_catalog_item_id: "cat_one",
      product_id: "cat_one::",
      item_title: "Item",
      item_subtitle: null,
      selected_options: [],
      product_summary: null,
      shipping_destination_snapshot: {},
      price_amount: "12.00",
      price_currency_code: "USD",
      last_stream_version: 2,
      quantity_requested: 1,
      status: "submitted",
      accepted_seller_account_id: null,
      accepted_listing_id: null,
      accepted_inventory_item_id: null,
      listing_evidence_policy_hash: null,
      listing_evidence_snapshot_hash: null,
      accepted_at: null,
      created_at: "2026-11-21T00:00:00.000Z",
      updated_at: "2026-11-21T00:00:00.000Z",
    };
    const outbox: { patchKey: string; topics: string[]; changes: { entity: string; value?: object }[] }[] = [];
    const db: PgQueryable = {
      async query<Row>(sql: string, values: readonly unknown[] = []) {
        if (sql.includes("INSERT INTO realtime_projection_outbox (")) {
          outbox.push({
            patchKey: values[2] as string,
            topics: JSON.parse(values[3] as string),
            changes: JSON.parse(values[4] as string).changes,
          });
          return { rows: [{ outbox_id: String(outbox.length) }] as Row[] };
        }
        if (sql.includes("WITH seller_accounts")) {
          const inventoryMatch = {
            ...offerColumns,
            seller_account_id: "acc_seller",
            buyer_display_name: "Buyer",
            buyer_average_rating: null,
            buyer_review_count: 0,
            managed_status: null,
            fill_source: "inventory",
            inventory_item_id: "inv_private",
            inventory_available_quantity: 7,
          };
          return { rows: [inventoryMatch] as Row[] };
        }
        if (sql.includes("UNION")) return { rows: [{ account_id: "acc_seller" }] as Row[] };
        if (sql.includes("AS offers_away")) return { rows: [{ ...offerColumns, offers_away: false }] as Row[] };
        return { rows: [] as Row[] };
      },
    };

    await buildMarketplaceOfferProjectionHandlers(db)["marketplace.offer.price-updated"]!(
      buildTransportEvent(
        "marketplace.offer.price-updated",
        { offerId: "off_one", priceAmount: "12.00", priceCurrencyCode: "USD" },
        { streamId: "marketplace.offer-off_one", streamVersion: 2, globalPosition: "7" },
      ),
    );

    expect(outbox.map(({ patchKey, topics }) => ({ patchKey, topics }))).toEqual([
      { patchKey: "offer:off_one", topics: ["account:acc_buyer:offers"] },
      { patchKey: "offer-match:off_one:acc_seller", topics: ["account:acc_seller:offer-matches"] },
    ]);
    const [buyerPatch, matchPatch] = outbox;
    expect(buyerPatch!.changes.map((change) => change.entity)).toEqual(["marketplace.offer"]);
    expect(matchPatch!.changes).toEqual([
      expect.objectContaining({
        entity: "marketplace.offerMatch",
        value: expect.objectContaining({ fill_source: "inventory", inventory_item_id: "inv_private" }),
      }),
    ]);
    for (const key of ["accepted_listing_id", "listing_evidence_policy_hash", "listing_evidence_snapshot_hash"]) {
      expect(matchPatch!.changes[0]!.value).not.toHaveProperty(key);
    }
  });
});

describe("Offer seller-control history projection", () => {
  it("replays buyer-muted, buyer-unmuted and cooldown-bearing match-declined payloads", async () => {
    const calls: { sql: string; values: readonly unknown[] }[] = [];
    const db: PgQueryable = {
      async query<Row>(sql: string, values: readonly unknown[] = []) {
        calls.push({ sql, values });
        return { rows: [] as Row[] };
      },
    };
    const handlers = buildMarketplaceOfferProjectionHandlers(db);
    const identity = {
      sellerAccountId: "acc_seller",
      buyerAccountId: "acc_buyer",
      listingId: "lst_historical",
      productId: "cat_one::",
    };
    const mutedAt = "2026-07-05T12:00:00.000Z";
    const unmutedAt = "2026-07-05T12:02:00.000Z";
    const cooldown = "2026-07-12T12:03:00.000Z";
    await handlers["marketplace.offer.buyer-muted"]!(
      buildTransportEvent("marketplace.offer.buyer-muted", { ...identity, offerId: "off_historical", mutedAt }),
    );
    expect(calls[0]?.sql).toContain("INSERT INTO marketplace_offer_seller_controls");
    expect(calls[0]?.values).toEqual(["acc_seller", "acc_buyer", "lst_historical", "cat_one::", mutedAt]);
    calls.length = 0;
    await handlers["marketplace.offer.buyer-unmuted"]!(
      buildTransportEvent("marketplace.offer.buyer-unmuted", { ...identity, unmutedAt }),
    );
    expect(calls[0]?.sql).toContain("SET muted_at = NULL");
    expect(calls[0]?.values).toEqual(["acc_seller", "acc_buyer", "lst_historical", unmutedAt]);
    calls.length = 0;
    await handlers["marketplace.offer.match-declined"]!(
      buildTransportEvent("marketplace.offer.match-declined", {
        ...identity,
        offerId: "off_historical",
        offerPriceAmount: "2.00",
        offerPriceCurrencyCode: "USD",
        listingPriceAmount: "10.00",
        listingPriceCurrencyCode: "USD",
        declinedAt: unmutedAt,
        lowballDeclineCount: 2,
        lowballCooldownUntil: cooldown,
      }),
    );
    expect(calls[0]?.sql).toContain("INSERT INTO marketplace_offer_seller_declines");
    expect(calls[0]?.values).toEqual([
      "acc_seller",
      "acc_buyer",
      "lst_historical",
      "cat_one::",
      "off_historical",
      "2.00",
      "USD",
      "10.00",
      "USD",
      unmutedAt,
      cooldown,
    ]);
    expect(calls[1]?.sql).toContain("INSERT INTO marketplace_offer_seller_controls");
    expect(calls[1]?.values).toEqual([
      "acc_seller",
      "acc_buyer",
      "lst_historical",
      "cat_one::",
      2,
      "2.00",
      "USD",
      cooldown,
      unmutedAt,
    ]);
  });
});
