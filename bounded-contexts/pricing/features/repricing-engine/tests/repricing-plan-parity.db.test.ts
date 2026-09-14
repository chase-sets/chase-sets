import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as pricingModule } from "../../../index";
import type { RepricingRuleDirective } from "../../repricing-policies/domain/domain";
import type { RepricingListingEvaluation } from "../domain/evaluate";
import type { RepricingPolicyListingTrace } from "../domain/fact";
import * as roundPlanner from "../domain/round";
import { createRepricingEngineRuntime, type RepricingMarketplaceGateway } from "../api/runtime";
import { dryRunBody, dryRunContext, seedDryRunListings } from "./dry-run-fixture";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const product = { catalogItemId: "cat_00000000", productId: "prod_00000000" };
type MatrixRow = {
  name: string;
  directive?: Partial<RepricingRuleDirective>;
  estimate?: string;
  stale?: boolean;
  asks?: boolean;
  target: string | null;
  skip?: RepricingPolicyListingTrace["skipReason"];
  anchor?: RepricingPolicyListingTrace["anchor"];
  flags?: string[];
  clamp?: "floor" | "ceiling" | "maxMove";
  exhausted?: RepricingPolicyListingTrace["exhaustedAnchors"];
  ruleIndex?: number;
  lastSold?: "native-undenominated" | "supplied-denominated-snapshot";
};
const market = (amount: string) => ({
  source: "market-estimate" as const,
  amount,
  stratum: "market-estimate" as const,
  contributingListingCount: 0,
});
const hard = (source: "lowest-competing-ask" | "comp-percentile" = "lowest-competing-ask") => ({
  source,
  amount: "16.00",
  stratum: "hard-ask" as const,
  contributingListingCount: 1,
});
// Independent expected amounts/reasons, not results constructed by either evaluator.
const matrix: MatrixRow[] = [
  { name: "terminal hold absent", directive: { terminal: { kind: "hold" } }, target: null, skip: "terminal-hold" },
  {
    name: "terminal pause",
    directive: { terminal: { kind: "pause", reason: "missing" } },
    target: null,
    skip: "terminal-pause",
  },
  {
    name: "terminal notify-only",
    directive: { terminal: { kind: "notify-only" } },
    target: null,
    skip: "terminal-notify-only",
  },
  { name: "terminal fallback", target: "15.00" },
  { name: "terminal price-at-floor", directive: { terminal: { kind: "price-at-floor" } }, target: "1.00" },
  { name: "within tolerance", estimate: "20.00", target: "20.00", skip: "within-tolerance", anchor: market("20.00") },
  {
    name: "floor clamp",
    estimate: "10.00",
    directive: { floor: { mode: "absolute", amount: "15.00" } },
    target: "15.00",
    anchor: market("10.00"),
    flags: ["floor-binding"],
    clamp: "floor",
  },
  {
    name: "ceiling clamp",
    estimate: "30.00",
    directive: { ceiling: { mode: "absolute", amount: "25.00" } },
    target: "25.00",
    anchor: market("30.00"),
    flags: ["ceiling-binding"],
    clamp: "ceiling",
  },
  {
    name: "max-move clamp",
    estimate: "10.00",
    directive: { maxMovePercent: 10 },
    target: "18.00",
    anchor: market("10.00"),
    flags: ["max-move-binding"],
    clamp: "maxMove",
  },
  {
    name: "stale estimate",
    estimate: "10.00",
    stale: true,
    directive: { terminal: { kind: "hold" } },
    target: null,
    skip: "terminal-hold",
    exhausted: [{ source: "market-estimate", state: "stale" }],
  },
  {
    name: "implicit hard stratum",
    asks: true,
    directive: { anchorChain: [{ source: "lowest-competing-ask" }] },
    target: "16.00",
    anchor: hard(),
  },
  {
    name: "explicit hard stratum",
    asks: true,
    directive: { anchorChain: [{ source: "lowest-competing-ask", strata: "hard" }] },
    target: "16.00",
    anchor: hard(),
  },
  {
    name: "percentile hard stratum",
    asks: true,
    directive: { anchorChain: [{ source: "comp-percentile", percentile: 50 }] },
    target: "16.00",
    anchor: hard("comp-percentile"),
  },
  {
    name: "any stratum band",
    asks: true,
    estimate: "20.00",
    directive: {
      anchorChain: [
        { source: "lowest-competing-ask", strata: "any", band: { ground: "market-estimate", minPercentOfGround: 90 } },
      ],
    },
    target: "18.00",
    anchor: { source: "lowest-competing-ask", amount: "18.00", stratum: "any-ask", contributingListingCount: 2 },
    flags: ["band-binding"],
  },
  {
    name: "last sold absent",
    directive: { anchorChain: [{ source: "last-sold" }] },
    target: "15.00",
    exhausted: [{ source: "last-sold", state: "absent" }],
  },
  {
    name: "native last-sold remains undenominated",
    lastSold: "native-undenominated",
    directive: { anchorChain: [{ source: "last-sold" }] },
    target: null,
    skip: "currency-input-incomplete-or-mismatched",
    exhausted: [{ source: "last-sold", state: "currency-incomplete" }],
  },
  {
    name: "last-sold stratum with an explicitly supplied denominated snapshot",
    lastSold: "supplied-denominated-snapshot",
    directive: { anchorChain: [{ source: "last-sold" }] },
    target: "14.00",
    anchor: { source: "last-sold", amount: "14.00", stratum: "last-sold", contributingListingCount: 0 },
  },
  { name: "ordered default rule", estimate: "12.00", target: "12.00", anchor: market("12.00"), ruleIndex: 1 },
];

