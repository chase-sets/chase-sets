import { describe, expect, it } from "vitest";
import { pricingRecommendationSourceSchemaMigrations, pricingRecommendationSourceSchemaSql } from "./source-schema";

function createTableBody(tableName: string): string {
  const match = pricingRecommendationSourceSchemaSql.match(
    new RegExp(`CREATE TABLE IF NOT EXISTS ${tableName} \\(([\\s\\S]*?)\\n\\);`),
  );
  expect(match, `fresh-boot table ${tableName}`).not.toBeNull();
  return match?.[1] ?? "";
}

describe("pricing recommendation source schema", () => {
  it("declares each projected money currency exactly once in fresh-boot tables and retains migrations", () => {
    const listingTable = createTableBody("pricing_market_listing_inputs");
    const offerTable = createTableBody("pricing_buyer_offer_inputs");
    const inventoryTable = createTableBody("pricing_inventory_item_inputs");

    expect(listingTable.match(/^  price_currency_code text NULL,$/gm)).toHaveLength(1);
    expect(offerTable.match(/^  price_currency_code text NULL,$/gm)).toHaveLength(1);
    expect(inventoryTable.match(/^  acquisition_cost_currency_code text NULL,$/gm)).toHaveLength(1);

    expect(pricingRecommendationSourceSchemaMigrations.map(({ migrationId }) => migrationId)).toEqual(
      expect.arrayContaining([
        "20260907_pricing_recommendation_source_money_currencies",
        "20260907_pricing_market_listing_input_price_currency",
      ]),
    );
  });
});
