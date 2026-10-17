import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { normalizeMoneyAmount, normalizeSignedMoneyAmount } from "@chase-sets/primitives/money";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PricingApiEnv } from "../../../api";
import { module as pricingModule } from "../../../index";
import type { EconomicsFact, EconomicsFacts, ResolveEconomicsRequest } from "../../economics/domain/contracts";
import type { EconomicsResolution } from "../../economics/domain/resolution";
import { DEMAND_CURVE_LAUNCH_POLICY_VALUE } from "../../market-estimates/domain/demand-curve-policy";
import { REPRICING_ENGINE_LAUNCH_POLICY_VALUE } from "../domain/policy";
import { createRepricingDryRunServices, type RepricingDryRun } from "../api/dry-run";
import { createRepricingDryRunRoutes } from "../api/dry-run-route";
import { dryRunBody, dryRunContext, seedDryRunListings } from "./dry-run-fixture";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const capturedAt = "2026-10-16T00:00:00.000Z";
const revision = "pol_synthetic_health:2026-10-01T00:00:00.000Z";
const claim = { claimOwnerId: "synthetic-health-worker", claimTtlMs: 300_000 };
const listingId = (n: number) => `lst_7910_${String(n).padStart(8, "0")}`;

function fact<T>(value: T): EconomicsFact<T> {
  return {
    sourceValue: value,
    effectiveValue: value,
    source: { kind: "policy-owned", policyRevision: "synthetic-economics" },
    override: null,
    observedAt: capturedAt,
  };
}

function economics(request: ResolveEconomicsRequest, unavailable = false): EconomicsResolution {
  const money = { amount: normalizeMoneyAmount("0.00"), currency: request.marketUnitPrice.currency };
  const facts: EconomicsFacts = {
    platformFeeRelativeBps: fact(0),
    platformFeeFixedPerUnitAmount: fact(money),
    platformFeeCapPerUnitAmount: fact(null),
    sellerHandlingRelativeBps: fact(0),
    sellerHandlingFixedPerUnitAmount: fact(money),
    sellerHandlingCapPerUnitAmount: fact(null),
    shippingAllowanceBps: fact(0),
    costBasisShareOfMarketBps: fact(5_000),
    costBasisCoverageBps: fact(10_000),
    costBasisDiscountPerUnitAmount: fact({ ...money, amount: normalizeSignedMoneyAmount("0.00") }),
    turnaroundDays: fact(2),
    dailyReturnHurdle: fact(0.01),
  };
  const diagnostics = {
    observedHoldDays: null,
    capitalCycleDays: null,
    hurdleStatus: "defaulted" as const,
    hurdleReason: null,
    inventoryWatermark: "synthetic",
    pricingWatermark: "synthetic",
    generatedAt: capturedAt,
    inventoryObservedAt: capturedAt,
    pricingObservedAt: capturedAt,
    generatedAgeSeconds: 0,
    inventorySourceAgeSeconds: 0,
    pricingSourceAgeSeconds: 0,
  };
  const common = {
    accountId: request.accountId,
    channel: request.scope,
    currency: request.marketUnitPrice.currency,
    effectiveAt: request.effectiveAt,
    revision: "synthetic-health-economics",
    facts,
    diagnostics,
  };
  if (unavailable || request.inventoryItemId.endsWith("00000001"))
    return { ...common, kind: "unavailable", reason: "provider-unavailable" };
  if (request.inventoryItemId.endsWith("00000002"))
    return { ...common, kind: "unavailable", reason: "terms-unavailable" };
  return { kind: "resolved", economics: common };
}

