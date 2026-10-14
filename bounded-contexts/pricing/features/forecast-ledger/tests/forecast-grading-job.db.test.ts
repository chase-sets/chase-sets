import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createPolicyRuntime } from "@chase-sets/platform-policy/runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as pricingModule } from "../../../index";
import { pricingGoalDefinitions } from "../../repricing-policies/domain/domain";
import { createForecastLedgerRuntime } from "../api/runtime";
import { forecastGradedEventType, type ForecastGradedEvent } from "../domain/fact";
import type { ForecastGrade } from "../domain/grading";
import { insertForecastLedgerEntries } from "../read-model/queries";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const DAY_MS = 24 * 60 * 60 * 1000;
const dayZero = Date.parse("2026-08-01T00:00:00.000Z");
const at = (day: number) => new Date(dayZero + day * DAY_MS).toISOString();
const now = new Date(dayZero + 60 * DAY_MS + 3_600_000).toISOString();

describeDb("Forecast grading job (#7708)", () => {
  let pools: Readonly<Record<"pricing", PgTransactionalPool>>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["pricing"], "forecast_grading_7708");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  afterAll(async () => closeMultiContextTestPools(pools));

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    const pool = pools.pricing;
    await pool.query(pricingModule.schemaSql);
    // lst_a sells on the tape; lst_b's only tape trade was refunded; lst_c stops being priced and
    // is withdrawn; lst_d sells offline; lst_e stops being priced while still in stock.
    await pool.query(
      `INSERT INTO pricing_market_listing_inputs
         (listing_id, seller_account_id, inventory_item_id, catalog_catalog_item_id, product_id, price_amount,
          price_currency_code, quantity_cap, status, updated_at, last_stream_version)
       SELECT listing.listing_id, 'acc_seller', listing.inventory_item_id, 'cat_grading', 'prod_grading', 5, 'USD',
         listing.quantity_cap, listing.status, now(), 1
       FROM unnest($1::text[], $2::text[], $3::integer[], $4::text[])
         AS listing(listing_id, inventory_item_id, quantity_cap, status)`,
      [
        ["lst_a", "lst_b", "lst_c", "lst_d", "lst_e"],
        ["inv_a", "inv_b", "inv_c", "inv_d", "inv_e"],
        [1, 1, 0, 1, 1],
        ["active", "active", "withdrawn", "active", "active"],
      ],
    );
    const priced = (listingId: string, days: readonly number[]) =>
      days.map((day) => ({
        entryId: `evl_${day}:${listingId}:incumbent:fixed-percentile@1`,
        evaluationId: `evl_${day}`,
        sellerAccountId: "acc_seller",
        catalogItemId: "cat_grading",
        productId: "prod_grading",
        listingId,
        role: "incumbent" as const,
        goalId: "fixed-percentile",
        goalVersion: 1,
        curveVersion: 1,
        priceAmount: "5.00",
        quantity: 1,
        pricedAt: at(day),
        forecasts: { curve: { medianSellDays: 10, model: "builder-v1" } },
      }));
    const daily = Array.from({ length: 42 }, (_, index) => 18 + index);
    await insertForecastLedgerEntries(
      pool,
      [
        ...priced("lst_a", daily),
        ...priced("lst_b", daily),
        ...priced("lst_c", [18, 19, 20, 21, 22]),
        ...priced("lst_d", daily),
        ...priced("lst_e", [18, 19, 20, 21, 22]),
      ],
      "1",
    );
    await pool.query(
      `INSERT INTO pricing_market_trades
         (order_id, line_id, inventory_item_id, seller_account_id, buyer_account_id, catalog_catalog_item_id,
          product_id, unit_price_amount, currency_code, quantity, sale_channel, sold_at, excluded, exclusion_reason,
          updated_at)
       VALUES ('ord_a', 'line_1', 'inv_a', 'acc_seller', 'acc_buyer', 'cat_grading', 'prod_grading', 5, 'USD', 1,
                 'listing', $1, false, NULL, $1),
              ('ord_b', 'line_1', 'inv_b', 'acc_seller', 'acc_buyer', 'cat_grading', 'prod_grading', 5, 'USD', 1,
                 'listing', $1, true, 'refunded', $1)`,
      [at(25)],
    );
    await pool.query(
      `INSERT INTO pricing_own_sale_observations
         (sale_event_id, seller_account_id, inventory_item_id, catalog_catalog_item_id, product_id, source,
          offline_channel, applied_quantity, recorded_at, updated_at)
       VALUES ('sale_d', 'acc_seller', 'inv_d', 'cat_grading', 'prod_grading', 'offline', 'in-store', 1, $1, $1),
              ('sale_b_rejected', 'acc_seller', 'inv_b', 'cat_grading', 'prod_grading', 'offline', 'in-store', 0, $1, $1)`,
      [at(30)],
    );
  });

  function runtime() {
    const pool = pools.pricing;
    const eventStore = createPostgresEventStore({ pool });
    return {
      eventStore,
      forecastLedger: createForecastLedgerRuntime({
        pool,
        eventStore,
        policies: createPolicyRuntime({ eventStore, db: pool }),
        goalDefinitions: pricingGoalDefinitions,
      }),
    };
  }

  const grades = async () =>
    (
      await pools.pricing.query<{ horizon_days: number; closed_on: string; grade: ForecastGrade }>(
        `SELECT horizon_days, closed_on::text, grade FROM pricing_forecast_grades
         WHERE goal_id = 'fixed-percentile' AND goal_version = 1 AND role = 'incumbent'
           AND forecast_kind = 'curve' AND model = 'builder-v1' ORDER BY horizon_days`,
      )
    ).rows;
  const facts = async (eventStore: ReturnType<typeof runtime>["eventStore"]) =>
    (await eventStore.readAll())
      .filter((event) => event.eventType === forecastGradedEventType)
      .map((event) => event.payload as ForecastGradedEvent["data"]);

  it("grades closed cohorts from realized tape and own-sale facts, records ForecastGraded facts, and reuses an unchanged grade", async () => {
    const { eventStore, forecastLedger } = runtime();
    expect(await forecastLedger.runForecastGrading({ now })).toEqual({
      closedOn: "2026-09-30",
      scopesGraded: 1,
      scopesUnchanged: 0,
    });
    const first = await grades();
    expect(first.map((row) => row.horizon_days)).toEqual([14, 21, 28]);
    const day21 = first.find((row) => row.horizon_days === 21)!;
    expect(day21.closed_on).toBe("2026-09-30");
    // a (tape) and d (offline) sold, c left early out of stock, b's refunded trade is no sale, e is censored.
    expect(day21.grade).toMatchObject({ count: 4, soldShare: 0.75 });
    expect(day21.grade.baseRateBrier).toBeCloseTo(0.75 * 0.25, 12);
    const published = await facts(eventStore);
    expect(
      published.map((fact) => [fact.forecastKind, fact.model, fact.horizonDays, fact.role, fact.goalVersion]),
    ).toEqual([
      ["curve", "builder-v1", 14, "incumbent", 1],
      ["curve", "builder-v1", 21, "incumbent", 1],
      ["curve", "builder-v1", 28, "incumbent", 1],
    ]);
    expect(published[1]!.grade).toEqual(day21.grade);

    expect(await forecastLedger.runForecastGrading({ now })).toMatchObject({ scopesGraded: 0, scopesUnchanged: 1 });
    expect(await facts(eventStore)).toHaveLength(3);
    expect(await grades()).toEqual(first);

    await pools.pricing.query(
      `INSERT INTO pricing_own_sale_observations
         (sale_event_id, seller_account_id, inventory_item_id, catalog_catalog_item_id, product_id, source,
          offline_channel, applied_quantity, recorded_at, updated_at)
       VALUES ('sale_b', 'acc_seller', 'inv_b', 'cat_grading', 'prod_grading', 'offline', 'in-store', 1, $1, $1)`,
      [at(31)],
    );
    expect(await forecastLedger.runForecastGrading({ now })).toMatchObject({ scopesGraded: 1, scopesUnchanged: 0 });
    const regraded = await grades();
    expect(regraded.find((row) => row.horizon_days === 21)!.grade).toMatchObject({ count: 4, soldShare: 1 });
    expect(await facts(eventStore)).toHaveLength(6);
  });
});
