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
import { repricingResultCopyKey, resolveRepricingAnchorWording } from "../../repricing-policies/ui/activity-copy";
import { listRepricingActivity } from "../api/activity";
import { createRepricingEngineRuntime, type RepricingMarketplaceGateway } from "../api/runtime";
import { repricingPolicyEvaluatedEventType, type RepricingPolicyEvaluatedEvent } from "../domain/fact";
import * as planner from "../domain/round";
import { readProductRoundState } from "../read-model/product-round-state";
import { goalAnchor, goalDirective } from "./curve-objective-fixture";
import { dryRunContext, seedDryRunListings } from "./dry-run-fixture";
import { economicsNeverResolved } from "./round-capture-fixture";
import { registerShadowGoals, shadowGoal } from "./shadow-goal-fixture";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const product = { catalogItemId: "cat_00000000", productId: "prod_00000000" };

describeDb("shadow goals are trace-only live-round comparisons", () => {
  let pools: Readonly<Record<"pricing", PgTransactionalPool>>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["pricing"], "shadow_goals_9310");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  afterAll(async () => closeMultiContextTestPools(pools));

  async function seed(pause: boolean) {
    await resetMultiContextTestSchemas(pools);
    const pool = pools.pricing;
    await pool.query(pricingModule.schemaSql);
    await seedDryRunListings(pool, 3, 1);
    await pool.query(`UPDATE pricing_market_listing_inputs SET status = 'paused', pause_reason = 'policy-input-missing'
      WHERE listing_id = 'lst_7910_00000002'`);
    await pool.query(`INSERT INTO pricing_repricing_policy_listing_pauses
      (listing_id, policy_id, paused_at, input_available_since, resumed_at, updated_at)
      VALUES ('lst_7910_00000002', 'rpp_shadow', now() - interval '2 days', now() - interval '1 day', NULL, now())`);
    const rules = [
      {
        conditions: [],
        directive: goalDirective({
          anchorChain: pause ? [goalAnchor()] : [goalAnchor(), goalAnchor("target-horizon", { horizonDays: 30 })],
          terminal: { kind: "pause", reason: "missing" },
        }),
      },
    ];
    await pool.query(
      `INSERT INTO pricing_repricing_policies
      (policy_id, seller_account_id, name, status, scope_kind, rules, max_changes_per_day, created_at, updated_at)
      VALUES ('rpp_shadow', 'acc_7910', 'Shadow comparison', 'active', 'all-listings', $1::jsonb, 2, $2, $2)`,
      [JSON.stringify(rules), new Date().toISOString()],
    );
    await pool.query(
      `INSERT INTO pricing_demand_curve_versions
      (catalog_item_id, product_id, version, provider_condition, provider_variant, provider_language, fingerprint,
       model_version, policy_revision_id, ladder_method, anchor_condition, exposure_start_reason, sales_coverage,
       supply_status, own_seller_exclusion_applied, built_at, currency_code, fresh_until)
      VALUES ($1, $2, 1, 'Near Mint', 'Normal', 'English', 'shadow-fixture', 'synthetic', 'synthetic', 'synthetic', NULL,
        'history-window', 'synthetic', 'observed', true, now() - interval '1 hour', 'USD', '2100-01-01')`,
      [product.catalogItemId, product.productId],
    );
    await pool.query(
      `INSERT INTO pricing_demand_curve_points
      (catalog_item_id, product_id, version, percentile, price_amount, buyer_arrival_interval_days,
       competing_seller_count, store_win_share, median_sell_days, qualifying_sale_count, history_capped, hopeless, supply_status)
      VALUES ($1, $2, 1, 10, 5.00, 2, 1, 0.5, 5, 9, false, false, 'observed'),
             ($1, $2, 1, 65, 12.00, 5, 1, 0.5, 20, 6, false, false, 'observed'),
             ($1, $2, 1, 90, 30.00, 10, 1, 0.5, 60, 3, false, false, 'observed')`,
      [product.catalogItemId, product.productId],
    );
  }

  function harness() {
    const pool = pools.pricing;
    const eventStore = createPostgresEventStore({ pool });
    const resolve = vi.fn(economicsNeverResolved.resolve);
    const queries: string[] = [];
    const db: PgTransactionalPool = {
      connect: pool.connect.bind(pool),
      query: <Row>(sql: string, values?: readonly unknown[]) => {
        queries.push(sql);
        return pool.query<Row>(sql, values);
      },
    };
    const services = createRepricingEngineRuntime({ db, eventStore, economics: { resolve } });
    const gateway: RepricingMarketplaceGateway = {
      applyBulkListingPriceUpdates: vi.fn<RepricingMarketplaceGateway["applyBulkListingPriceUpdates"]>(
        async ({ updates }) => ({
          items: updates.map((item) => ({
            listingId: item.listingId,
            outcome: item.listingId === "lst_7910_00000001" ? "conflict" : "applied",
          })),
        }),
      ),
      pauseListing: vi.fn(async () => undefined),
      publishListing: vi.fn(async () => undefined),
    };
    return { services, gateway, resolve, queries, eventStore };
  }

  async function live(h: ReturnType<typeof harness>) {
    await h.services.enqueueMarketPriceSignal({
      ...product,
      amount: "12.00",
      previousAmount: "10.00",
      context: dryRunContext,
      trigger: {
        kind: "market-price-estimated",
        eventId: "shadow-fixture",
        signalVersion: "1",
        occurredAt: new Date().toISOString(),
      },
    });
    expect(
      await h.services.processNextEvaluationJob({
        claimOwnerId: "shadow-fixture",
        claimTtlMs: 30_000,
        marketplaceGatewayForAccount: () => h.gateway,
      }),
    ).toBe(1);
    const event = (await h.eventStore.readAll()).find(
      (entry) => entry.eventType === repricingPolicyEvaluatedEventType,
    )!;
    const data = event.payload as RepricingPolicyEvaluatedEvent["data"];
    const state = await readProductRoundState(pools.pricing, product);
    await h.services.projectors[0]!.handlers[event.eventType]!(toTransportEvent(event));
    const activity = await listRepricingActivity(pools.pricing, {
      accountId: "acc_7910",
      policyId: "rpp_shadow",
      limit: 10,
      now: new Date().toISOString(),
    });
    return {
      data,
      activity: {
        ...activity,
        rows: activity.rows.map(({ trace, ...row }) => {
          const { shadow: _shadow, ...incumbent } = trace;
          return {
            ...row,
            trace: incumbent,
            wording: resolveRepricingAnchorWording(trace),
            result: repricingResultCopyKey(trace),
          };
        }),
      },
      budget: (await pools.pricing.query("SELECT changes_reserved FROM pricing_repricing_daily_change_budgets")).rows,
      // The DB-owned concurrency generation uses clock_timestamp(), not the captured round instant.
      state: state && {
        next_eligible_at: state.next_eligible_at,
        same_direction_rounds: state.same_direction_rounds,
        last_direction: state.last_direction,
        frozen_until: state.frozen_until,
      },
      prices: vi.mocked(h.gateway.applyBulkListingPriceUpdates).mock.calls,
      pauses: vi.mocked(h.gateway.pauseListing).mock.calls,
      resumes: vi.mocked(h.gateway.publishListing).mock.calls,
    };
  }

  it.each([false, true])(
    "keeps price commands, pause/resume, reservations/refunds, counts and direction incumbent-only (shadow pause=%s)",
    async (pause) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      await seed(pause);
      const baseline = await live(harness());
      expect(baseline.budget).toEqual([{ changes_reserved: 1 }]);
      expect(baseline.pauses).toHaveLength(0);
      expect(baseline.resumes).toHaveLength(1);
      expect(baseline.state).toMatchObject({ same_direction_rounds: 1, last_direction: "down", frozen_until: null });
      expect(baseline.data).toMatchObject({
        listingsEvaluated: 3,
        listingsChanged: 1,
        listingsSkipped: 2,
        goalInputs: { curveVersion: 1, economicsResolved: 0, economicsUnavailable: 0 },
      });
      expect(baseline.prices[0]![0].updates).toHaveLength(2);
      await seed(pause);
      const solve = vi.fn<typeof fixedPercentileGoal.solve>(
        pause
          ? () => ({ kind: "unavailable", reason: "economics-unavailable" })
          : (input) => fixedPercentileGoal.solve({ ...input, parameters: { percentile: 90 } }),
      );
      registerShadowGoals([
        shadowGoal("fixed-percentile", { solve, requiresEconomics: pause }),
        shadowGoal("target-horizon"),
      ]);
      const h = harness();
      const result = await live(h);
      const { data, ...money } = result;
      const { data: baselineData, ...baselineMoney } = baseline;
      expect(money).toEqual(baselineMoney);
      expect({ ...data, listings: data.listings.map(({ shadow: _shadow, ...trace }) => trace) }).toEqual(baselineData);
      for (const trace of data.listings) {
        expect(trace.shadow?.map((entry) => entry.anchorIndex)).toEqual(pause ? [0] : [0, 1]);
        expect(trace.shadow?.[0]).toMatchObject({
          goalId: "fixed-percentile",
          goalVersion: 2,
          curveVersion: 1,
          skipped: null,
          action: pause ? "pause" : "update-price",
          targetPriceAmount: pause ? null : "30.00",
        });
        expect(trace.anchor?.goal?.goalVersion).toBe(1);
      }
      expect(solve).toHaveBeenCalledTimes(3);
      expect(h.resolve).not.toHaveBeenCalled();
      expect(h.queries.filter((sql) => sql.includes("pricing_demand_curve_versions"))).toHaveLength(1);
      expect(h.queries.filter((sql) => sql.includes("pricing_demand_curve_points"))).toHaveLength(1);
    },
  );

  it("preview is byte-identical with a shadow registered and performs zero shadow work", async () => {
    await seed(false);
    const h = harness();
    const baseline = JSON.stringify(await h.services.previewProductRound(product));
    const solve = vi.fn(shadowGoal().solve);
    registerShadowGoals([shadowGoal("fixed-percentile", { solve })]);
    const shadowPlan = vi.spyOn(planner, "planRepricingShadows");
    expect(JSON.stringify(await h.services.previewProductRound(product))).toBe(baseline);
    expect(solve).not.toHaveBeenCalled();
    expect(shadowPlan).not.toHaveBeenCalled();
  });

  it("without registered shadows, evaluations and v1 event payloads remain byte-identical", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await seed(false);
    const h = harness();
    const incumbent = JSON.stringify(await h.services.previewProductRound(product));
    const first = await live(h);
    await seed(false);
    const repeat = harness();
    expect(JSON.stringify(await repeat.services.previewProductRound(product))).toBe(incumbent);
    expect(JSON.stringify((await live(repeat)).data)).toBe(JSON.stringify(first.data));
    expect(first.data.listings.every((trace) => !Object.hasOwn(trace, "shadow"))).toBe(true);
  });
});
