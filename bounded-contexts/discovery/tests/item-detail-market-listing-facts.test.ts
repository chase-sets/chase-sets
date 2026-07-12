import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { describe, expect, it } from "vitest";
import { getDiscoveryItemDetail } from "../features/item-detail/read-model/queries";

describe("item detail market listing facts", () => {
  it("returns graded-card facts from buyer-visible listings", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const gradedCard = {
      gradingCompany: "PSA",
      grade: "10",
      certificationNumber: "81234567",
      population: null,
      conditionDescriptors: ["slabbed"],
      registryVerification: {
        state: "verified",
        provider: "PSA",
        verifiedAt: "2026-07-07T12:00:00.000Z",
        lookupUrl: "https://www.psacard.com/cert/81234567",
      },
    };
    const db: PgQueryable = {
      query: async <Row>(sql: string, values: readonly unknown[] = []) => {
        calls.push({ sql, values });

        if (sql.includes("FROM discovery_item_detail_pages AS page")) {
          return {
            rows: [
              {
                catalog_item_id: "cat_charizard",
                slug: "charizard",
                language_code: "en",
                title_i18n: {},
                title: "Charizard",
                subtitle_i18n: null,
                subtitle: null,
                display_badges: [{ kind: "rarity", label: "Rare Holo" }],
                description_i18n: {},
                description: "",
                blueprint_id: null,
                blueprint: null,
                status: "active",
                field_values: [],
                categories: [],
                tags: [],
                image_urls: [],
                product_asset_sets: [],
                image_fallback: null,
                product_schema: null,
                updated_at: "2026-07-07T12:00:00.000Z",
              },
            ] as Row[],
            rowCount: 1,
          };
        }

        if (sql.includes("MIN(price_amount::numeric)::text AS lowest_price_amount")) {
          return {
            rows: [{ lowest_price_amount: "400.00", active_listing_count: 1, total_visible_quantity: 1 }] as Row[],
            rowCount: 1,
          };
        }

        if (sql.includes("FROM startable_listing") && sql.includes("listing_id")) {
          return {
            rows: [
              {
                listing_id: "lst_charizard",
                listing_slug: "charizard-psa-10",
                product_slug: "charizard-psa-10-product",
                account_id: "acc_seller",
                inventory_item_id: "itm_charizard",
                catalog_catalog_item_id: "cat_charizard",
                product_id: "cat_charizard::psa-10",
                item_title: "Charizard",
                item_subtitle: null,
                selected_options: [],
                product_summary: "PSA 10",
                graded_card: gradedCard,
                storage_location_name: null,
                ship_from_code: null,
                price_amount: "400.00",
                shipping_allowance_percentage_bps: 500,
                quantity_cap: 1,
                max_units_per_order: null,
                max_units_per_day: null,
                max_units_per_customer_account: null,
                status: "active",
                seller_slug: "trusted-seller",
                seller_display_name: "Trusted Seller",
                seller_average_rating: null,
                seller_review_count: 0,
                visible_quantity: 1,
                created_at: "2026-07-07T12:00:00.000Z",
                updated_at: "2026-07-07T12:00:00.000Z",
              },
            ] as Row[],
            rowCount: 1,
          };
        }

        return { rows: [] as Row[], rowCount: 0 };
      },
    };

    const result = await getDiscoveryItemDetail(db, "charizard");
    const listingsCall = calls.find((call) => call.sql.includes("listing.graded_card"));

    expect(listingsCall?.sql).toContain("listing.graded_card");
    expect(result?.display_badges).toEqual([{ kind: "rarity", label: "Rare Holo" }]);
    expect(result?.market_listings[0]?.graded_card).toEqual(gradedCard);
  });
});
