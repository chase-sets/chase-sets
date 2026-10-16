import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createNoopCommercialTermsResolver, type CommercialTermsResolver } from "@chase-sets/commercial-terms/server";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import { createPolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { eventSubscriptionSchemaSql } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as pricingModule } from "../../../index";
import { createEconomicsServices, type EconomicsServices } from "../../economics/api/services";
import { toEconomicsForPricingGoal, type EconomicsResolution } from "../../economics/domain/resolution";
import { listDemandCurvesAsOf } from "../../market-estimates/read-model/demand-curve-queries";
import { resolvePricingGoal, type RepricingRule } from "../../repricing-policies/domain/domain";
import { listRepricingActivity } from "../api/activity";
import { createRepricingEngineRuntime, type RepricingMarketplaceGateway } from "../api/runtime";
import type { RepricingListingEvaluation } from "../domain/evaluate";
import {
  repricingPolicyEvaluatedEventType,
  type RepricingPolicyEvaluatedEvent,
  type RepricingPolicyListingTrace,
} from "../domain/fact";
import * as roundPlanner from "../domain/round";
import { goalAnchor, goalDirective, parityCurve } from "./curve-objective-fixture";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required.");
const describeDb = databaseBaseUrl ? describe : describe.skip;

const product = { catalogItemId: "cat_goal_round", productId: "prod_goal_round" };
const seller = "acc_goal_round";
const policyId = "rpp_goal_round";
// Listing ids sort in this order, which the daily change budget admits.
const listings = {
  noInventoryItem: "lst_goal_a_no_item",
  percentile: "lst_goal_b_percentile",
  profit: "lst_goal_c_profit",
} as const;
const context: EventStoreContext = {
  tenantId: "tnt_identity",
  audit: { performedByUserId: "usr_goal_round", forAccountId: seller },
};
// Quantity 2 matches the profit-per-day rule; the default rule prices at a fixed percentile.
const rules: RepricingRule[] = [
  {
    conditions: [{ type: "quantity-at-least", quantity: 2 }],
    directive: goalDirective({ anchorChain: [goalAnchor("profit-per-day", {}), { source: "market-estimate" }] }),
  },
  { conditions: [], directive: goalDirective() },
];
const syntheticTerms: CommercialTermsResolver = {
  ...createNoopCommercialTermsResolver(),
  resolveListingTerms: async (input) => ({
    accountId: input.accountId,
    accountType: "business",
    basisAmount: input.amount,
    marketplaceSalesFeeUnitAmount: "0.00",
    sellerNetUnitAmount: input.amount,
    marketplaceSalesFeePercentageBps: 1_075,
    marketplaceSalesFeeFixedAmount: "0.30",
    marketplaceSalesFeeCapAmount: null,
    shippingAllowancePercentageBps: 0,
    scheduleId: "synthetic-goal-round-schedule",
    agreementId: null,
    resolvedAt: input.effectiveAt!,
  }),
};

function normalized(trace: RepricingListingEvaluation | RepricingPolicyListingTrace) {
  const { listingId, targetPriceAmount, ruleIndex, anchor, exhaustedAnchors, clamps, flags, skipReason } = trace;
  return { listingId, targetPriceAmount, ruleIndex, anchor, exhaustedAnchors, clamps, flags, skipReason };
}

