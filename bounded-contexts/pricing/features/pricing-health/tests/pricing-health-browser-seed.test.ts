import { describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { seedSyntheticPricingHealthInputs } from "../../../support/runtime-support/pricing-health-browser-seed";

describe("Pricing Health browser input fixture", () => {
  it("uses exact money arithmetic for quantities and half-cent expected sales", async () => {
    const query: PgTransactionalPool["query"] = async <Row>(sql: string) => ({
      rows: (sql.includes("FROM pricing_market_listing_inputs")
        ? [
            {
              catalog_item_id: "synthetic-item",
              product_id: "synthetic-product",
              price_amount: "19.99",
              quantity_cap: 3,
            },
          ]
        : []) as Row[],
    });
    const pool: PgTransactionalPool = { query, connect: async () => ({ query, release: () => {} }) };
    const fixture = await seedSyntheticPricingHealthInputs(pool, {
      accountId: "synthetic-account",
      listingId: "synthetic-listing",
      now: "2026-10-19T10:00:00.000Z",
    });
    expect(fixture.expected).toEqual({
      modeledValueAmount: "59.97",
      expectedSalesListingCount: 0.5,
      expectedSalesValueAmount: "10.00",
    });
    await fixture.cleanup();
  });
});
