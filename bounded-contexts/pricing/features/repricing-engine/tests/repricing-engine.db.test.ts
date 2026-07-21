import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as pricingModule } from "../../../index";
import { buildPricingMarketplaceInputProjectionHandlers } from "../../recommendations/integrations/source/source-projection";
import { buildRepricingPolicyProjectionHandlers } from "../../repricing-policies/read-model/projection";
import type { RepricingRule } from "../../repricing-policies/domain/domain";
import { createRepricingEngineRuntime, type RepricingMarketplaceGateway } from "../api/runtime";
import { buildRepricingEvaluationProjectionHandlers } from "../read-model/projection";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["pricing"] as const;

function event(type: string, data: Record<string, unknown>, streamId: string, streamVersion: number) {
  return {
    type,
    streamId,
    streamVersion,
    data,
    timing: { recordedAt: "2026-07-17T12:00:00.000Z" },
  } as never;
}

const context = {
  tenantId: "ten_1" as never,
  audit: { performedByUserId: "usr_system" as never, forAccountId: "acc_seller" as never },
};

const defaultRule: RepricingRule = {
  conditions: [],
  directive: {
    anchorChain: [{ source: "lowest-competing-ask" }, { source: "market-estimate" }],
    offset: { mode: "absolute", amount: "-0.01" },
    floor: { mode: "absolute", amount: "5.00" },
    ceiling: null,
    tolerance: { mode: "absolute", amount: "0.25" },
    rounding: { mode: "none" },
    maxMovePercent: null,
    terminal: { kind: "hold" },
  },
};