describeDb("curve-objective rounds through live, preview and dry-run pages", () => {
  let pool: PgTransactionalPool;
  let pools: Readonly<Record<"pricing", PgTransactionalPool>>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["pricing"], "curve_objective_round_9309");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    pool = pools.pricing;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pool.query(pricingModule.schemaSql);
    // Economics reads projection checkpoints, which the runtime composes beside every module schema.
    await pool.query(eventSubscriptionSchemaSql);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => closeMultiContextTestPools(pools));

  async function seed(maxChangesPerDay = 100) {
    await pool.query(
      `INSERT INTO pricing_market_listing_inputs
         (listing_id, seller_account_id, inventory_item_id, catalog_catalog_item_id, product_id, price_amount,
          price_currency_code, quantity_cap, status, updated_at, last_stream_version)
       VALUES ($1, $4, NULL, $5, $6, 10, 'USD', 2, 'active', now(), 1),
              ($2, $4, 'inv_goal_percentile', $5, $6, 10, 'USD', 1, 'active', now(), 1),
              ($3, $4, 'inv_goal_profit', $5, $6, 10, 'USD', 2, 'active', now(), 1)`,
      [
        listings.noInventoryItem,
        listings.percentile,
        listings.profit,
        seller,
        product.catalogItemId,
        product.productId,
      ],
    );
    await pool.query(
      `INSERT INTO pricing_repricing_policies
         (policy_id, seller_account_id, name, status, scope_kind, rules, max_changes_per_day, created_at, updated_at)
       VALUES ($1, $2, 'Goals', 'active', 'all-listings', $3::jsonb, $4, now(), now())`,
      [policyId, seller, JSON.stringify(rules), maxChangesPerDay],
    );
    await pool.query(
      `INSERT INTO pricing_market_price_estimates
         (catalog_catalog_item_id, product_id, estimate_version, window_started_at, window_ended_at, amount,
          currency_code, band_low_amount, band_high_amount, confidence, platform_verified_trade_count,
          platform_trade_count, external_comp_count, estimated_at, fresh_until, disclosure, updated_at)
       VALUES ($1, $2, 1, now(), now(), 9.00, 'USD', 9.00, 9.00, 'medium', 3, 3, 0, now(), '2100-01-01', 'account', now())`,
      [product.catalogItemId, product.productId],
    );
    await pool.query(
      `INSERT INTO pricing_demand_curve_versions
         (catalog_item_id, product_id, version, provider_condition, provider_variant, provider_language, fingerprint,
          model_version, policy_revision_id, ladder_method, anchor_condition, exposure_start_reason, sales_coverage,
          supply_status, own_seller_exclusion_applied, built_at, currency_code, fresh_until)
       VALUES ($1, $2, 1, 'Near Mint', 'Normal', 'English', 'synthetic-goal-round', 'synthetic', 'synthetic-policy',
         'synthetic', NULL, 'history-window', 'synthetic', 'observed', true, now() - interval '1 hour', 'USD',
         '2100-01-01')`,
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

  function harness(
    options: Readonly<{ commercialTermsResolver?: CommercialTermsResolver; failingSql?: RegExp | undefined }> = {},
  ) {
    const eventStore = createPostgresEventStore({ pool });
    const real = createEconomicsServices({
      eventStore,
      db: pool,
      policies: createPolicyRuntime({ eventStore, db: pool }),
      commercialTermsResolver: options.commercialTermsResolver ?? syntheticTerms,
      channelConnectionIdentityReader: { resolve: async () => null },
    });
    const resolve = vi.fn<EconomicsServices["resolve"]>((request) => real.resolve(request));
    const statements: string[] = [];
    const db: PgTransactionalPool = {
      connect: pool.connect.bind(pool),
      query: async <Row>(sql: string, values?: readonly unknown[]) => {
        statements.push(sql);
        if (options.failingSql?.test(sql)) throw new Error("synthetic curve read outage");
        return pool.query<Row>(sql, values);
      },
    };
    const services = createRepricingEngineRuntime({ db, eventStore, economics: { resolve } });
    const curveQueries = () => ({
      versions: statements.filter((sql) => sql.includes("pricing_demand_curve_versions")).length,
      points: statements.filter((sql) => sql.includes("pricing_demand_curve_points")).length,
    });
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
          eventId: "goal-round",
          signalVersion: "1",
          occurredAt: new Date().toISOString(),
        },
      });
      return services.processNextEvaluationJob({
        claimOwnerId: "goal-round-live",
        claimTtlMs: 30_000,
        marketplaceGatewayForAccount: () => gateway,
      });
    };
    const reset = () => {
      statements.length = 0;
      resolve.mockClear();
    };
    return { eventStore, services, resolve, curveQueries, runLive, reset };
  }

  const expectedRequest = (effectiveAt: string) => ({
    accountId: seller,
    scope: { kind: "native-marketplace" },
    catalogItemId: product.catalogItemId,
    inventoryItemId: "inv_goal_profit",
    marketUnitPrice: { amount: "9.00", currency: "usd" },
    quantity: 1,
    effectiveAt,
  });

  it("reads one curve per page, resolves Economics once per listing that needs it, and evaluates identically", async () => {
    await seed();
    const { eventStore, services, resolve, curveQueries, runLive, reset } = harness();
    const plan = vi.spyOn(roundPlanner, "planRepricingRound");

    reset();
    const now = new Date().toISOString();
    const preview = await services.previewProductRound({ ...product, now });
    expect(curveQueries()).toEqual({ versions: 1, points: 1 });
    expect(resolve.mock.calls).toEqual([[expectedRequest(now)]]);
    const resolution: EconomicsResolution = await resolve.mock.results[0]!.value;
    expect(resolution.kind).toBe("resolved");

    reset();
    const run = await services.enqueueDryRun(
      {
        sellerAccountId: seller,
        body: { scope: { kind: "all-listings" }, excludedListingIds: [], rules, maxChangesPerDay: 100 },
        replacingPolicyId: policyId,
      },
      context,
    );
    await services.processNextDryRunJob({ claimOwnerId: "goal-round-dry", claimTtlMs: 30_000 });
    expect(curveQueries()).toEqual({ versions: 1, points: 1 });
    const capturedAt = new Date(run!.requestedAt).toISOString();
    expect(resolve.mock.calls).toEqual([
      [expectedRequest(capturedAt)],
      [{ ...expectedRequest(capturedAt), inventoryItemId: listings.percentile }],
    ]);
    const dry = await services.listDryRunTraces(seller, run!.dryRunId);

    reset();
    const plannedBefore = plan.mock.results.length;
    await expect(runLive()).resolves.toBe(1);
    expect(curveQueries()).toEqual({ versions: 1, points: 1 });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0]![0]).toMatchObject({ ...expectedRequest(now), effectiveAt: expect.any(String) });
    const live: readonly RepricingListingEvaluation[] = plan.mock.results[plannedBefore]!.value;

    const curve = (await listDemandCurvesAsOf(pool, { identities: [product], asOf: now }))[0]!;
    const profit = resolvePricingGoal("profit-per-day", 1)!.solve({
      curve: { currencyCode: curve.currencyCode!, version: curve.version, points: curve.points },
      economics: toEconomicsForPricingGoal(resolution),
      parameters: {},
    });
    if (profit.kind !== "decision") throw new Error(`profit-per-day returned ${profit.reason}.`);
    const goalAnchorTrace = (goalId: string, amount: string) => ({
      source: "curve-objective",
      amount,
      stratum: "curve-objective",
      contributingListingCount: 0,
      goal: expect.objectContaining({ goalId, goalVersion: 1, curveVersion: 1 }),
    });
    const expected = [
      {
        listingId: listings.noInventoryItem,
        targetPriceAmount: "9.00",
        ruleIndex: 0,
        anchor: { source: "market-estimate", amount: "9.00", stratum: "market-estimate", contributingListingCount: 0 },
        exhaustedAnchors: [{ source: "curve-objective", state: "absent", reason: "economics-unavailable" }],
        clamps: { floor: false, ceiling: false, maxMove: false },
        flags: [],
        skipReason: null,
      },
      {
        listingId: listings.percentile,
        targetPriceAmount: "8.75",
        ruleIndex: 1,
        anchor: goalAnchorTrace("fixed-percentile", "8.75"),
        exhaustedAnchors: [],
        clamps: { floor: false, ceiling: false, maxMove: false },
        flags: [],
        skipReason: null,
      },
      {
        listingId: listings.profit,
        targetPriceAmount: profit.selectedPriceAmount,
        ruleIndex: 0,
        anchor: goalAnchorTrace("profit-per-day", profit.selectedPriceAmount),
        exhaustedAnchors: [],
        clamps: { floor: false, ceiling: false, maxMove: false },
        flags: [],
        skipReason: null,
      },
    ];
    const byListing = (items: readonly (RepricingListingEvaluation | RepricingPolicyListingTrace)[]) =>
      [...items].sort((left, right) => left.listingId.localeCompare(right.listingId)).map(normalized);
    expect(byListing(preview)).toEqual(expected);
    expect(byListing(live)).toEqual(byListing(preview));
    expect(byListing(dry)).toEqual(byListing(preview));

    const fact = (await eventStore.readAll()).find((event) => event.eventType === repricingPolicyEvaluatedEventType)!;
    const data = fact.payload as RepricingPolicyEvaluatedEvent["data"];
    expect(data.goalInputs).toEqual({ curveVersion: 1, economicsResolved: 1, economicsUnavailable: 1 });
    expect(data.listings.map((trace) => [trace.listingId, trace.outcome])).toEqual([
      [listings.noInventoryItem, "changed"],
      [listings.percentile, "changed"],
      [listings.profit, "changed"],
    ]);
  });

  it("applies the daily change budget to goal-priced listings exactly as to existing anchors", async () => {
    await seed(2);
    const { eventStore, runLive } = harness();
    await expect(runLive()).resolves.toBe(1);
    const fact = (await eventStore.readAll()).find((event) => event.eventType === repricingPolicyEvaluatedEventType)!;
    expect(
      (fact.payload as RepricingPolicyEvaluatedEvent["data"]).listings.map((trace) => [
        trace.listingId,
        trace.outcome,
        trace.skipReason,
      ]),
    ).toEqual([
      [listings.noInventoryItem, "changed", null],
      [listings.percentile, "changed", null],
      [listings.profit, "skipped", "budget-exhausted"],
    ]);
  });

  it("traces unavailable Economics as a reason and completes the round", async () => {
    await seed();
    const { eventStore, resolve, runLive } = harness({
      commercialTermsResolver: {
        ...syntheticTerms,
        resolveListingTerms: async () => {
          throw new Error("synthetic Commercial Terms outage");
        },
      },
    });
    await expect(runLive()).resolves.toBe(1);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(await resolve.mock.results[0]!.value).toMatchObject({ kind: "unavailable", reason: "terms-unavailable" });
    const data = (await eventStore.readAll()).find((event) => event.eventType === repricingPolicyEvaluatedEventType)!
      .payload as RepricingPolicyEvaluatedEvent["data"];
    expect(data.goalInputs).toEqual({ curveVersion: 1, economicsResolved: 0, economicsUnavailable: 2 });
    expect(data.listings.find((trace) => trace.listingId === listings.profit)).toMatchObject({
      targetPriceAmount: "9.00",
      anchor: { source: "market-estimate" },
      exhaustedAnchors: [{ source: "curve-objective", state: "absent", reason: "economics-unavailable" }],
      outcome: "changed",
    });
  });

  it.each([
    { failure: "an Economics resolve", economicsOutage: true, name: "RepricingEconomicsResolveError" },
    { failure: "a curve read", failingSql: /pricing_demand_curve_versions/, name: "RepricingDemandCurveReadError" },
  ])("fails the round job with a named error when $failure throws", async ({ economicsOutage, failingSql, name }) => {
    await seed();
    const { eventStore, resolve, runLive } = harness({ failingSql });
    const outage = new Error(economicsOutage ? "synthetic Economics outage" : "synthetic curve read outage");
    if (economicsOutage) resolve.mockRejectedValue(outage);
    await expect(runLive()).rejects.toMatchObject({ name, cause: { message: outage.message } });
    expect(
      (await eventStore.readAll()).filter((event) => event.eventType === repricingPolicyEvaluatedEventType),
    ).toEqual([]);
  });

  it("decodes and projects a recorded v1 evaluated event without the goal fields", async () => {
    const { eventStore, services } = harness();
    await pool.query(
      `INSERT INTO pricing_repricing_policies
         (policy_id, seller_account_id, name, status, scope_kind, rules, max_changes_per_day, created_at, updated_at)
       VALUES ($1, $2, 'Recorded', 'active', 'all-listings', '[]', 10, now(), now())`,
      [policyId, seller],
    );
    const evaluatedAt = "2026-10-01T12:00:00.000Z";
    const recorded: RepricingPolicyEvaluatedEvent["data"] = {
      schemaVersion: 1,
      evaluationId: "evaluation-recorded-v1",
      policyId,
      policyRevision: "1",
      sellerAccountId: seller,
      ...product,
      trigger: { kind: "daily-drift-sweep", eventId: "event-recorded-v1", signalVersion: "1", occurredAt: evaluatedAt },
      listingsEvaluated: 1,
      listingsChanged: 1,
      listingsSkipped: 0,
      listings: [
        {
          listingId: listings.percentile,
          currentPriceAmount: "10.00",
          targetPriceAmount: "9.50",
          ruleIndex: 0,
          anchor: {
            source: "market-estimate",
            amount: "9.50",
            stratum: "market-estimate",
            contributingListingCount: 0,
          },
          exhaustedAnchors: [{ source: "lowest-competing-ask", state: "absent" }],
          clamps: { floor: true, ceiling: false, maxMove: false },
          flags: ["floor-binding"],
          outcome: "changed",
          skipReason: null,
        },
      ],
      signalToEvaluationLatencyMs: 0,
      evaluatedAt,
    };
    await eventStore.appendToStream({
      streamId: "pricing.repricing-evaluation-recorded-v1",
      expectedVersion: "no_stream",
      context,
      events: [{ eventType: repricingPolicyEvaluatedEventType, payload: recorded }],
    });
    const [stored] = await eventStore.readAll();
    expect(stored!.payload).toEqual(recorded);
    await services.projectors[0]!.handlers[stored!.eventType]!(toTransportEvent(stored!));
    const activity = await listRepricingActivity(pool, {
      accountId: seller,
      policyId,
      limit: 10,
      now: "2026-10-02T00:00:00.000Z",
    });
    expect(activity.rows.map((row) => [row.listingId, row.trace])).toEqual([
      [listings.percentile, recorded.listings[0]],
    ]);
    expect(activity.filterCounts).toMatchObject({ changed: 1, "floor-binding": 1 });
  });
});
