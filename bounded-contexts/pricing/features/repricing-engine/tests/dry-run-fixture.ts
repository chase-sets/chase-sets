import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { RepricingDryRunBody } from "../api/dry-run";

export const dryRunContext: EventStoreContext = {
  tenantId: "tnt_identity",
  audit: { performedByUserId: "usr_7910", forAccountId: "acc_7910" },
};
export const dryRunBody: RepricingDryRunBody = {
  scope: { kind: "all-listings" },
  excludedListingIds: [],
  maxChangesPerDay: 100,
  rules: [
    {
      conditions: [],
      directive: {
        currencyCode: "USD",
        anchorChain: [{ source: "market-estimate" }],
        offset: { mode: "absolute", amount: "0" },
        floor: { mode: "absolute", amount: "1.00" },
        ceiling: null,
        tolerance: { mode: "absolute", amount: "0.01" },
        rounding: { mode: "none" },
        maxMovePercent: null,
        terminal: { kind: "fallback-price", amount: "15.00" },
      },
    },
  ],
};

export async function seedDryRunListings(db: PgTransactionalPool, listings: number, products: number) {
  await db.query(
    `INSERT INTO pricing_market_listing_inputs
       (listing_id, seller_account_id, catalog_catalog_item_id, product_id, price_amount,
        price_currency_code, quantity_cap, status, updated_at, last_stream_version)
     SELECT 'lst_7910_' || lpad(series.n::text, 8, '0'), 'acc_7910',
       'cat_' || lpad(((series.n - 1) % $2)::text, 8, '0'),
       'prod_' || lpad(((series.n - 1) % $2)::text, 8, '0'),
       20, 'USD', 1, 'active', now(), 1 FROM generate_series(1, $1::integer) AS series(n)`,
    [listings, products],
  );
}
