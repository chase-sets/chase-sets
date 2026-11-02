import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { eventSubscriptionSchemaSql } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { sumMoneyAmounts, type MoneyAmount } from "@chase-sets/primitives/money";
import { module as pricingModule } from "../../../index";
import type { RepricingRule } from "../../repricing-policies/domain/domain";
import { holdValueGoal } from "../../repricing-policies/domain/goals/hold-value";
import type { PortfolioPlan } from "../../repricing-policies/domain/portfolio/portfolio";
import { createRepricingEngineRuntime, type RepricingMarketplaceGateway } from "../api/runtime";
import {
  repricingPolicyEvaluatedEventType,
  type RepricingPolicyEvaluatedEvent,
  type RepricingPolicyListingTrace,
} from "../domain/fact";
import { goalAnchor, goalDirective, parityCurve } from "./curve-objective-fixture";
import { economicsNeverResolved } from "./round-capture-fixture";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required.");
const describeDb = databaseBaseUrl ? describe : describe.skip;

const product = { catalogItemId: "cat_portfolio_round", productId: "prod_portfolio_round" };
const seller = "acc_portfolio_round";
const policyId = "rpp_portfolio_round";
// Listing ids sort in this order; the first one has quantity 2 and matches the floored rule.
const listings = { floored: "lst_portfolio_a", held: "lst_portfolio_b", lowered: "lst_portfolio_c" } as const;
const context: EventStoreContext = {
  tenantId: "tnt_identity",
  audit: { performedByUserId: "usr_portfolio_round", forAccountId: seller },
};
const holdValue = goalAnchor("hold-value", {});
const rules: RepricingRule[] = [
  {
    conditions: [{ type: "quantity-at-least", quantity: 2 }],
    directive: goalDirective({ anchorChain: [holdValue], floor: { mode: "absolute", amount: "12.00" } }),
  },
  { conditions: [], directive: goalDirective({ anchorChain: [holdValue] }) },
];

