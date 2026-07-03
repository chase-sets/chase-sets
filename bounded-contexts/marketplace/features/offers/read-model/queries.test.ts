import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { describe, expect, it } from "vitest";
import { getPublicOffer, listOfferMatches } from "./queries";

describe("marketplace offer read-model queries", () => {
  it("resolves public offer facts by id without requiring seller supply", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const db: PgQueryable = {
      async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
        calls.push({ sql, params });
        return {
          rows: [
            {
              offer_id: "off_air_balloon",
              buyer_account_id: "acc_buyer",
              catalog_catalog_item_id: "cat_air_balloon",
              product_id: "cat_air_balloon::form:raw|condition:damaged",
              item_title: "Air Balloon",
              item_subtitle: null,
              selected_options: [
                { dimensionId: "form", optionId: "raw" },
                { dimensionId: "condition", optionId: "damaged" },
              ],
              product_summary: "Raw / Damaged",
              shipping_destination_snapshot: {
                name: "QA Buyer",
                line1: "100 Market Street",
                city: "Chicago",
                state: "IL",
                postalCode: "60601",
                country: "US",
              },
              price_amount: "24.96",
              quantity_requested: 1,
              status: "submitted",
              accepted_seller_account_id: null,
              accepted_at: null,
              created_at: "2026-06-23T06:08:00.000Z",
              updated_at: "2026-06-23T06:08:00.000Z",
            },
          ] as Row[],
        };
      },
    };

    const result = await getPublicOffer(db, "off_air_balloon");

    expect(result).toMatchObject({
      offer_id: "off_air_balloon",
      status: "submitted",
      product_id: "cat_air_balloon::form:raw|condition:damaged",
    });
    expect(calls[0]?.sql).not.toContain("marketplace_listing_pages");
    expect(calls[0]?.params).toEqual(["off_air_balloon"]);
  });

  it("builds offer matches from submitted offers and matching active seller supply", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const db: PgQueryable = {
      async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
        calls.push({ sql, params });
        if (sql.includes("COUNT(*)")) {
          return { rows: [{ count: "1" } as Row] };
        }

        return {
          rows: [
            {
              offer_id: "off_air_balloon",
              buyer_account_id: "acc_buyer",
              catalog_catalog_item_id: "cat_air_balloon",
              product_id: "cat_air_balloon::form:raw|condition:damaged",
              item_title: "Air Balloon",
              item_subtitle: null,
              selected_options: [
                { dimensionId: "form", optionId: "raw" },
                { dimensionId: "condition", optionId: "damaged" },
              ],
              product_summary: "Raw / Damaged",
              shipping_destination_snapshot: {
                name: "QA Buyer",
                line1: "100 Market Street",
                city: "Chicago",
                state: "IL",
                postalCode: "60601",
                country: "US",
              },
              price_amount: "20.00",
              quantity_requested: 1,
              status: "submitted",
              accepted_seller_account_id: null,
              accepted_at: null,
              created_at: "2026-06-23T07:27:50.000Z",
              updated_at: "2026-06-23T07:27:50.000Z",
              buyer_display_name: "QA Buyer",
              buyer_average_rating: null,
              buyer_review_count: 0,
              listing_id: "lst_air_balloon",
              listing_price_amount: "21.50",
              listing_quantity_cap: 1,
              listing_visible_quantity: 1,
              seller_available_quantity: 1,
              offer_price_gap_amount: "1.50",
              offer_to_listing_price_bps: 9302,
              seller_listing_availability_status: "available",
            },
          ] as Row[],
        };
      },
    };

    const result = await listOfferMatches(db, {
      sellerAccountId: "acc_seller",
      productIds: ["cat_air_balloon::form:raw|condition:damaged"],
      status: "submitted",
      canFulfill: true,
    });

    expect(result.total).toBe(1);
    expect(result.items).toMatchObject([
      {
        offer_id: "off_air_balloon",
        listing_id: "lst_air_balloon",
        can_fulfill: true,
      },
    ]);

    const selectCall = calls.find((call) => !call.sql.includes("COUNT(*)"));
    expect(selectCall?.sql).toContain("offer.status = 'submitted'");
    expect(selectCall?.sql).toContain("listing.account_id = $1");
    expect(selectCall?.sql).toContain("listing.status = 'active'");
    expect(selectCall?.sql).toContain("listing.product_id = offer.product_id");
    expect(selectCall?.sql).toContain("LEFT JOIN LATERAL");
    expect(selectCall?.sql).toContain("supply_hold.item_id = item.item_id");
    expect(selectCall?.sql).toContain("supply_hold.status = 'active'");
    expect(selectCall?.sql).not.toContain("GROUP BY item_id");
    expect(selectCall?.sql).toContain("seller_offer.seller_available_quantity >= seller_offer.quantity_requested");
    expect(selectCall?.params).toEqual(["acc_seller", ["cat_air_balloon::form:raw|condition:damaged"], 50, 0]);
  });
});