describeDb("pricing signal-reactive repricing engine (#4331)", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, contextNames, "pricing_repricing_engine");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.pricing.query(pricingModule.schemaSql);
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  async function seedRound(
    pool: PgTransactionalPool,
    input: Readonly<{
      listingPrices: readonly string[];
      maxChangesPerDay?: number;
      policyId?: string;
    }>,
  ) {
    const listingHandlers = buildPricingMarketplaceInputProjectionHandlers(pool);
    const policyId = input.policyId ?? "rpp_1";
    const listingIds = input.listingPrices.map((_, index) => `lst_policy_${index + 1}`);
    for (const [index, priceAmount] of input.listingPrices.entries()) {
      const listingId = listingIds[index]!;
      await listingHandlers["marketplace.listing.created"]!(
        event(
          "marketplace.listing.created",
          {
            listingId,
            accountId: "acc_seller",
            catalogItemId: "cat_1",
            productId: "cat_1::",
            priceAmount,
            quantityCap: 1,
          },
          `marketplace.listing-${listingId}`,
          1,
        ),
      );
      await listingHandlers["marketplace.listing.published"]!(
        event("marketplace.listing.published", {}, `marketplace.listing-${listingId}`, 2),
      );
    }
    await listingHandlers["marketplace.listing.created"]!(
      event(
        "marketplace.listing.created",
        {
          listingId: "lst_competitor",
          accountId: "acc_competitor",
          catalogItemId: "cat_1",
          productId: "cat_1::",
          priceAmount: "12.00",
          quantityCap: 1,
        },
        "marketplace.listing-lst_competitor",
        1,
      ),
    );
    await listingHandlers["marketplace.listing.published"]!(
      event("marketplace.listing.published", {}, "marketplace.listing-lst_competitor", 2),
    );

    const policyHandlers = buildRepricingPolicyProjectionHandlers(pool);
    await policyHandlers["pricing.repricing-policy.created"]!(
      event(
        "pricing.repricing-policy.created",
        {
          policyId,
          accountId: "acc_seller",
          name: "Reactive",
          scope: { kind: "listing-set", listingIds },
          excludedListingIds: [],
          rules: [defaultRule],
          maxChangesPerDay: input.maxChangesPerDay ?? 100,
          createdAt: "2026-07-17T11:00:00.000Z",
        },
        `pricing.repricing-policy-${policyId}`,
        1,
      ),
    );
    await pool.query(
      `INSERT INTO pricing_market_price_estimates (
         catalog_catalog_item_id, product_id, estimate_version,
         window_started_at, window_ended_at, amount, currency_code,
         band_low_amount, band_high_amount, confidence,
         platform_verified_trade_count, platform_trade_count, external_comp_count,
         previous_amount, estimated_at, fresh_until, disclosure, updated_at
       ) VALUES (
         'cat_1', 'cat_1::', 2,
         '2026-07-01T00:00:00.000Z', '2026-07-17T12:00:00.000Z', '11.00', 'usd',
         '10.00', '12.00', 'medium', 3, 5, 0,
         '10.00', '2026-07-17T12:00:00.000Z', '2026-07-18T12:00:00.000Z', 'account',
         '2026-07-17T12:00:00.000Z'
       )`,
    );
    return { listingIds, policyId };
  }

  function gateway(outcomeForListing: (listingId: string) => "applied" | "no_op" | "conflict" | "error") {
    const calls: Array<readonly { listingId: string; priceAmount: string; expectedVersion: number }[]> = [];
    const pauseCalls: string[] = [];
    const publishCalls: string[] = [];
    const value: RepricingMarketplaceGateway & {
      calls: typeof calls;
      pauseCalls: typeof pauseCalls;
      publishCalls: typeof publishCalls;
    } = {
      calls,
      pauseCalls,
      publishCalls,
      applyBulkListingPriceUpdates: async (body) => {
        calls.push(body.updates);
        return {
          items: body.updates.map((update) => ({
            listingId: update.listingId,
            outcome: outcomeForListing(update.listingId),
          })),
        };
      },
      pauseListing: async (listingId) => {
        pauseCalls.push(listingId);
      },
      publishListing: async (listingId) => {
        publishCalls.push(listingId);
      },
    };
    return value;
  }

  async function evaluationFacts(pool: PgTransactionalPool) {
    const eventStore = createPostgresEventStore({ pool });
    const events = await eventStore.readAll();
    return events.filter((stored) => stored.eventType === "pricing.repricing-policy.evaluated");
  }

  it("deduplicates a moved estimate reaction, changes only beyond-tolerance listings, and publishes a complete fact", async () => {
    const pool = pools.pricing;
    await seedRound(pool, { listingPrices: ["10.00", "11.90"] });
    const runtime = createRepricingEngineRuntime({ eventStore: createPostgresEventStore({ pool }), db: pool });
    const trigger = {
      kind: "market-price-estimated" as const,
      eventId: "evt_estimate_2",
      signalVersion: "2",
      occurredAt: new Date(Date.now() - 500).toISOString(),
    };
    await expect(
      runtime.enqueueMarketPriceSignal({
        catalogItemId: "cat_1",
        productId: "cat_1::",
        amount: "11.00",
        previousAmount: "10.00",
        trigger,
        context,
      }),
    ).resolves.toBe(true);
    await expect(
      runtime.enqueueMarketPriceSignal({
        catalogItemId: "cat_1",
        productId: "cat_1::",
        amount: "11.00",
        previousAmount: "10.00",
        trigger,
        context,
      }),
    ).resolves.toBe(false);
    const marketplace = gateway((listingId) => (listingId === "lst_policy_1" ? "applied" : "no_op"));
    await expect(
      runtime.processNextEvaluationJob({
        claimOwnerId: "worker:1",
        claimTtlMs: 30_000,
        marketplaceGatewayForAccount: () => marketplace,
      }),
    ).resolves.toBe(1);

    expect(marketplace.calls[0]).toEqual([
      expect.objectContaining({ listingId: "lst_policy_1", priceAmount: "11.99", expectedVersion: 2 }),
      expect.objectContaining({ listingId: "lst_policy_2", priceAmount: "11.99", expectedVersion: 2 }),
    ]);
    const facts = await evaluationFacts(pool);
    expect(facts).toHaveLength(1);
    const payload = facts[0]!.payload as {
      listingsEvaluated: number;
      listingsChanged: number;
      listingsSkipped: number;
      listings: readonly { listingId: string; outcome: string; skipReason: string | null }[];
      signalToEvaluationLatencyMs: number;
    };
    expect(payload).toMatchObject({ listingsEvaluated: 2, listingsChanged: 1, listingsSkipped: 1 });
    expect(payload.listings).toEqual([
      expect.objectContaining({ listingId: "lst_policy_1", outcome: "changed", skipReason: null }),
      expect.objectContaining({ listingId: "lst_policy_2", outcome: "skipped", skipReason: "domain-no-op" }),
    ]);
    expect(payload.signalToEvaluationLatencyMs).toBeGreaterThanOrEqual(0);

    const projection = buildRepricingEvaluationProjectionHandlers(pool);
    await projection["pricing.repricing-policy.evaluated"]!({
      type: facts[0]!.eventType,
      data: facts[0]!.payload,
    } as never);
    const page = await pool.query<{ listings_changed: number; listings_skipped: number }>(
      `SELECT listings_changed, listings_skipped FROM pricing_repricing_policy_evaluations`,
    );
    expect(page.rows).toEqual([{ listings_changed: 1, listings_skipped: 1 }]);
  });

  it("enforces the policy's daily budget and records a manual-edit conflict without consuming budget", async () => {
    const pool = pools.pricing;
    await seedRound(pool, { listingPrices: ["8.00", "9.00"], maxChangesPerDay: 1 });
    const runtime = createRepricingEngineRuntime({ eventStore: createPostgresEventStore({ pool }), db: pool });
    await runtime.enqueueMarketPriceSignal({
      catalogItemId: "cat_1",
      productId: "cat_1::",
      amount: "11.00",
      previousAmount: "10.00",
      trigger: {
        kind: "market-price-estimated",
        eventId: "evt_budget",
        signalVersion: "3",
        occurredAt: new Date().toISOString(),
      },
      context,
    });
    const marketplace = gateway(() => "conflict");
    await runtime.processNextEvaluationJob({
      claimOwnerId: "worker:budget",
      claimTtlMs: 30_000,
      marketplaceGatewayForAccount: () => marketplace,
    });

    const facts = await evaluationFacts(pool);
    const payload = facts[0]!.payload as {
      listingsChanged: number;
      listings: readonly { listingId: string; skipReason: string | null }[];
    };
    expect(payload.listingsChanged).toBe(0);
    expect(payload.listings).toEqual([
      expect.objectContaining({ listingId: "lst_policy_1", skipReason: "manual-edit-conflict" }),
      expect.objectContaining({ listingId: "lst_policy_2", skipReason: "budget-exhausted" }),
    ]);
    const budget = await pool.query<{ changes_reserved: number }>(
      `SELECT changes_reserved FROM pricing_repricing_daily_change_budgets WHERE seller_account_id = 'acc_seller'`,
    );
    expect(budget.rows[0]?.changes_reserved).toBe(0);
  });

  it("does not react to an unchanged daily estimate and enqueues each quiet product only once per drift-sweep day", async () => {
    const pool = pools.pricing;
    await seedRound(pool, { listingPrices: ["8.00"] });
    const runtime = createRepricingEngineRuntime({ eventStore: createPostgresEventStore({ pool }), db: pool });
    await expect(
      runtime.enqueueMarketPriceSignal({
        catalogItemId: "cat_1",
        productId: "cat_1::",
        amount: "11.00",
        previousAmount: "11.00",
        trigger: {
          kind: "market-price-estimated",
          eventId: "evt_unchanged",
          signalVersion: "4",
          occurredAt: "2026-07-17T12:00:00.000Z",
        },
        context,
      }),
    ).resolves.toBe(false);
    await expect(runtime.enqueueDailyDriftSweep({ now: "2026-07-17T13:00:00.000Z" })).resolves.toBe(1);
    await expect(runtime.enqueueDailyDriftSweep({ now: "2026-07-17T14:00:00.000Z" })).resolves.toBe(0);
  });

  it("damps competing-ask cascades with a per-product cooldown", async () => {
    const pool = pools.pricing;
    await seedRound(pool, { listingPrices: ["100.00"] });
    const runtime = createRepricingEngineRuntime({ eventStore: createPostgresEventStore({ pool }), db: pool });
    const signal = (eventId: string) => ({
      listingId: "lst_competitor",
      trigger: {
        kind: "competing-ask-changed" as const,
        eventId,
        signalVersion: eventId,
        occurredAt: "2026-07-17T12:00:00.000Z",
      },
      context,
    });

    await expect(runtime.enqueueCompetingAskSignal(signal("evt_90"))).resolves.toBe(true);
    await expect(runtime.enqueueCompetingAskSignal(signal("evt_81"))).resolves.toBe(false);
    await expect(runtime.enqueueCompetingAskSignal(signal("evt_72_90"))).resolves.toBe(false);
  });

  it("threads projected grading and listing age into first-match rule selection", async () => {
    const pool = pools.pricing;
    const seeded = await seedRound(pool, { listingPrices: ["10.00"] });
    const conditionalRules: readonly RepricingRule[] = [
      {
        conditions: [
          { type: "item-grading", grading: "graded" },
          { type: "listing-age-at-least", days: 10 },
        ],
        directive: { ...defaultRule.directive, offset: { mode: "absolute", amount: "-1.00" } },
      },
      defaultRule,
    ];
    await pool.query(
      `UPDATE pricing_market_listing_inputs
       SET grading = 'graded', created_at = '2026-07-01T00:00:00.000Z'
       WHERE listing_id = $1`,
      [seeded.listingIds[0]],
    );
    await pool.query(`UPDATE pricing_repricing_policies SET rules = $2::jsonb WHERE policy_id = $1`, [
      seeded.policyId,
      JSON.stringify(conditionalRules),
    ]);

    const runtime = createRepricingEngineRuntime({ eventStore: createPostgresEventStore({ pool }), db: pool });
    const [evaluation] = await runtime.previewProductRound({
      catalogItemId: "cat_1",
      productId: "cat_1::",
      now: "2026-07-17T12:00:00.000Z",
    });
    expect(evaluation).toMatchObject({ ruleIndex: 0, targetPriceAmount: "11.00" });
  });

  it("drains every daily-sweep page in one invocation", async () => {
    const pool = pools.pricing;
    const seeded = await seedRound(pool, { listingPrices: ["8.00"] });
    await pool.query(
      `UPDATE pricing_repricing_policies SET scope_kind = 'all-listings', scope_listing_ids = NULL WHERE policy_id = $1`,
      [seeded.policyId],
    );
    await pool.query(
      `INSERT INTO pricing_market_listing_inputs (
         listing_id, seller_account_id, inventory_item_id, catalog_catalog_item_id, product_id,
         price_amount, quantity_cap, status, grading, created_at, updated_at, last_stream_version
       )
       SELECT 'lst_page_2', seller_account_id, inventory_item_id, catalog_catalog_item_id, 'cat_1::page-2',
              price_amount, quantity_cap, status, grading, created_at, updated_at, last_stream_version
       FROM pricing_market_listing_inputs WHERE listing_id = $1
       UNION ALL
       SELECT 'lst_page_3', seller_account_id, inventory_item_id, catalog_catalog_item_id, 'cat_1::page-3',
              price_amount, quantity_cap, status, grading, created_at, updated_at, last_stream_version
       FROM pricing_market_listing_inputs WHERE listing_id = $1`,
      [seeded.listingIds[0]],
    );
    const runtime = createRepricingEngineRuntime({ eventStore: createPostgresEventStore({ pool }), db: pool });

    await expect(runtime.enqueueDailyDriftSweep({ now: "2026-07-17T13:00:00.000Z", limit: 1 })).resolves.toBe(3);
    const cursor = await pool.query<{ completed: boolean }>(
      `SELECT completed FROM pricing_repricing_daily_sweep_cursor WHERE sweep_name = 'assigned-products'`,
    );
    expect(cursor.rows[0]?.completed).toBe(true);
  });

  it("shares one seller daily budget across multiple policies", async () => {
    const pool = pools.pricing;
    await seedRound(pool, { listingPrices: ["8.00"], maxChangesPerDay: 1 });
    const listingHandlers = buildPricingMarketplaceInputProjectionHandlers(pool);
    await listingHandlers["marketplace.listing.created"]!(
      event(
        "marketplace.listing.created",
        {
          listingId: "lst_policy_two",
          accountId: "acc_seller",
          catalogItemId: "cat_1",
          productId: "cat_1::",
          priceAmount: "8.00",
          quantityCap: 1,
        },
        "marketplace.listing-lst_policy_two",
        1,
      ),
    );
    await listingHandlers["marketplace.listing.published"]!(
      event("marketplace.listing.published", {}, "marketplace.listing-lst_policy_two", 2),
    );
    const policyHandlers = buildRepricingPolicyProjectionHandlers(pool);
    await policyHandlers["pricing.repricing-policy.created"]!(
      event(
        "pricing.repricing-policy.created",
        {
          policyId: "rpp_2",
          accountId: "acc_seller",
          name: "Second",
          scope: { kind: "listing-set", listingIds: ["lst_policy_two"] },
          excludedListingIds: [],
          rules: [defaultRule],
          maxChangesPerDay: 1,
          createdAt: "2026-07-17T11:30:00.000Z",
        },
        "pricing.repricing-policy-rpp_2",
        1,
      ),
    );
    const runtime = createRepricingEngineRuntime({ eventStore: createPostgresEventStore({ pool }), db: pool });
    await runtime.enqueueMarketPriceSignal({
      catalogItemId: "cat_1",
      productId: "cat_1::",
      amount: "11.00",
      previousAmount: "10.00",
      trigger: {
        kind: "market-price-estimated",
        eventId: "evt_shared_budget",
        signalVersion: "5",
        occurredAt: "2026-07-17T12:00:00.000Z",
      },
      context,
    });
    const marketplace = gateway(() => "applied");
    await runtime.processNextEvaluationJob({
      claimOwnerId: "worker:shared-budget",
      claimTtlMs: 30_000,
      marketplaceGatewayForAccount: () => marketplace,
    });

    expect(marketplace.calls.flat()).toHaveLength(1);
    const budget = await pool.query<{ changes_reserved: number }>(
      `SELECT changes_reserved FROM pricing_repricing_daily_change_budgets WHERE seller_account_id = 'acc_seller'`,
    );
    expect(budget.rows[0]?.changes_reserved).toBe(1);
  });

  it("pauses on missing policy input and resumes only after the input stays available through hysteresis", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-17T12:00:00.000Z"));
      const pool = pools.pricing;
      const seeded = await seedRound(pool, { listingPrices: ["10.00"] });
      const pauseRule: RepricingRule = {
        conditions: [],
        directive: {
          ...defaultRule.directive,
          anchorChain: [{ source: "market-estimate" }],
          terminal: { kind: "pause", reason: "Required pricing input is unavailable." },
        },
      };
      await pool.query(`UPDATE pricing_repricing_policies SET rules = $2::jsonb WHERE policy_id = $1`, [
        seeded.policyId,
        JSON.stringify([pauseRule]),
      ]);
      await pool.query(
        `UPDATE pricing_market_price_estimates SET fresh_until = '2026-07-17T11:00:00.000Z' WHERE product_id = 'cat_1::'`,
      );
      const runtime = createRepricingEngineRuntime({ eventStore: createPostgresEventStore({ pool }), db: pool });
      const marketplace = gateway(() => "applied");
      const enqueue = (eventId: string) =>
        runtime.enqueueMarketPriceSignal({
          catalogItemId: "cat_1",
          productId: "cat_1::",
          amount: "11.00",
          previousAmount: "10.00",
          trigger: {
            kind: "market-price-estimated",
            eventId,
            signalVersion: eventId,
            occurredAt: new Date().toISOString(),
          },
          context,
        });

      await enqueue("evt_pause_missing");
      await runtime.processNextEvaluationJob({
        claimOwnerId: "worker:pause",
        claimTtlMs: 30_000,
        marketplaceGatewayForAccount: () => marketplace,
      });
      expect(marketplace.pauseCalls).toEqual([seeded.listingIds[0]]);

      const listingHandlers = buildPricingMarketplaceInputProjectionHandlers(pool);
      await listingHandlers["marketplace.listing.paused"]!(
        event(
          "marketplace.listing.paused",
          { reason: "policy-input-missing" },
          `marketplace.listing-${seeded.listingIds[0]}`,
          3,
        ),
      );
      await pool.query(
        `UPDATE pricing_market_price_estimates SET fresh_until = '2026-07-20T00:00:00.000Z' WHERE product_id = 'cat_1::'`,
      );
      vi.setSystemTime(new Date("2026-07-17T12:01:00.000Z"));
      await enqueue("evt_input_returned");
      await runtime.processNextEvaluationJob({
        claimOwnerId: "worker:wait",
        claimTtlMs: 30_000,
        marketplaceGatewayForAccount: () => marketplace,
      });
      expect(marketplace.publishCalls).toHaveLength(0);

      vi.setSystemTime(new Date("2026-07-18T00:02:00.000Z"));
      await enqueue("evt_input_stable");
      await runtime.processNextEvaluationJob({
        claimOwnerId: "worker:resume",
        claimTtlMs: 30_000,
        marketplaceGatewayForAccount: () => marketplace,
      });
      expect(marketplace.publishCalls).toEqual([seeded.listingIds[0]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors a policy pause/revision precondition before Marketplace mutation", async () => {
    const pool = pools.pricing;
    const seeded = await seedRound(pool, { listingPrices: ["8.00"] });
    const runtime = createRepricingEngineRuntime({ eventStore: createPostgresEventStore({ pool }), db: pool });
    await runtime.enqueueMarketPriceSignal({
      catalogItemId: "cat_1",
      productId: "cat_1::",
      amount: "11.00",
      previousAmount: "10.00",
      trigger: {
        kind: "market-price-estimated",
        eventId: "evt_policy_precondition",
        signalVersion: "6",
        occurredAt: "2026-07-17T12:00:00.000Z",
      },
      context,
    });
    const policyHandlers = buildRepricingPolicyProjectionHandlers(pool);
    await policyHandlers["pricing.repricing-policy.paused"]!(
      event(
        "pricing.repricing-policy.paused",
        { pausedAt: "2026-07-17T12:00:01.000Z" },
        `pricing.repricing-policy-${seeded.policyId}`,
        2,
      ),
    );
    const marketplace = gateway(() => "applied");
    await runtime.processNextEvaluationJob({
      claimOwnerId: "worker:precondition",
      claimTtlMs: 30_000,
      marketplaceGatewayForAccount: () => marketplace,
    });
    expect(marketplace.calls).toHaveLength(0);
  });
});
