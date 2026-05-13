import { describe, expect, it } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { buildDiscoveryMarketProjectionHandlers } from "../support/market-support/projection";
import { getDiscoveryItemDetail } from "../features/item-detail/read-model/queries";

function createEvent(type: string, data: Record<string, unknown>, recordedAt: string) {
  return {
    type,
    streamId: "marketplace.offer-offer_charizard",
    data,
    timing: { recordedAt },
  };
}

describe("item detail offer matches", () => {
  it("projects submitted and accepted offers into the public discovery market table", async () => {
    const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const db = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        return { rows: [] };
      },
    } satisfies PgQueryable;
    const handlers = buildDiscoveryMarketProjectionHandlers(db);

    await handlers["marketplace.offer.submitted"]?.(
      createEvent(
        "marketplace.offer.submitted",
        {
          offerId: "offer_charizard",
          buyerAccountId: "buyer_1",
          catalogItemId: "cat_charizard",
          productId: "cat_charizard::raw",
          itemTitle: "Charizard",
          itemSubtitle: "Base Set",
          selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
          productSummary: "Raw",
          priceAmount: "350.00",
          quantityRequested: 1,
        },
        "2026-04-28T00:00:00.000Z",
      ) as never,
    );
    await handlers["marketplace.offer.accepted"]?.(
      createEvent(
        "marketplace.offer.accepted",
        {
          offerId: "offer_charizard",
          sellerAccountId: "seller_1",
          acceptedAt: "2026-04-28T01:00:00.000Z",
        },
        "2026-04-28T01:00:00.000Z",
      ) as never,
    );

    expect(calls[0].sql).toContain("INSERT INTO discovery_buyer_offer_matches");
    expect(calls[0].params).toEqual([
      "offer_charizard",
      "buyer_1",
      "cat_charizard",
      "cat_charizard::raw",
      "Charizard",
      "Base Set",
      JSON.stringify([{ dimensionId: "form", optionId: "raw" }]),
      "Raw",
      "350.00",
      1,
      "2026-04-28T00:00:00.000Z",
    ]);
    const acceptedOfferUpdate = calls.find((call) =>
      call.sql.includes("SET status = 'accepted'"),
    );
    expect(acceptedOfferUpdate?.params).toEqual([
      "offer_charizard",
      "seller_1",
      "2026-04-28T01:00:00.000Z",
    ]);
  });

  it("returns submitted public offer demand on item detail payloads", async () => {
    const offerQueries: string[] = [];
    const db = {
      query: async (sql: string) => {
        if (sql.includes("FROM discovery_item_detail_pages")) {
          return {
            rows: [
              {
                catalog_item_id: "cat_charizard",
                title: "Charizard",
                subtitle: "Base Set",
                description: "Classic card",
                blueprint_id: null,
                blueprint: null,
                status: "active",
                field_values: [],
                categories: [],
                tags: [],
                image_urls: [],
                product_schema: null,
                updated_at: "2026-04-28T00:00:00.000Z",
              },
            ],
          };
        }

        if (sql.includes("MIN(price_amount)::text")) {
          return {
            rows: [
              {
                lowest_price_amount: null,
                active_listing_count: 0,
                total_visible_quantity: 0,
              },
            ],
          };
        }

        if (sql.includes("FROM discovery_market_listings")) {
          return { rows: [] };
        }

        if (sql.includes("FROM discovery_buyer_offer_matches")) {
          offerQueries.push(sql);
          return {
            rows: [
              {
                offer_id: "offer_charizard",
                buyer_account_id: "buyer_1",
                buyer_display_name: "Ash Ketchum",
                catalog_catalog_item_id: "cat_charizard",
                product_id: "cat_charizard::raw",
                item_title: "Charizard",
                item_subtitle: "Base Set",
                selected_options: [{ dimensionId: "form", optionId: "raw" }],
                product_summary: "Raw",
                price_amount: "350.00",
                quantity_requested: 1,
                status: "submitted",
                accepted_seller_account_id: null,
                accepted_at: null,
                created_at: "2026-04-28T00:00:00.000Z",
                updated_at: "2026-04-28T00:00:00.000Z",
              },
            ],
          };
        }

        return { rows: [] };
      },
    } satisfies PgQueryable;

    const item = await getDiscoveryItemDetail(db, "cat_charizard");

    expect(item?.buyer_offer_matches).toEqual([
      expect.objectContaining({
        offer_id: "offer_charizard",
        buyer_display_name: "Ash Ketchum",
        status: "submitted",
        accepted_seller_account_id: null,
      }),
    ]);
    expect(offerQueries[0]).toContain("offer.status = 'submitted'");
    expect(offerQueries[0]).not.toContain("offer.status IN ('submitted', 'accepted')");
  });
});