describeDb("durable Pricing Health Summary real-worker contract", () => {
  let pools: Readonly<Record<"pricing", PgTransactionalPool>>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["pricing"], "pricing_health_9769");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.pricing.query(pricingModule.schemaSql);
  });
  afterAll(async () => closeMultiContextTestPools(pools));

  function services(db = pools.pricing, unavailable = false) {
    const resolve = vi.fn(async (request: ResolveEconomicsRequest) => economics(request, unavailable));
    return {
      ...createRepricingDryRunServices(db, async () => REPRICING_ENGINE_LAUNCH_POLICY_VALUE, { resolve }),
      resolve,
    };
  }

  function api(worker: ReturnType<typeof services>) {
    const app = new Hono<PricingApiEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", {
        sessionId: "ses_health",
        tenantId: "tnt_identity",
        userId: "usr_7910",
        accountId: "acc_7910",
        membershipId: "mbr_health",
        roleKey: "owner",
        permissions: ["pricing.view"],
      });
      return next();
    });
    app.route("/dry-runs", createRepricingDryRunRoutes(worker));
    return app;
  }

  async function seed() {
    await seedDryRunListings(pools.pricing, 504, 504);
    await pools.pricing.query(`UPDATE pricing_market_listing_inputs SET inventory_item_id = listing_id,
      price_currency_code = CASE WHEN listing_id = '${listingId(496)}' THEN 'EUR'
        WHEN listing_id = '${listingId(504)}' THEN NULL ELSE 'USD' END,
      quantity_cap = CASE WHEN listing_id IN ('${listingId(496)}', '${listingId(497)}') THEN 2
        WHEN listing_id = '${listingId(498)}' THEN 3 WHEN listing_id = '${listingId(503)}' THEN 0 ELSE 1 END`);
    await pools.pricing.query(
      `INSERT INTO platform_policy_documents
        (document_id, policy_key, context_name, schema_summary, status, value, effective_from, created_at, updated_at)
       VALUES ('pol_synthetic_health', 'pricing.demand-curve', 'pricing', 'synthetic', 'active', $1::jsonb,
         '2026-10-01', '2026-10-01', '2026-10-01')`,
      [JSON.stringify(DEMAND_CURVE_LAUNCH_POLICY_VALUE)],
    );
    await pools.pricing.query(
      `INSERT INTO pricing_demand_curve_versions
        (catalog_item_id, product_id, version, provider_condition, provider_variant, provider_language, fingerprint,
         model_version, policy_revision_id, ladder_method, anchor_condition, exposure_start_reason, sales_coverage,
         supply_status, own_seller_exclusion_applied, built_at, currency_code, fresh_until)
       SELECT catalog_catalog_item_id, product_id, 1, 'Near Mint', 'Normal', 'English', 'synthetic-health',
         'synthetic', CASE WHEN listing_id = $2 THEN 'pol_synthetic_health:2026-09-01T00:00:00.000Z' ELSE $1 END,
         'synthetic', NULL, 'history-window', 'synthetic', 'observed', true,
         CASE WHEN listing_id IN ($3, $4) THEN '2026-10-14'::timestamptz ELSE '2026-10-15'::timestamptz END,
         CASE WHEN listing_id IN ($5, $6) THEN 'EUR' ELSE 'USD' END,
         CASE WHEN listing_id = $7 THEN '2026-10-16'::timestamptz ELSE '2100-01-01'::timestamptz END
       FROM pricing_market_listing_inputs`,
      [revision, listingId(499), listingId(497), listingId(498), listingId(496), listingId(501), listingId(500)],
    );
    await pools.pricing.query(
      `INSERT INTO pricing_demand_curve_points
        (catalog_item_id, product_id, version, percentile, price_amount, buyer_arrival_interval_days,
         competing_seller_count, store_win_share, median_sell_days, qualifying_sale_count, history_capped,
         hopeless, supply_status)
       SELECT catalog_catalog_item_id, product_id, 1, 50, CASE WHEN listing_id = $1 THEN 10 ELSE 15 END,
         NULL, NULL, NULL, CASE WHEN listing_id = $2 THEN 100 WHEN listing_id = $3 THEN 400
           WHEN listing_id = $4 THEN 8 ELSE 4 END, 10, false, listing_id = $3,
         CASE WHEN listing_id = $5 THEN 'unavailable' ELSE 'observed' END
       FROM pricing_market_listing_inputs`,
      [listingId(495), listingId(497), listingId(498), listingId(496), listingId(502)],
    );
  }

  async function enqueue(worker: ReturnType<typeof services>) {
    const run = (await worker.enqueueDryRun({ sellerAccountId: "acc_7910", body: dryRunBody }, dryRunContext))!;
    await pools.pricing.query("UPDATE pricing_repricing_dry_runs SET requested_at = $2 WHERE dry_run_id = $1", [
      run.dryRunId,
      capturedAt,
    ]);
    return run;
  }

  async function execute(worker = services()) {
    const run = await enqueue(worker);
    expect(await worker.processNextDryRunJob(claim)).toBe(1);
    return (await worker.getDryRun("acc_7910", run.dryRunId))!;
  }

  async function traceBytes(worker: ReturnType<typeof services>, run: RepricingDryRun) {
    const traces = [];
    let after: string | undefined;
    while (true) {
      const page = await worker.listDryRunTraces("acc_7910", run.dryRunId, { after, limit: 100 });
      traces.push(...page);
      if (page.length < 100) break;
      after = page.at(-1)!.listingId;
    }
    return JSON.stringify(traces);
  }

  it("persists exact S1-S9 across two pages/currencies, tied waits, missing reasons, bounds and building policies", async () => {
    await seed();
    const sql: string[] = [];
    const worker = services({
      connect: pools.pricing.connect.bind(pools.pricing),
      query: async <Row>(query: string, values?: readonly unknown[]) => {
        sql.push(query);
        return pools.pricing.query<Row>(query, values);
      },
    });
    const run = await execute(worker);
    expect(sql.filter((query) => query.includes("WITH advanced AS"))).toHaveLength(2);
    expect(sql.filter((query) => query.includes("SELECT document_id"))).toHaveLength(1);
    expect(run.summary?.listingsEvaluated).toBe(504);
    expect(run.health?.population).toEqual({ listingCount: 504, unitCount: 507 });
    expect(run.health?.uncategorized).toEqual({ listingCount: 1, unitCount: 1, reasons: { "no-currency": 1 } });
    const usd = run.health!.currencies.USD!;
    expect(usd.listedValueAmount).toBe("10080.00");
    expect(usd.modeledValueAmount).toBe("7560.00");
    expect(usd.modeledValueDeltaAmount).toBe("-2520.00");
    expect(usd.coverage).toEqual({
      listingCount: 498,
      listingTotal: 502,
      unitCount: 501,
      unitTotal: 504,
      listingRatio: 498 / 502,
      unitRatio: 501 / 504,
      missingReasons: { "stale-curve": 1, "currency-mismatch": 1, "supply-unavailable": 1, "zero-quantity": 1 },
      boundStatusCount: 1,
    });
    expect(usd.curveAge).toEqual({ newestAgeDays: 1, oldestAgeDays: 2, staleCount: 1 });
    expect(usd.expectedWait).toEqual({ medianDays: 4, p90Days: 4 });
    const weekly =
      496 * (1 - Math.exp((-Math.LN2 * 7) / 4)) +
      (1 - Math.exp((-Math.LN2 * 7) / 100)) +
      (1 - Math.exp((-Math.LN2 * 7) / 400));
    expect(usd.expectedSales.listingCount).toBeCloseTo(weekly, 10);
    expect(usd.expectedSales.valueAmount).toBe((15 * weekly).toFixed(2));
    expect(usd.valueAtRisk).toEqual({
      hopeless: { listingCount: 1, unitCount: 3, valueAmount: "45.00" },
      slow: { listingCount: 1, unitCount: 2, valueAmount: "30.00" },
      unknownPolicyListingCount: 1,
    });
    expect(usd.profitPerDay).toEqual({
      value: (7485 - 4990) / 6,
      cycleDays: 6,
      economicsListingCount: 496,
      unavailableReason: null,
      economicsUnavailableReasons: { "provider-unavailable": 1, "terms-unavailable": 1 },
      costBasisSourceKinds: { "policy-owned": 992 },
    });
    expect(usd.capitalTurn).toEqual({
      value: Math.log(7485 / 4990) / 6,
      cycleDays: 6,
      dailyReturnHurdle: 0.01,
      dailyReturnHurdleSourceKinds: { "policy-owned": 496 },
      unavailableReason: null,
    });
    const eur = run.health!.currencies.EUR!;
    expect(eur).toEqual({
      listedValueAmount: "40.00",
      modeledValueAmount: "40.00",
      modeledValueDeltaAmount: "0.00",
      coverage: {
        listingCount: 1,
        listingTotal: 1,
        unitCount: 2,
        unitTotal: 2,
        listingRatio: 1,
        unitRatio: 1,
        missingReasons: {},
        boundStatusCount: 1,
      },
      curveAge: { newestAgeDays: 1, oldestAgeDays: 1, staleCount: 0 },
      expectedWait: { medianDays: 8, p90Days: 8 },
      expectedSales: {
        listingCount: 1 - Math.pow(0.5, 7 / 8),
        valueAmount: (20 * (1 - Math.pow(0.5, 7 / 8))).toFixed(2),
      },
      valueAtRisk: {
        hopeless: { listingCount: 0, unitCount: 0, valueAmount: "0.00" },
        slow: { listingCount: 0, unitCount: 0, valueAmount: "0.00" },
        unknownPolicyListingCount: 0,
      },
      profitPerDay: {
        value: 2,
        cycleDays: 10,
        economicsListingCount: 1,
        unavailableReason: null,
        economicsUnavailableReasons: {},
        costBasisSourceKinds: { "policy-owned": 2 },
      },
      capitalTurn: {
        value: Math.log(2) / 10,
        cycleDays: 10,
        dailyReturnHurdle: 0.01,
        dailyReturnHurdleSourceKinds: { "policy-owned": 1 },
        unavailableReason: null,
      },
    });
    expect(worker.resolve).toHaveBeenCalledTimes(499);
    for (const [request] of worker.resolve.mock.calls) {
      expect(request.quantity).toBe(1);
      expect(request.effectiveAt).toBe(capturedAt);
      expect(request.marketUnitPrice.amount).toBe("20.00");
    }
    const persisted = await pools.pricing.query<{ health: unknown }>(
      "SELECT health FROM pricing_repricing_dry_runs WHERE dry_run_id = $1",
      [run.dryRunId],
    );
    expect(run.health).toEqual(persisted.rows[0]!.health);
    expect((await worker.listDryRuns("acc_7910"))[0]!.health).toEqual(persisted.rows[0]!.health);
    const response = await api(worker).request(`/dry-runs/${run.dryRunId}`);
    expect(response.status).toBe(200);
    expect((await response.json()).health).toEqual(persisted.rows[0]!.health);

    const noEconomicsWorker = services(pools.pricing, true);
    const noEconomics = await execute(noEconomicsWorker);
    expect(noEconomics.health!.currencies.USD!.profitPerDay.value).toBeNull();
    expect(noEconomics.health!.currencies.USD!.capitalTurn.value).toBeNull();
    expect(noEconomics.health!.currencies.USD!.profitPerDay.economicsListingCount).toBe(0);
    expect(noEconomics.health).not.toEqual(run.health);

    // This body reads no curves for evaluation. Suppressing the health-only read is the disabled control.
    const disabled = services({
      connect: pools.pricing.connect.bind(pools.pricing),
      query: async <Row>(query: string, values?: readonly unknown[]) =>
        query.includes("pricing_demand_curve_versions")
          ? { rows: [] as Row[] }
          : pools.pricing.query<Row>(query, values),
    });
    const control = await execute(disabled);
    expect(await traceBytes(worker, run)).toBe(await traceBytes(disabled, control));
    await pools.pricing.query("DELETE FROM pricing_demand_curve_points; DELETE FROM pricing_demand_curve_versions");
    const noCurves = await execute();
    expect(noCurves.health!.currencies.USD!.coverage.listingCount).toBe(0);
    expect(noCurves.health!.currencies.USD!.coverage.missingReasons).toEqual({ "no-curve": 501, "zero-quantity": 1 });
    expect(noCurves.health!.currencies.USD!.expectedWait.medianDays).toBeNull();
    expect(noCurves.health!.currencies.USD!.profitPerDay.value).toBeNull();
    expect(noCurves.health!.currencies.USD!.capitalTurn.value).toBeNull();
    expect(noCurves.health).not.toEqual(run.health);
  });

  it("returns legacy health:null without changing summary or enqueuing on get/list/GET", async () => {
    const worker = services();
    const run = await enqueue(worker);
    const summary = {
      listingsEvaluated: 7,
      outcomes: { changed: 7 },
      skipReasons: {},
      flags: {},
      deltaBuckets: { "0": 7 },
      withinTolerance: 0,
    };
    await pools.pricing.query(
      "UPDATE pricing_repricing_dry_runs SET status = 'completed', summary = $2::jsonb, health = NULL WHERE dry_run_id = $1",
      [run.dryRunId, JSON.stringify(summary)],
    );
    await pools.pricing.query("UPDATE pricing_repricing_dry_run_jobs SET status = 'completed' WHERE job_id = $1", [
      run.dryRunId,
    ]);
    expect(await worker.getDryRun("acc_7910", run.dryRunId)).toMatchObject({ summary, health: null });
    expect(await worker.listDryRuns("acc_7910")).toEqual([expect.objectContaining({ summary, health: null })]);
    const app = api(worker);
    const jobs = () => pools.pricing.query("SELECT * FROM pricing_repricing_dry_run_jobs ORDER BY job_id");
    const before = (await jobs()).rows;
    const response = await app.request(`/dry-runs/${run.dryRunId}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ summary, health: null });
    expect((await jobs()).rows).toEqual(before);
  });

  it("resumes pre-migration traces with health:null rather than a partial whole-scope summary", async () => {
    await seed();
    let interrupted = false;
    const oldWorker = services({
      connect: pools.pricing.connect.bind(pools.pricing),
      query: async <Row>(query: string, values?: readonly unknown[]) => {
        const result = await pools.pricing.query<Row>(query, values);
        if (query.includes("WITH advanced AS") && !interrupted) {
          await pools.pricing.query("UPDATE pricing_repricing_dry_run_traces SET health = NULL WHERE dry_run_id = $1", [
            values![1],
          ]);
          interrupted = true;
        }
        return result;
      },
    });
    const run = await enqueue(oldWorker);
    await expect(
      oldWorker.processNextDryRunJob({
        ...claim,
        throwIfLeaseLost: () => {
          if (interrupted) throw new Error("synthetic deploy interruption");
        },
      }),
    ).rejects.toThrow("synthetic deploy interruption");
    await pools.pricing.query(
      `UPDATE pricing_repricing_dry_run_jobs
      SET claimed_until = now() - interval '2 seconds', next_eligible_at = now() - interval '1 second'
      WHERE job_id = $1`,
      [run.dryRunId],
    );
    const resumed = services();
    expect(await resumed.processNextDryRunJob(claim)).toBe(1);
    const completed = await resumed.getDryRun("acc_7910", run.dryRunId);
    expect(completed?.summary?.listingsEvaluated).toBe(504);
    expect(completed?.health).toBeNull();
    expect(
      (
        await pools.pricing.query<{ missing: boolean }>(
          "SELECT health IS NULL AS missing FROM pricing_repricing_dry_runs WHERE dry_run_id = $1",
          [run.dryRunId],
        )
      ).rows[0]?.missing,
    ).toBe(true);
    const counts = await pools.pricing.query<{ missing: string; present: string }>(
      `SELECT count(*) FILTER (WHERE health IS NULL)::text AS missing,
        count(*) FILTER (WHERE health IS NOT NULL)::text AS present
       FROM pricing_repricing_dry_run_traces WHERE dry_run_id = $1`,
      [run.dryRunId],
    );
    expect(counts.rows[0]).toEqual({ missing: "500", present: "4" });
  });
});
