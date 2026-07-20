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
import {
  buildPricingMarketTradesAuthenticityIntegrityProjectionHandlers,
  buildPricingMarketTradesIdentityIntegrityProjectionHandlers,
  buildPricingMarketTradesPaymentsIntegrityProjectionHandlers,
  buildPricingMarketTradesSettlementIntegrityProjectionHandlers,
} from "../integrations/integrity/integrity-projection";
import { listExcludedMarketTrades } from "../read-model/queries";

// phantom-SQL rule: exercised against a real Postgres sandbox
// (TEST_DATABASE_URL, see .env.sandbox.local / dev:bootstrap), never mocked.
const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["pricing"] as const;

function event(type: string, data: Record<string, unknown>, recordedAt: string, streamId?: string) {
  return {
    type,
    streamId: streamId ?? `stream_${type}`,
    data,
    timing: { recordedAt },
  } as never;
}

describeDb("pricing market-trades tape-integrity SQL persistence boundary (#4304)", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      contextNames,
      "pricing_market_trades_integrity",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.pricing.query(pricingModule.schemaSql);
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  async function seedTrade(
    pool: PgTransactionalPool,
    params: Readonly<{ orderId: string; lineId: string; buyerAccountId: string; sellerAccountId: string }>,
  ) {
    const tradeHandlers = buildPricingMarketTradesProjectionHandlers(pool);
    await tradeHandlers["ordering.order.created"]!(
      event(
        "ordering.order.created",
        {
          orderId: params.orderId,
          sourceType: "cart-checkout",
          buyerAccountId: params.buyerAccountId,
          sellerAccountId: params.sellerAccountId,
          lines: [
            {
              lineId: params.lineId,
              catalogItemId: "cat_1",
              productId: "prod_1",
              unitPriceAmount: "10.00",
              quantity: 1,
            },
          ],
        },
        "2026-07-01T00:00:00.000Z",
      ),
    );
  }

  async function markTradeSold(pool: PgTransactionalPool, orderId: string, soldAt = "2026-07-02T00:00:00.000Z") {
    const tradeHandlers = buildPricingMarketTradesProjectionHandlers(pool);
    await tradeHandlers["ordering.order.ready-for-fulfillment-recorded"]!(
      event("ordering.order.ready-for-fulfillment-recorded", { orderId, readyForFulfillmentAt: soldAt }, soldAt),
    );
  }

  it("retroactively excludes a flagged account's historical trades on both the buyer and seller side (AC1)", async () => {
    const pool = pools.pricing;
    await seedTrade(pool, {
      orderId: "ord_1",
      lineId: "line_1",
      buyerAccountId: "buyer_1",
      sellerAccountId: "seller_1",
    });
    await seedTrade(pool, {
      orderId: "ord_2",
      lineId: "line_1",
      buyerAccountId: "buyer_2",
      sellerAccountId: "buyer_1",
    });
    await seedTrade(pool, {
      orderId: "ord_3",
      lineId: "line_1",
      buyerAccountId: "buyer_3",
      sellerAccountId: "seller_3",
    });

    const identityHandlers = buildPricingMarketTradesIdentityIntegrityProjectionHandlers(pool);
    await identityHandlers["identity.account.badge-assigned"]!(
      event(
        "identity.account.badge-assigned",
        { badgeKey: "manual-payout-review" },
        "2026-07-06T00:00:00.000Z",
        "identity.account-buyer_1",
      ),
    );

    const rows = await pool.query<{ order_id: string; excluded: boolean; exclusion_reason: string | null }>(
      `SELECT order_id, excluded, exclusion_reason FROM pricing_market_trades ORDER BY order_id`,
    );

    expect(rows.rows).toEqual([
      { order_id: "ord_1", excluded: true, exclusion_reason: "fraud-flagged" },
      { order_id: "ord_2", excluded: true, exclusion_reason: "fraud-flagged" },
      { order_id: "ord_3", excluded: false, exclusion_reason: null },
    ]);
  });

  it("does not exclude trades when a non-review badge is assigned", async () => {
    const pool = pools.pricing;
    await seedTrade(pool, {
      orderId: "ord_1",
      lineId: "line_1",
      buyerAccountId: "buyer_1",
      sellerAccountId: "seller_1",
    });

    const identityHandlers = buildPricingMarketTradesIdentityIntegrityProjectionHandlers(pool);
    await identityHandlers["identity.account.badge-assigned"]!(
      event(
        "identity.account.badge-assigned",
        { badgeKey: "trusted-seller" },
        "2026-07-06T00:00:00.000Z",
        "identity.account-seller_1",
      ),
    );

    const rows = await pool.query<{ excluded: boolean }>(
      `SELECT excluded FROM pricing_market_trades WHERE order_id = 'ord_1'`,
    );
    expect(rows.rows[0]?.excluded).toBe(false);
  });

  it("excludes every trade line on a Stripe fraud-flagged order (AC1)", async () => {
    const pool = pools.pricing;
    await seedTrade(pool, {
      orderId: "ord_1",
      lineId: "line_1",
      buyerAccountId: "buyer_1",
      sellerAccountId: "seller_1",
    });
    await seedTrade(pool, {
      orderId: "ord_2",
      lineId: "line_1",
      buyerAccountId: "buyer_2",
      sellerAccountId: "seller_2",
    });

    const paymentsHandlers = buildPricingMarketTradesPaymentsIntegrityProjectionHandlers(pool);
    await paymentsHandlers["payments.payment-fraud-warning-received"]!(
      event(
        "payments.payment-fraud-warning-received",
        { orderIds: ["ord_1"], receivedAt: "2026-07-06T00:00:00.000Z" },
        "2026-07-06T00:00:00.000Z",
      ),
    );

    const rows = await pool.query<{ order_id: string; exclusion_reason: string | null }>(
      `SELECT order_id, exclusion_reason FROM pricing_market_trades ORDER BY order_id`,
    );
    expect(rows.rows).toEqual([
      { order_id: "ord_1", exclusion_reason: "fraud-flagged" },
      { order_id: "ord_2", exclusion_reason: null },
    ]);
  });

  it("sets the verified marker on every line of an order whose authenticity case passes (AC2)", async () => {
    const pool = pools.pricing;
    await seedTrade(pool, {
      orderId: "ord_1",
      lineId: "line_1",
      buyerAccountId: "buyer_1",
      sellerAccountId: "seller_1",
    });

    const authenticityHandlers = buildPricingMarketTradesAuthenticityIntegrityProjectionHandlers(pool);
    await authenticityHandlers["authenticity.case.opened"]!(
      event(
        "authenticity.case.opened",
        { caseId: "case_1", orderId: "ord_1", openedAt: "2026-07-02T00:00:00.000Z" },
        "2026-07-02T00:00:00.000Z",
      ),
    );

    let rows = await pool.query<{ verified: boolean }>(
      `SELECT verified FROM pricing_market_trades WHERE order_id = 'ord_1'`,
    );
    expect(rows.rows[0]?.verified).toBe(false);

    await authenticityHandlers["authenticity.case.verdict-recorded"]!(
      event(
        "authenticity.case.verdict-recorded",
        {
          caseId: "case_1",
          verdict: "passed",
          reasonCodes: [],
          checklistResults: [],
          evidencePhotoRefs: [],
          lineNotes: [],
          inspectorAccountId: "inspector_1",
          decidedAt: "2026-07-03T00:00:00.000Z",
        },
        "2026-07-03T00:00:00.000Z",
      ),
    );

    rows = await pool.query<{ verified: boolean }>(
      `SELECT verified FROM pricing_market_trades WHERE order_id = 'ord_1'`,
    );
    expect(rows.rows[0]?.verified).toBe(true);
  });

  it("does not set verified when the authenticity case verdict fails", async () => {
    const pool = pools.pricing;
    await seedTrade(pool, {
      orderId: "ord_1",
      lineId: "line_1",
      buyerAccountId: "buyer_1",
      sellerAccountId: "seller_1",
    });

    const authenticityHandlers = buildPricingMarketTradesAuthenticityIntegrityProjectionHandlers(pool);
    await authenticityHandlers["authenticity.case.opened"]!(
      event(
        "authenticity.case.opened",
        { caseId: "case_1", orderId: "ord_1", openedAt: "2026-07-02T00:00:00.000Z" },
        "2026-07-02T00:00:00.000Z",
      ),
    );
    await authenticityHandlers["authenticity.case.verdict-recorded"]!(
      event(
        "authenticity.case.verdict-recorded",
        {
          caseId: "case_1",
          verdict: "failed",
          reasonCodes: ["counterfeit-suspected"],
          checklistResults: [],
          evidencePhotoRefs: [],
          lineNotes: [],
          inspectorAccountId: "inspector_1",
          decidedAt: "2026-07-03T00:00:00.000Z",
        },
        "2026-07-03T00:00:00.000Z",
      ),
    );

    const rows = await pool.query<{ verified: boolean }>(
      `SELECT verified FROM pricing_market_trades WHERE order_id = 'ord_1'`,
    );
    expect(rows.rows[0]?.verified).toBe(false);
  });

  it("exposes excluded trades with reasons for ops audit while public rollups would omit them (AC4)", async () => {
    const pool = pools.pricing;
    await seedTrade(pool, {
      orderId: "ord_1",
      lineId: "line_1",
      buyerAccountId: "buyer_1",
      sellerAccountId: "seller_1",
    });
    await seedTrade(pool, {
      orderId: "ord_2",
      lineId: "line_1",
      buyerAccountId: "buyer_2",
      sellerAccountId: "seller_2",
    });

    const orderingFulfillmentHandlers = buildPricingMarketTradesProjectionHandlers(pool);
    await orderingFulfillmentHandlers["ordering.order.cancelled"]!(
      event(
        "ordering.order.cancelled",
        { orderId: "ord_1", cancelledAt: "2026-07-04T00:00:00.000Z" },
        "2026-07-04T00:00:00.000Z",
      ),
    );

    const paymentsHandlers = buildPricingMarketTradesPaymentsIntegrityProjectionHandlers(pool);
    await paymentsHandlers["payments.payment-fraud-warning-received"]!(
      event(
        "payments.payment-fraud-warning-received",
        { orderIds: ["ord_2"], receivedAt: "2026-07-05T00:00:00.000Z" },
        "2026-07-05T00:00:00.000Z",
      ),
    );

    const excluded = await listExcludedMarketTrades(pool);
    expect(excluded).toHaveLength(2);
    expect(
      excluded
        .map((row) => ({ orderId: row.orderId, exclusionReason: row.exclusionReason }))
        .sort((a, b) => a.orderId.localeCompare(b.orderId)),
    ).toEqual([
      { orderId: "ord_1", exclusionReason: "cancelled" },
      { orderId: "ord_2", exclusionReason: "fraud-flagged" },
    ]);

    const fraudOnly = await listExcludedMarketTrades(pool, { exclusionReason: "fraud-flagged" });
    expect(fraudOnly).toHaveLength(1);
    expect(fraudOnly[0]?.orderId).toBe("ord_2");
  });

  it("projects linkage flags as pair-scoped retroactive exclusions and excludes new prints while the flag stands", async () => {
    const pool = pools.pricing;
    const clusterHash = "a".repeat(64);
    await seedTrade(pool, {
      orderId: "ord_linked",
      lineId: "line_1",
      buyerAccountId: "acc_a",
      sellerAccountId: "acc_b",
    });
    await seedTrade(pool, {
      orderId: "ord_one_sided",
      lineId: "line_1",
      buyerAccountId: "acc_a",
      sellerAccountId: "acc_unrelated",
    });
    await markTradeSold(pool, "ord_linked");
    await markTradeSold(pool, "ord_one_sided");

    const linkageHandlers = buildPricingMarketTradesSettlementIntegrityProjectionHandlers(pool);
    await linkageHandlers["settlement.account-linkage.flagged"]!(
      event(
        "settlement.account-linkage.flagged",
        { clusterHash, signalKind: "shared-instrument", accountIds: ["acc_a", "acc_b"] },
        "2026-07-06T00:00:00.000Z",
      ),
    );

    await seedTrade(pool, {
      orderId: "ord_new_linked",
      lineId: "line_1",
      buyerAccountId: "acc_b",
      sellerAccountId: "acc_a",
    });

    const rows = await pool.query<{ order_id: string; excluded: boolean; exclusion_reason: string | null }>(
      `SELECT order_id, excluded, exclusion_reason
       FROM pricing_market_trades
       ORDER BY order_id`,
    );
    expect(rows.rows).toEqual([
      { order_id: "ord_linked", excluded: true, exclusion_reason: "self-dealing" },
      { order_id: "ord_new_linked", excluded: true, exclusion_reason: "self-dealing" },
      { order_id: "ord_one_sided", excluded: false, exclusion_reason: null },
    ]);

    const queued = await pool.query<{ day: string }>(
      `SELECT day::text FROM pricing_market_trade_rollup_rederive_queue ORDER BY day`,
    );
    expect(queued.rows).toEqual([{ day: "2026-07-02" }]);

    const auditRows = await listExcludedMarketTrades(pool, { exclusionReason: "self-dealing" });
    expect(auditRows.map((row) => row.orderId).sort()).toEqual(["ord_linked", "ord_new_linked"]);
  });

  it("replaces revised linkage sets and clears only after every overlapping active flag is gone", async () => {
    const pool = pools.pricing;
    const firstClusterHash = "b".repeat(64);
    const overlappingClusterHash = "c".repeat(64);
    await seedTrade(pool, {
      orderId: "ord_ab",
      lineId: "line_1",
      buyerAccountId: "acc_a",
      sellerAccountId: "acc_b",
    });
    await seedTrade(pool, {
      orderId: "ord_ac",
      lineId: "line_1",
      buyerAccountId: "acc_a",
      sellerAccountId: "acc_c",
    });

    const linkageHandlers = buildPricingMarketTradesSettlementIntegrityProjectionHandlers(pool);
    await linkageHandlers["settlement.account-linkage.flagged"]!(
      event(
        "settlement.account-linkage.flagged",
        { clusterHash: firstClusterHash, signalKind: "shared-address", accountIds: ["acc_a", "acc_b"] },
        "2026-07-06T00:00:00.000Z",
      ),
    );
    await linkageHandlers["settlement.account-linkage.flagged"]!(
      event(
        "settlement.account-linkage.flagged",
        { clusterHash: overlappingClusterHash, signalKind: "shared-address", accountIds: ["acc_a", "acc_b"] },
        "2026-07-06T01:00:00.000Z",
      ),
    );

    // Re-flagging replaces the first cluster's set. The overlapping cluster
    // keeps A/B excluded while the replacement newly excludes A/C.
    await linkageHandlers["settlement.account-linkage.flagged"]!(
      event(
        "settlement.account-linkage.flagged",
        { clusterHash: firstClusterHash, signalKind: "shared-address", accountIds: ["acc_a", "acc_c"] },
        "2026-07-07T00:00:00.000Z",
      ),
    );
    await linkageHandlers["settlement.account-linkage.cleared"]!(
      event(
        "settlement.account-linkage.cleared",
        { clusterHash: overlappingClusterHash, signalKind: "shared-address", accountIds: ["acc_a", "acc_b"] },
        "2026-07-08T00:00:00.000Z",
      ),
    );

    let rows = await pool.query<{ order_id: string; excluded: boolean }>(
      `SELECT order_id, excluded FROM pricing_market_trades ORDER BY order_id`,
    );
    expect(rows.rows).toEqual([
      { order_id: "ord_ab", excluded: false },
      { order_id: "ord_ac", excluded: true },
    ]);

    await linkageHandlers["settlement.account-linkage.cleared"]!(
      event(
        "settlement.account-linkage.cleared",
        { clusterHash: firstClusterHash, signalKind: "shared-address", accountIds: ["acc_a", "acc_c"] },
        "2026-07-09T00:00:00.000Z",
      ),
    );
    rows = await pool.query<{ order_id: string; excluded: boolean }>(
      `SELECT order_id, excluded FROM pricing_market_trades ORDER BY order_id`,
    );
    expect(rows.rows).toEqual([
      { order_id: "ord_ab", excluded: false },
      { order_id: "ord_ac", excluded: false },
    ]);
  });

  it("lets terminal reasons replace self-dealing and never resurrects them on clear", async () => {
    const pool = pools.pricing;
    const clusterHash = "d".repeat(64);
    const tradeHandlers = buildPricingMarketTradesProjectionHandlers(pool);
    const linkageHandlers = buildPricingMarketTradesSettlementIntegrityProjectionHandlers(pool);
    await linkageHandlers["settlement.account-linkage.flagged"]!(
      event(
        "settlement.account-linkage.flagged",
        { clusterHash, signalKind: "shared-instrument", accountIds: ["acc_a", "acc_b"] },
        "2026-07-06T00:00:00.000Z",
      ),
    );
    await seedTrade(pool, {
      orderId: "ord_cancelled",
      lineId: "line_1",
      buyerAccountId: "acc_a",
      sellerAccountId: "acc_b",
    });
    await seedTrade(pool, {
      orderId: "ord_refunded",
      lineId: "line_1",
      buyerAccountId: "acc_a",
      sellerAccountId: "acc_b",
    });
    await seedTrade(pool, {
      orderId: "ord_fraud",
      lineId: "line_1",
      buyerAccountId: "acc_a",
      sellerAccountId: "acc_b",
    });

    await tradeHandlers["ordering.order.cancelled"]!(
      event(
        "ordering.order.cancelled",
        { orderId: "ord_cancelled", cancelledAt: "2026-07-07T00:00:00.000Z" },
        "2026-07-07T00:00:00.000Z",
      ),
    );
    await tradeHandlers["fulfillment.shipment.created"]!(
      event(
        "fulfillment.shipment.created",
        {
          shipmentId: "ship_refund",
          orderId: "ord_refunded",
          lines: [{ orderLineId: "line_1" }],
          createdAt: "2026-07-07T00:00:00.000Z",
        },
        "2026-07-07T00:00:00.000Z",
      ),
    );
    await tradeHandlers["fulfillment.shipment.returned"]!(
      event(
        "fulfillment.shipment.returned",
        { shipmentId: "ship_refund", returnedAt: "2026-07-08T00:00:00.000Z" },
        "2026-07-08T00:00:00.000Z",
      ),
    );
    const paymentsHandlers = buildPricingMarketTradesPaymentsIntegrityProjectionHandlers(pool);
    await paymentsHandlers["payments.payment-fraud-warning-received"]!(
      event(
        "payments.payment-fraud-warning-received",
        { orderIds: ["ord_fraud"], receivedAt: "2026-07-08T00:00:00.000Z" },
        "2026-07-08T00:00:00.000Z",
      ),
    );

    await linkageHandlers["settlement.account-linkage.cleared"]!(
      event(
        "settlement.account-linkage.cleared",
        { clusterHash, signalKind: "shared-instrument", accountIds: ["acc_a", "acc_b"] },
        "2026-07-09T00:00:00.000Z",
      ),
    );

    const rows = await pool.query<{ order_id: string; excluded: boolean; exclusion_reason: string }>(
      `SELECT order_id, excluded, exclusion_reason FROM pricing_market_trades ORDER BY order_id`,
    );
    expect(rows.rows).toEqual([
      { order_id: "ord_cancelled", excluded: true, exclusion_reason: "cancelled" },
      { order_id: "ord_fraud", excluded: true, exclusion_reason: "fraud-flagged" },
      { order_id: "ord_refunded", excluded: true, exclusion_reason: "refunded" },
    ]);
  });
});
