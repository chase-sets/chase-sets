import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { normalizeMoneyAmount } from "@chase-sets/primitives/money";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as pricingModule } from "../../../index";
import { createPricingHealthWhatIfAdapter } from "../api/portfolio-what-if";
import { portfolioHorizonModel, sweepDailyReturnHurdles } from "../../repricing-policies/domain/portfolio/preview";
import { listDemandCurvesAsOf } from "../../market-estimates/read-model/demand-curve-queries";
import { toEconomicsForPricingGoal } from "../../economics/domain/resolution";
import { whatIfEconomics, whatIfLines, whatIfListing, whatIfNow, whatIfPoints } from "./portfolio-what-if-fixture";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required.");
const describeDb = databaseBaseUrl ? describe : describe.skip;

describeDb("Pricing Health real portfolio adapter", () => {
  let pools: Readonly<Record<"pricing", PgTransactionalPool>>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["pricing"], "pricing_what_if_9778");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.pricing.query(pricingModule.schemaSql);
  });
  afterAll(async () => closeMultiContextTestPools(pools));

  it("matches all assembled reference-id portfolios across 501 listings and preserves Economics, policy, listing and ledger bytes (AC1 AC2)", async () => {
    const db = pools.pricing;
    const rows = Array.from({ length: 501 }, (_, index) => whatIfListing(index));
    await db.query(
      `INSERT INTO pricing_market_listing_inputs
      (listing_id, seller_account_id, inventory_item_id, catalog_catalog_item_id, product_id, price_amount,
       price_currency_code, quantity_cap, status, updated_at, last_stream_version)
      SELECT listing_id, 'acc', inventory_item_id, catalog_catalog_item_id, product_id, price_amount::numeric,
       price_currency_code, quantity_cap, 'active', $2, 1
      FROM jsonb_to_recordset($1::jsonb) AS x(listing_id text, inventory_item_id text, catalog_catalog_item_id text,
       product_id text, price_amount text, price_currency_code text, quantity_cap integer)`,
      [JSON.stringify(rows), whatIfNow],
    );
    for (const line of whatIfLines) {
      await db.query(
        `INSERT INTO pricing_catalog_item_inputs
        (catalog_item_id, title, status, product_line_reference_id, product_line_name, product_line_version, updated_at)
        VALUES ($1, 'Synthetic what-if item', 'active', $2, $3, $4, $5)`,
        [
          line.catalog_item_id,
          line.product_line_reference_id,
          line.product_line_name,
          line.product_line_version,
          whatIfNow,
        ],
      );
      await db.query(
        `INSERT INTO pricing_demand_curve_versions
        (catalog_item_id, product_id, version, provider_condition, provider_variant, provider_language, fingerprint,
         model_version, policy_revision_id, ladder_method, exposure_start_reason, sales_coverage, supply_status,
         built_at, currency_code, fresh_until)
        VALUES ($1, 'prod-1', 1, 'Near Mint', 'Normal', 'English', 'synthetic-what-if', 'synthetic',
         'synthetic', 'synthetic', 'history-window', 'synthetic', 'observed', $2, 'USD', '2100-01-01')`,
        [line.catalog_item_id, whatIfNow],
      );
      for (const point of whatIfPoints)
        await db.query(
          `INSERT INTO pricing_demand_curve_points
        (catalog_item_id, product_id, version, percentile, price_amount, buyer_arrival_interval_days,
         competing_seller_count, store_win_share, median_sell_days, qualifying_sale_count, history_capped, hopeless, supply_status)
        VALUES ($1, 'prod-1', 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            line.catalog_item_id,
            point.percentile,
            point.priceAmount,
            point.buyerArrivalIntervalDays,
            point.competingSellerCount,
            point.storeWinShare,
            point.medianSellDays,
            point.qualifyingSaleCount,
            point.historyCapped,
            point.hopeless,
            point.supplyStatus,
          ],
        );
    }
    await db.query(
      `INSERT INTO pricing_economics_overrides
      (account_id, scope_key, currency_code, fact_name, override_state, override_value, set_at, last_stream_version,
       last_source_event_id, last_source_event_recorded_at)
      VALUES ('acc', 'native-marketplace', 'usd', 'dailyReturnHurdle', 'active', '0.0035', $1, 1, 'evt_synthetic', $1)`,
      [whatIfNow],
    );
    await db.query(
      `INSERT INTO pricing_inventory_acquisition_lots
      (account_id, inventory_item_id, event_stream_version, quantity, occurrence_kind, last_source_event_id, last_source_event_recorded_at)
      VALUES ('acc', 'inv-0', 1, 1, 'unknown', 'evt_synthetic', $1)`,
      [whatIfNow],
    );
    await db.query(
      `INSERT INTO pricing_repricing_policies
      (policy_id, seller_account_id, name, status, scope_kind, rules, max_changes_per_day, created_at, updated_at)
      VALUES ('rpp_synthetic_what_if', 'acc', 'Synthetic what-if policy', 'active', 'all-listings', '[]', 25, $1, $1)`,
      [whatIfNow],
    );
    await db.query(
      `INSERT INTO pricing_forecast_ledger_entries
      (entry_id, global_position, evaluation_id, seller_account_id, catalog_catalog_item_id, product_id,
       listing_id, role, goal_id, goal_version, price_amount, priced_at, forecasts)
      VALUES ('entry_synthetic', 1, 'evaluation_synthetic', 'acc', 'cat-a', 'prod-1', 'lst-0000', 'incumbent',
       'profit-per-day', 1, 10, $1, '{}')`,
      [whatIfNow],
    );

    const snapshot = async () => {
      const result = await db.query<{ bytes: string }>(`SELECT jsonb_build_object(
        'economics', (SELECT jsonb_agg(to_jsonb(x) ORDER BY account_id, fact_name) FROM pricing_economics_overrides x),
        'acquisitions', (SELECT jsonb_agg(to_jsonb(x) ORDER BY inventory_item_id) FROM pricing_inventory_acquisition_lots x),
        'policies', (SELECT jsonb_agg(to_jsonb(x) ORDER BY policy_id) FROM pricing_repricing_policies x),
        'listings', (SELECT jsonb_agg(to_jsonb(x) ORDER BY listing_id) FROM pricing_market_listing_inputs x),
        'ledger', (SELECT jsonb_agg(to_jsonb(x) ORDER BY entry_id) FROM pricing_forecast_ledger_entries x)
      )::text AS bytes`);
      return result.rows[0]!.bytes;
    };
    const before = await snapshot();
    const pageSizes: number[] = [];
    const adapter = createPricingHealthWhatIfAdapter({
      db: {
        query: async <Row>(sql: string, values?: readonly unknown[]) => {
          const result = await db.query<Row>(sql, values);
          if (sql.includes("FROM pricing_market_listing_inputs")) pageSizes.push(result.rows.length);
          return result;
        },
      },
      economics: { resolve: async () => whatIfEconomics() },
    });
    const result = await adapter.get("acc", whatIfNow);
    expect(pageSizes).toEqual([500, 1]);
    expect(
      result.portfolios.map(({ productLineReferenceId, listingCount }) => [productLineReferenceId, listingCount]),
    ).toEqual([
      [null, 501],
      ["line-a", 167],
      ["line-b", 167],
      [null, 167],
    ]);
    expect(result.portfolios[3]!.label).toBe("No product line");
    const curves = await listDemandCurvesAsOf(db, {
      identities: whatIfLines.map((line) => ({ catalogItemId: line.catalog_item_id, productId: "prod-1" })),
      asOf: whatIfNow,
    });
    for (const [index, portfolio] of result.portfolios.entries()) {
      const selected = index === 0 ? rows : rows.filter((_, rowIndex) => rowIndex % 3 === index - 1);
      const input = {
        currencyCode: "USD",
        listings: selected.map((row) => ({
          listingId: row.listing_id,
          currentPriceAmount: normalizeMoneyAmount(row.price_amount),
          curve: {
            currencyCode: "USD",
            version: 1,
            points: curves.find((curve) => curve.catalogItemId === row.catalog_catalog_item_id)!.points,
          },
          economics: toEconomicsForPricingGoal(whatIfEconomics()),
        })),
      };
      const sweep = sweepDailyReturnHurdles(input);
      expect(portfolio.snapshotHash).toBe(sweep.snapshotHash);
      expect(portfolio.horizon.samples).toEqual(portfolioHorizonModel(input).samples);
      expect(portfolio.hurdle.scenarios.map(({ dailyReturn: _dailyReturn, ...scenario }) => scenario)).toEqual(
        sweep.scenarios,
      );
      expect(
        portfolio.horizon.samples.every(
          (sample) => Number.isFinite(sample.horizonDays) && Number.isFinite(Number(sample.valueAmount)),
        ),
      ).toBe(true);
      expect(
        portfolio.hurdle.scenarios.every(
          (scenario) => Number.isFinite(scenario.dailyReturnHurdle) && Number.isFinite(scenario.dailyReturn),
        ),
      ).toBe(true);
      expect(portfolio.hurdle.scenarios[0]!.oneCopyValueAmount).not.toBe(
        portfolio.hurdle.scenarios.at(-1)!.oneCopyValueAmount,
      );
      expect(portfolio.hurdle.best?.dailyReturn).toBeGreaterThan(0);
    }
    expect(await adapter.get("acc", whatIfNow)).toEqual(result);
    expect(await snapshot()).toBe(before);
  });
});