function normalized(trace: RepricingListingEvaluation | RepricingPolicyListingTrace) {
  const { targetPriceAmount, ruleIndex, anchor, exhaustedAnchors, clamps, flags, skipReason } = trace;
  return { targetPriceAmount, ruleIndex, anchor, exhaustedAnchors, clamps, flags, skipReason };
}

describeDb("independent repricing plan parity through preview/live/dry-run", () => {
  let pools: Readonly<Record<"pricing", PgTransactionalPool>>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["pricing"], "repricing_plan_parity_7910");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.pricing.query(pricingModule.schemaSql);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  it.each(matrix)("$name", async (row) => {
    const pool = pools.pricing;
    await seedDryRunListings(pool, 1, 1);
    const rule = { conditions: [], directive: { ...dryRunBody.rules[0]!.directive, ...row.directive } };
    const body = {
      ...dryRunBody,
      rules: row.ruleIndex
        ? [{ conditions: [{ type: "quantity-at-least" as const, quantity: 2 }], directive: rule.directive }, rule]
        : [rule],
    };
    await pool.query(
      `INSERT INTO pricing_repricing_policies
       (policy_id, seller_account_id, name, status, scope_kind, rules, max_changes_per_day, created_at, updated_at)
       VALUES ('rpp_7910', 'acc_7910', 'Parity', 'active', 'all-listings', $1::jsonb, 100, now(), now())`,
      [JSON.stringify(body.rules)],
    );
    if (row.estimate)
      await pool.query(
        `INSERT INTO pricing_market_price_estimates
       (catalog_catalog_item_id, product_id, estimate_version, window_started_at, window_ended_at, amount,
        currency_code, band_low_amount, band_high_amount, confidence, platform_verified_trade_count,
        platform_trade_count, external_comp_count, estimated_at, fresh_until, disclosure, updated_at)
       VALUES ($1, $2, 1, now(), now(), $3, 'USD', $3, $3, 'medium', 3, 3, 0, now(), $4, 'account', now())`,
        [product.catalogItemId, product.productId, row.estimate, row.stale ? "2000-01-01" : "2100-01-01"],
      );
    if (row.asks) {
      await pool.query(
        `INSERT INTO pricing_market_listing_inputs
         (listing_id, seller_account_id, catalog_catalog_item_id, product_id, price_amount,
          price_currency_code, quantity_cap, status, updated_at, last_stream_version)
         VALUES ('lst_competitor_hard', 'acc_hard', $1, $2, 16, 'USD', 1, 'active', now(), 1),
                ('lst_competitor_derived', 'acc_derived', $1, $2, 12, 'USD', 1, 'active', now(), 1)`,
        [product.catalogItemId, product.productId],
      );
      await pool.query(
        `INSERT INTO pricing_repricing_policies
         (policy_id, seller_account_id, name, status, scope_kind, rules, max_changes_per_day, created_at, updated_at)
         VALUES ('rpp_competitor', 'acc_derived', 'Other', 'active', 'all-listings', $1::jsonb, 100, now(), now())`,
        [JSON.stringify(dryRunBody.rules)],
      );
    }
    const eventStore = createPostgresEventStore({ pool });
    const append = vi.spyOn(eventStore, "appendToStream");
    if (row.lastSold)
      await pool.query(
        `INSERT INTO pricing_market_trades
       (order_id, line_id, seller_account_id, buyer_account_id, catalog_catalog_item_id, product_id,
        unit_price_amount, quantity, sale_channel, sold_at, updated_at)
       VALUES ('ord_7910', 'line_1', 'acc_sale', 'acc_buyer', $1, $2, 14, 1, 'listing', now(), now())`,
        [product.catalogItemId, product.productId],
      );
    const db: PgTransactionalPool = {
      connect: pool.connect.bind(pool),
      query: async <Row>(sql: string, values?: readonly unknown[]) => {
        const result = await pool.query<Row>(sql, values);
        if (row.lastSold !== "supplied-denominated-snapshot" || !sql.includes("NULL::text AS currency_code"))
          return result;
        return {
          ...result,
          rows: result.rows.map((item) =>
            item !== null && typeof item === "object" && "currency_code" in item
              ? { ...item, currency_code: "USD" }
              : item,
          ),
        };
      },
    };
    const services = createRepricingEngineRuntime({ db, eventStore });
    const spy = vi.spyOn(roundPlanner, "planRepricingRound");
    const preview = (await services.previewProductRound(product)).find(
      (item) => item.listingId === "lst_7910_00000001",
    )!;
    const run = await services.enqueueDryRun(
      {
        sellerAccountId: "acc_7910",
        body,
        replacingPolicyId: "rpp_7910",
      },
      dryRunContext,
    );
    const gateway: RepricingMarketplaceGateway = {
      applyBulkListingPriceUpdates: vi.fn<RepricingMarketplaceGateway["applyBulkListingPriceUpdates"]>(
        async ({ updates }) => ({
          items: updates.map((item) => ({
            listingId: item.listingId,
            outcome: row.skip === "within-tolerance" ? "no_op" : "applied",
          })),
        }),
      ),
      pauseListing: vi.fn(async () => undefined),
      publishListing: vi.fn(async () => undefined),
    };
    const gatewayForAccount = vi.fn(() => gateway);
    const dryInput = {
      claimOwnerId: "parity-dry",
      claimTtlMs: 30_000,
      marketplaceGatewayForAccount: gatewayForAccount,
    };
    await services.processNextDryRunJob(dryInput);
    expect(await eventStore.readAll()).toEqual([]);
    expect(append).not.toHaveBeenCalled();
    expect(gatewayForAccount).not.toHaveBeenCalled();
    expect(gateway.applyBulkListingPriceUpdates).not.toHaveBeenCalled();
    expect(gateway.pauseListing).not.toHaveBeenCalled();
    expect(gateway.publishListing).not.toHaveBeenCalled();
    const dry = (await services.listDryRunTraces("acc_7910", run!.dryRunId))[0]!;
    await services.enqueueMarketPriceSignal({
      ...product,
      amount: "25.00",
      previousAmount: "20.00",
      context: dryRunContext,
      trigger: {
        kind: "market-price-estimated",
        eventId: "parity",
        signalVersion: "1",
        occurredAt: new Date().toISOString(),
      },
    });
    const beforeLive = spy.mock.results.length;
    await services.processNextEvaluationJob({
      claimOwnerId: "parity-live",
      claimTtlMs: 30_000,
      marketplaceGatewayForAccount: () => gateway,
    });
    const livePlan: ReturnType<typeof roundPlanner.planRepricingRound> = spy.mock.results[beforeLive]!.value;
    const live = livePlan.find((item) => item.listingId === preview.listingId)!;
    const expected = {
      targetPriceAmount: row.target,
      ruleIndex: row.ruleIndex ?? 0,
      anchor: row.anchor ?? null,
      exhaustedAnchors: row.exhausted ?? (row.anchor ? [] : [{ source: "market-estimate", state: "absent" }]),
      clamps: { floor: row.clamp === "floor", ceiling: row.clamp === "ceiling", maxMove: row.clamp === "maxMove" },
      flags: row.flags ?? [],
      skipReason: row.skip ?? null,
    };
    expect(normalized(preview)).toEqual(expected);
    expect(normalized(live)).toEqual(expected);
    expect(normalized(dry)).toEqual(expected);
    const expectedOutcome =
      row.skip === "terminal-pause"
        ? "pause-requested"
        : row.skip === "terminal-notify-only"
          ? "notify-only"
          : row.skip
            ? "skipped"
            : "changed";
    const bucket =
      row.target === null
        ? 0
        : [-20, -10, -5, -1, 1, 5, 10, 20].filter((edge) => (Number(row.target) - 20) * 5 >= edge).length;
    expect((await services.getDryRun("acc_7910", run!.dryRunId))?.summary).toEqual({
      listingsEvaluated: 1,
      outcomes: { [expectedOutcome]: 1 },
      skipReasons: row.skip ? { [row.skip]: 1 } : {},
      flags: Object.fromEntries((row.flags ?? []).map((flag) => [flag, 1])),
      withinTolerance: row.skip === "within-tolerance" ? 1 : 0,
      deltaBuckets: expectedOutcome === "changed" ? { [bucket]: 1 } : {},
    });
    const facts = (await eventStore.readAll()).filter(
      (event) => event.eventType === "pricing.repricing-policy.evaluated",
    );
    expect(facts.length).toBeGreaterThan(0);
    const data = facts.find((event) => event.payload.policyId === "rpp_7910");
    expect(data).toBeDefined();
    if (row.skip === "within-tolerance") {
      expect(data?.payload.listings).toEqual([expect.objectContaining({ skipReason: "domain-no-op" })]);
    }
    expect(JSON.stringify(dry)).not.toMatch(/lst_competitor|pricingMode/);
  });
});
