import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as orderingModule } from "../../../index";
import { releasePurchaseLimitClaimsForOrder } from "./purchase-limits";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["ordering"] as const;

describeDb("ordering purchase limits db", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, contextNames, "ordering_purchase_limits");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.ordering.query(orderingModule.schemaSql);
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  it("restores day and customer account quantities when released claim timestamps are parsed as Date", async () => {
    await pools.ordering.query(
      `INSERT INTO ordering_listing_purchase_limit_claims (
         claim_id,
         source_type,
         source_reference_id,
         buyer_account_id,
         listing_id,
         quantity,
         status,
         claimed_at,
         released_at
       )
       VALUES ('opl_claim_1', 'cart-checkout', 'chk_1', 'acct_buyer', 'lst_1', 2, 'claimed', $1::timestamptz, NULL)`,
      ["2026-07-02T15:30:00.000Z"],
    );
    await pools.ordering.query(
      `INSERT INTO ordering_listing_purchase_limit_usage (
         buyer_account_id,
         listing_id,
         marketplace_day,
         day_quantity,
         customer_account_quantity,
         updated_at
       )
       VALUES ('acct_buyer', 'lst_1', '2026-07-02'::date, 2, 2, now())`,
    );

    await releasePurchaseLimitClaimsForOrder(pools.ordering, {
      source_type: "cart-checkout",
      source_reference_id: "chk_1",
      buyer_account_id: "acct_buyer",
      lines: [{ listing_id: "lst_1" }],
    });

    const claim = await pools.ordering.query<{ status: string; released_at: Date | null }>(
      `SELECT status, released_at
       FROM ordering_listing_purchase_limit_claims
       WHERE claim_id = 'opl_claim_1'`,
    );
    const usage = await pools.ordering.query<{
      day_quantity: number | string;
      customer_account_quantity: number | string;
    }>(
      `SELECT day_quantity, customer_account_quantity
       FROM ordering_listing_purchase_limit_usage
       WHERE buyer_account_id = 'acct_buyer'
         AND listing_id = 'lst_1'`,
    );

    expect(claim.rows[0]).toMatchObject({ status: "released" });
    expect(claim.rows[0]?.released_at).toBeInstanceOf(Date);
    expect(Number(usage.rows[0]?.day_quantity)).toBe(0);
    expect(Number(usage.rows[0]?.customer_account_quantity)).toBe(0);
  });
});
