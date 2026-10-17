import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as pricingModule } from "../../../index";
import { fixedPercentileGoal } from "../../repricing-policies/domain/goals/fixed-percentile";
import { createRepricingEngineRuntime, type RepricingMarketplaceGateway } from "../../repricing-engine/api/runtime";
import {
  repricingPolicyEvaluatedEventType,
  type RepricingPolicyEvaluatedEvent,
} from "../../repricing-engine/domain/fact";
import { goalAnchor, goalDirective } from "../../repricing-engine/tests/curve-objective-fixture";
import { dryRunContext, seedDryRunListings } from "../../repricing-engine/tests/dry-run-fixture";
import { economicsNeverResolved } from "../../repricing-engine/tests/round-capture-fixture";
import { registerShadowGoals, shadowGoal } from "../../repricing-engine/tests/shadow-goal-fixture";
import { BUYER_CHOICE_CALIBRATION, estimateBuyerChoiceSellDays } from "../domain/buyer-choice";
import {
  CONDITION_RATE_METHOD,
  conditionRateMedianSellDays,
  estimateConditionSaleIntervalDays,
} from "../domain/condition-rate";
import { buildForecastLedgerProjectionHandlers } from "../read-model/projection";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const product = { catalogItemId: "cat_00000000", productId: "prod_00000000" };
const DAY_MS = 24 * 60 * 60 * 1000;

type LedgerRow = Readonly<{
  entry_id: string;
  listing_id: string;
  role: "incumbent" | "shadow";
  goal_id: string;
  goal_version: number;
  curve_version: string | null;
  price_amount: string;
  quantity: number | null;
  priced_at: Date;
  forecasts: Readonly<Record<string, Readonly<{ medianSellDays: number; model: string }>>>;
}>;