describeDb("a portfolio goal through preview and live product rounds", () => {
  let pool: PgTransactionalPool;
  let pools: Readonly<Record<"pricing", PgTransactionalPool>>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["pricing"], "portfolio_plan_round_7710");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    pool = pools.pricing;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pool.query(pricingModule.schemaSql);
    await pool.query(eventSubscriptionSchemaSql);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => closeMultiContextTestPools(pools));

  async function seed() {
    await pool.query(
      `INSERT INTO pricing_market_listing_inputs
         (listing_id, seller_account_id, inventory_item_id, catalog_catalog_item_id, product_id, price_amount,
          price_currency_code, quantity_cap, status, updated_at, last_stream_version)
       VALUES ($1, $4, NULL, $5, $6, 6, 'USD', 2, 'active', now(), 1),
              ($2, $4, NULL, $5, $6, 9, 'USD', 1, 'active', now(), 1),
              ($3, $4, NULL, $5, $6, 15, 'USD', 1, 'active', now(), 1)`,
      [listings.floored, listings.held, listings.lowered, seller, product.catalogItemId, product.productId],
    );
    await pool.query(
      `INSERT INTO pricing_repricing_policies
         (policy_id, seller_account_id, name, status, scope_kind, rules, max_changes_per_day, created_at, updated_at)
       VALUES ($1, $2, 'Hold value', 'active', 'all-listings', $3::jsonb, 100, now(), now())`,
      [policyId, seller, JSON.stringify(rules)],
    );
    await pool.query(
      `INSERT INTO pricing_demand_curve_versions
         (catalog_item_id, product_id, version, provider_condition, provider_variant, provider_language, fingerprint,
          model_version, policy_revision_id, ladder_method, anchor_condition, exposure_start_reason, sales_coverage,
          supply_status, own_seller_exclusion_applied, built_at, currency_code, fresh_until)
       VALUES ($1, $2, 1, 'Near Mint', 'Normal', 'English', 'synthetic-portfolio-round', 'synthetic',
         'synthetic-policy', 'synthetic', NULL, 'history-window', 'synthetic', 'observed', true,
         now() - interval '1 hour', 'USD', '2100-01-01')`,
      [product.catalogItemId, product.productId],
    );
    await pool.query(
      `INSERT INTO pricing_demand_curve_points
         (catalog_item_id, product_id, version, percentile, price_amount, buyer_arrival_interval_days,
          competing_seller_count, store_win_share, median_sell_days, qualifying_sale_count, history_capped, hopeless,
          supply_status)
       SELECT $1, $2, 1, point.percentile, point.price_amount, point.buyer_arrival_interval_days,
         point.competing_seller_count, point.store_win_share, point.median_sell_days, point.qualifying_sale_count,
         point.history_capped, point.hopeless, point.supply_status
       FROM jsonb_to_recordset($3::jsonb) AS point(percentile integer, price_amount numeric(12,2),
         buyer_arrival_interval_days numeric(20,8), competing_seller_count integer, store_win_share numeric(12,10),
         median_sell_days numeric(20,8), qualifying_sale_count integer, history_capped boolean, hopeless boolean,
         supply_status text)`,
      [
        product.catalogItemId,
        product.productId,
        JSON.stringify(
          parityCurve.points.map((point) => ({
            percentile: point.percentile,
            price_amount: point.priceAmount,
            buyer_arrival_interval_days: point.buyerArrivalIntervalDays,
            competing_seller_count: point.competingSellerCount,
            store_win_share: point.storeWinShare,
            median_sell_days: point.medianSellDays,
            qualifying_sale_count: point.qualifyingSaleCount,
            history_capped: point.historyCapped,
            hopeless: point.hopeless,
            supply_status: point.supplyStatus,
          })),
        ),
      ],
    );
  }

  function harness() {
    const eventStore = createPostgresEventStore({ pool });
    const services = createRepricingEngineRuntime({ db: pool, eventStore, economics: economicsNeverResolved });
    const gateway: RepricingMarketplaceGateway = {
      applyBulkListingPriceUpdates: vi.fn<RepricingMarketplaceGateway["applyBulkListingPriceUpdates"]>(
        async ({ updates }) => ({ items: updates.map((item) => ({ listingId: item.listingId, outcome: "applied" })) }),
      ),
      pauseListing: vi.fn(async () => undefined),
      publishListing: vi.fn(async () => undefined),
    };
    const runLive = async () => {
      await services.enqueueMarketPriceSignal({
        ...product,
        amount: "9.00",
        previousAmount: "8.00",
        context,
        trigger: {
          kind: "market-price-estimated",
          eventId: "portfolio-round",
          signalVersion: "1",
          occurredAt: new Date().toISOString(),
        },
      });
      return services.processNextEvaluationJob({
        claimOwnerId: "portfolio-round-live",
        claimTtlMs: 30_000,
        marketplaceGatewayForAccount: () => gateway,
      });
    };
    return { eventStore, services, gateway, runLive };
  }

  /** The price a listing ends the round at: its target when the round changes it, else its current price. */
  const effectivePrice = (
    trace: Pick<RepricingPolicyListingTrace, "outcome" | "targetPriceAmount" | "currentPriceAmount">,
  ) => (trace.outcome === "changed" ? trace.targetPriceAmount! : trace.currentPriceAmount) as MoneyAmount;

  it("resolves the plan once per round, applies it per listing through the stages, and traces its id on every listing", async () => {
    await seed();
    const solve = vi.spyOn(holdValueGoal, "solvePortfolio");
    const { eventStore, services, gateway, runLive } = harness();

    const preview = await services.previewProductRound({ ...product, now: new Date().toISOString() });
    expect(solve).toHaveBeenCalledTimes(1);
    const previewPlan = solve.mock.results[0]!.value as PortfolioPlan;
    expect(previewPlan.status).toBe("matched");
    expect(preview.map((evaluation) => evaluation.portfolioPlanId)).toEqual([
      previewPlan.planId,
      previewPlan.planId,
      previewPlan.planId,
    ]);

    await expect(runLive()).resolves.toBe(1);
    expect(solve).toHaveBeenCalledTimes(2);
    const plan = solve.mock.results[1]!.value as PortfolioPlan;
    // The same captured inputs identify the same plan in preview and live.
    expect(plan.planId).toBe(previewPlan.planId);

    const data = (await eventStore.readAll()).find((event) => event.eventType === repricingPolicyEvaluatedEventType)!
      .payload as RepricingPolicyEvaluatedEvent["data"];
    expect(data.listings.map((trace) => [trace.listingId, trace.portfolioPlanId])).toEqual([
      [listings.floored, plan.planId],
      [listings.held, plan.planId],
      [listings.lowered, plan.planId],
    ]);
    const floored = data.listings.find((trace) => trace.listingId === listings.floored)!;
    expect(floored).toMatchObject({ targetPriceAmount: "12.00", flags: ["floor-binding"], outcome: "changed" });
    // Re-summed after every stage, the listed value is the value the plan held.
    expect(sumMoneyAmounts(data.listings.map(effectivePrice))).toBe(plan.resolvedValueAmount);
    expect(plan.targetValueAmount).toBe("30.00");
    for (const trace of data.listings) {
      const decision = plan.listings.find((entry) => entry.listingId === trace.listingId)!.decision!;
      expect(trace.anchor).toMatchObject({ source: "curve-objective", amount: decision.unconstrainedPriceAmount });
    }
    const applied = vi.mocked(gateway.applyBulkListingPriceUpdates).mock.calls.flatMap(([input]) => input.updates);
    expect(applied.map((update) => update.listingId).sort()).toEqual(
      data.listings.filter((trace) => trace.outcome === "changed").map((trace) => trace.listingId),
    );
  });
});
