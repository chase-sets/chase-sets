import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as pricingModule } from "../../../index";
import { buildPricingMarketTradesProjectionHandlers } from "../integrations/source/source-projection";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["pricing"] as const;

function event(type: string, data: Record<string, unknown>, recordedAt: string) {
  return { type, streamId: `stream_${type}`, data, timing: { recordedAt } } as never;
}

const createdAt = "2026-07-01T09:00:00.000Z";
const capturedAt = "2026-07-01T09:05:00.000Z";
const soldAt = "2026-07-01T09:06:00.000Z";

describeDb("Trades Tape denomination from Payments capture", () => {
  let pool: PgTransactionalPool;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, contextNames, "pricing_trade_denomination");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pool = createMultiContextTestPools(urls).pricing;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas({ pricing: pool });
    await pool.query(pricingModule.schemaSql);
  });
  afterAll(async () => {
    await closeMultiContextTestPools({ pricing: pool });
  });

  function handlers() {
    return buildPricingMarketTradesProjectionHandlers(pool);
  }
  async function create(orderId: string, productId = "prod_1") {
    await handlers()["ordering.order.created"]!(
      event(
        "ordering.order.created",
        {
          orderId,
          sourceType: "cart-checkout",
          buyerAccountId: "buyer_1",
          sellerAccountId: "seller_1",
          lines: [{ lineId: "line_1", catalogItemId: "cat_1", productId, unitPriceAmount: "12.50", quantity: 1 }],
        },
        createdAt,
      ),
    );
  }
  async function capture(orderIds: string[]) {
    await handlers()["payments.payment-captured"]!(
      event("payments.payment-captured", { orderIds, currencyCode: "usd", capturedAt }, capturedAt),
    );
  }
  async function ready(orderId: string) {
    await handlers()["ordering.order.ready-for-fulfillment-recorded"]!(
      event("ordering.order.ready-for-fulfillment-recorded", { orderId, readyForFulfillmentAt: soldAt }, soldAt),
    );
  }
  async function trades() {
    return (
      await pool.query<{
        order_id: string;
        currency_code: string | null;
      }>(
        `SELECT order_id, line_id, product_id, unit_price_amount::text, currency_code, sold_at::text,
                excluded, exclusion_reason, updated_at::text
         FROM pricing_market_trades ORDER BY order_id, line_id`,
      )
    ).rows;
  }
  async function queue() {
    return (
      await pool.query(
        `SELECT catalog_catalog_item_id, product_id, day::text, generation::text
         FROM pricing_market_trade_rollup_rederive_queue ORDER BY catalog_catalog_item_id, product_id, day`,
      )
    ).rows;
  }

  it("converges in either arrival order, survives reinsert, and leaves uncaptured orders unknown", async () => {
    await create("ord_1");
    await capture(["ord_1", "ord_2"]);
    await create("ord_2");
    await create("ord_3");
    const orderFirst = await trades();
    expect(orderFirst.map((row) => row.currency_code)).toEqual(["USD", "USD", null]);
    await create("ord_1");
    expect(await trades()).toEqual(orderFirst);
    expect(
      (await pool.query(`SELECT order_id, currency_code FROM pricing_market_trade_denominations ORDER BY order_id`))
        .rows,
    ).toEqual([
      { order_id: "ord_1", currency_code: "USD" },
      { order_id: "ord_2", currency_code: "USD" },
    ]);

    await pool.query(
      `TRUNCATE pricing_market_trades, pricing_market_trade_denominations, pricing_market_trade_rollup_rederive_queue`,
    );
    await capture(["ord_1", "ord_2"]);
    await create("ord_1");
    await create("ord_2");
    await create("ord_3");
    expect(await trades()).toEqual(orderFirst);
  });

  it("queues an out-of-window sold day on readiness and capture, advancing the generation once per change", async () => {
    await create("ord_1");
    await ready("ord_1");
    expect(await queue()).toEqual([
      { catalog_catalog_item_id: "cat_1", product_id: "prod_1", day: "2026-07-01", generation: "1" },
    ]);
    await capture(["ord_1"]);
    expect(await queue()).toEqual([
      { catalog_catalog_item_id: "cat_1", product_id: "prod_1", day: "2026-07-01", generation: "2" },
    ]);
    await capture(["ord_1"]);
    expect((await queue())[0]).toMatchObject({ generation: "2" });
    expect((await trades())[0]).toMatchObject({ currency_code: "USD" });
  });

  it("still enqueues a self-dealing sold day", async () => {
    await pool.query(
      `INSERT INTO pricing_market_trade_linkage_clusters (cluster_hash, signal_kind, account_ids, flagged, updated_at)
       VALUES ('cluster_1', 'shared-instrument', ARRAY['buyer_1', 'seller_1'], true, $1)`,
      [createdAt],
    );
    await create("ord_1");
    await capture(["ord_1"]);
    await ready("ord_1");
    expect((await trades())[0]).toMatchObject({
      excluded: true,
      exclusion_reason: "self-dealing",
      currency_code: "USD",
    });
    expect(await queue()).toEqual([
      { catalog_catalog_item_id: "cat_1", product_id: "prod_1", day: "2026-07-01", generation: "1" },
    ]);
  });

  it.each(["payments-first", "ordering-first"])("rebuilds %s to the incremental tape and queue", async (order) => {
    await create("ord_1");
    await capture(["ord_1", "ord_2"]);
    await ready("ord_1");
    await create("ord_2", "prod_2");
    await ready("ord_2");
    const expectedTrades = await trades();
    const expectedQueue = await queue();

    await pool.query(
      `TRUNCATE pricing_market_trades, pricing_market_trade_denominations, pricing_market_trade_rollup_rederive_queue`,
    );
    if (order === "payments-first") await capture(["ord_1", "ord_2"]);
    await create("ord_1");
    await ready("ord_1");
    await create("ord_2", "prod_2");
    await ready("ord_2");
    if (order === "ordering-first") await capture(["ord_1", "ord_2"]);
    expect(await trades()).toEqual(expectedTrades);
    expect((await queue()).map(({ generation: _generation, ...tuple }) => tuple)).toEqual(
      expectedQueue.map(({ generation: _generation, ...tuple }) => tuple),
    );
  });
});