describeDb("the Forecast Ledger records every emitted and every shadow price (#7708)", () => {
  let pools: Readonly<Record<"pricing", PgTransactionalPool>>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["pricing"], "forecast_ledger_7708");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => closeMultiContextTestPools(pools));

  const weeks = Array.from({ length: 20 }, (_, index) => ({
    weekStart: new Date(Date.now() - (index + 1) * 7 * DAY_MS).toISOString().slice(0, 10),
    transactionCount: index % 2 === 0 ? 2 : 1,
  }));

  async function seed() {
    await resetMultiContextTestSchemas(pools);
    const pool = pools.pricing;
    await pool.query(pricingModule.schemaSql);
    await seedDryRunListings(pool, 3, 1);
    await pool.query(
      "UPDATE pricing_market_listing_inputs SET quantity_cap = 4 WHERE listing_id = 'lst_7910_00000003'",
    );
    await pool.query(
      `INSERT INTO pricing_repricing_policies
      (policy_id, seller_account_id, name, status, scope_kind, rules, max_changes_per_day, created_at, updated_at)
      VALUES ('rpp_ledger', 'acc_7910', 'Ledger', 'active', 'all-listings', $1::jsonb, 10, $2, $2)`,
      [
        JSON.stringify([{ conditions: [], directive: goalDirective({ anchorChain: [goalAnchor()] }) }]),
        new Date().toISOString(),
      ],
    );
    await pool.query(
      `INSERT INTO pricing_demand_curve_versions
      (catalog_item_id, product_id, version, provider_condition, provider_variant, provider_language, fingerprint,
       model_version, policy_revision_id, ladder_method, anchor_condition, exposure_start_reason, sales_coverage,
       supply_status, own_seller_exclusion_applied, built_at, currency_code, fresh_until)
      VALUES ($1, $2, 1, 'Near Mint', 'Normal', 'English', 'ledger-fixture', 'synthetic-builder-v1', 'synthetic',
        'synthetic', NULL, 'history-window', 'synthetic', 'observed', true, now() - interval '1 hour', 'USD', '2100-01-01')`,
      [product.catalogItemId, product.productId],
    );
    await pool.query(
      `INSERT INTO pricing_demand_curve_points
      (catalog_item_id, product_id, version, percentile, price_amount, buyer_arrival_interval_days,
       competing_seller_count, store_win_share, median_sell_days, qualifying_sale_count, history_capped, hopeless, supply_status)
      VALUES ($1, $2, 1, 10, 5.00, 2, 3, 0.5, 5, 9, false, false, 'observed'),
             ($1, $2, 1, 65, 12.00, 5, 4, 0.5, 20, 6, false, false, 'observed'),
             ($1, $2, 1, 90, 30.00, 10, 2, 0.25, 60, 3, false, false, 'observed')`,
      [product.catalogItemId, product.productId],
    );
    await pool.query(
      `INSERT INTO pricing_external_market_captures
      (capture_id, provider_key, catalog_item_id, external_key, signal_pass_started_at, signal_policy_revision_id,
       products_per_pass, capture_started_at, capture_completed_at, authenticated_request, recorded_signal_count,
       unresolved_signal_count, outcome_kind, rejected_row_count)
      VALUES ('cap_ledger', 'tcgplayer', $1, 'ext_ledger', now(), 'synthetic', 1, now(), now(), false, 0, 0, 'recorded', 0)`,
      [product.catalogItemId],
    );
    await pool.query(
      `INSERT INTO pricing_external_weekly_sale_buckets
      (provider_key, external_key, catalog_item_id, catalog_product_key, week_start, provider_condition,
       provider_variant, provider_language, transaction_count, quantity_sold, last_capture_id, last_observed_at, updated_at)
      SELECT 'tcgplayer', 'ext_ledger', $1, $2, week.week_start::date, 'Near Mint', 'Normal', 'English',
        week.transaction_count, week.transaction_count, 'cap_ledger', now(), now()
      FROM unnest($3::text[], $4::integer[]) AS week(week_start, transaction_count)`,
      [
        product.catalogItemId,
        product.productId,
        weeks.map((week) => week.weekStart),
        weeks.map((week) => week.transactionCount),
      ],
    );
  }

  async function evaluate() {
    const pool = pools.pricing;
    const eventStore = createPostgresEventStore({ pool });
    const services = createRepricingEngineRuntime({ db: pool, eventStore, economics: economicsNeverResolved });
    const gateway: RepricingMarketplaceGateway = {
      applyBulkListingPriceUpdates: vi.fn<RepricingMarketplaceGateway["applyBulkListingPriceUpdates"]>(
        async ({ updates }) => ({ items: updates.map((item) => ({ listingId: item.listingId, outcome: "applied" })) }),
      ),
      pauseListing: vi.fn(async () => undefined),
      publishListing: vi.fn(async () => undefined),
    };
    await services.enqueueMarketPriceSignal({
      ...product,
      amount: "12.00",
      previousAmount: "10.00",
      context: dryRunContext,
      trigger: {
        kind: "market-price-estimated",
        eventId: "ledger-fixture",
        signalVersion: "1",
        occurredAt: new Date().toISOString(),
      },
    });
    expect(
      await services.processNextEvaluationJob({
        claimOwnerId: "ledger-fixture",
        claimTtlMs: 30_000,
        marketplaceGatewayForAccount: () => gateway,
      }),
    ).toBe(1);
    return (await eventStore.readAll()).find((entry) => entry.eventType === repricingPolicyEvaluatedEventType)!;
  }

  const ledger = async () =>
    (
      await pools.pricing.query<LedgerRow>(
        `SELECT entry_id, listing_id, role, goal_id, goal_version, curve_version::text, price_amount::text, quantity,
           priced_at, forecasts
         FROM pricing_forecast_ledger_entries ORDER BY listing_id, role`,
      )
    ).rows;

  it("writes one row per emitted incumbent price and per shadow price, with the forecasts fixed at evaluation and the goal and curve versions, however late or often it is projected", async () => {
    await seed();
    registerShadowGoals([
      shadowGoal("fixed-percentile", {
        solve: (input) => fixedPercentileGoal.solve({ ...input, parameters: { percentile: 90 } }),
      }),
    ]);
    const event = await evaluate();
    const data = event.payload as RepricingPolicyEvaluatedEvent["data"];
    expect(
      data.listings.map((trace) => [trace.listingId, trace.outcome, trace.quantity, trace.shadow?.length]),
    ).toEqual([
      ["lst_7910_00000001", "changed", 1, 1],
      ["lst_7910_00000002", "changed", 1, 1],
      ["lst_7910_00000003", "changed", 4, 1],
    ]);

    // The provider observes the weeks again before the ledger first projects the evaluation.
    await pools.pricing.query("UPDATE pricing_external_weekly_sale_buckets SET transaction_count = 40");
    const handler = buildForecastLedgerProjectionHandlers(pools.pricing)[event.eventType]!;
    await handler(toTransportEvent(event));

    const pricedAt = Date.parse(data.evaluatedAt);
    const condition = (storeWinShare: number) => ({
      medianSellDays: conditionRateMedianSellDays(estimateConditionSaleIntervalDays(weeks, pricedAt), storeWinShare)!,
      model: CONDITION_RATE_METHOD,
    });
    const buyerChoice = (price: number) => ({
      medianSellDays: estimateBuyerChoiceSellDays({ buyerIntervalDays: 2, competingSellers: 4 }, price)!,
      model: BUYER_CHOICE_CALIBRATION.name,
    });
    const rows = await ledger();
    expect(rows).toHaveLength(6);
    for (const trace of data.listings) {
      const incumbent = rows.find((row) => row.listing_id === trace.listingId && row.role === "incumbent")!;
      const shadow = rows.find((row) => row.listing_id === trace.listingId && row.role === "shadow")!;
      expect(incumbent).toMatchObject({
        goal_id: "fixed-percentile",
        goal_version: 1,
        curve_version: "1",
        price_amount: trace.targetPriceAmount,
        quantity: trace.quantity,
      });
      expect(new Date(incumbent.priced_at).getTime()).toBe(pricedAt);
      expect(incumbent.forecasts).toEqual(trace.forecasts);
      expect(incumbent.forecasts).toEqual({
        curve: { medianSellDays: trace.anchor!.goal!.forecastMedianSellDays, model: "synthetic-builder-v1" },
        "buyer-choice": {
          medianSellDays: expect.closeTo(buyerChoice(12).medianSellDays, 9),
          model: buyerChoice(12).model,
        },
        "condition-rate": {
          medianSellDays: expect.closeTo(condition(0.5).medianSellDays, 9),
          model: CONDITION_RATE_METHOD,
        },
      });
      const shadowTrace = trace.shadow![0]!;
      expect(shadow).toMatchObject({
        goal_id: "fixed-percentile",
        goal_version: 2,
        curve_version: "1",
        price_amount: "30.00",
        quantity: trace.quantity,
      });
      expect(shadow.forecasts).toEqual(shadowTrace.forecasts);
      expect(shadow.forecasts).toEqual({
        curve: { medianSellDays: shadowTrace.anchor!.goal!.forecastMedianSellDays, model: "synthetic-builder-v1" },
        "buyer-choice": {
          medianSellDays: expect.closeTo(buyerChoice(30).medianSellDays, 9),
          model: buyerChoice(30).model,
        },
        "condition-rate": {
          medianSellDays: expect.closeTo(condition(0.25).medianSellDays, 9),
          model: CONDITION_RATE_METHOD,
        },
      });
    }

    // A redelivered evaluation, even after the provider weeks change again, never rewrites an entry.
    await pools.pricing.query("UPDATE pricing_external_weekly_sale_buckets SET transaction_count = 7");
    await handler(toTransportEvent(event));
    expect(await ledger()).toEqual(rows);

    // Replaying into the projection's cleared table, after yet another change, records the same forecasts.
    await pools.pricing.query("DELETE FROM pricing_forecast_ledger_entries");
    await pools.pricing.query("UPDATE pricing_external_weekly_sale_buckets SET transaction_count = 3");
    await handler(toTransportEvent(event));
    expect(await ledger()).toEqual(rows);
  });
});
