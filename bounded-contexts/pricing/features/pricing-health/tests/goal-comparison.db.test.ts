// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, render, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import { createPricingHealthServices } from "../api/services";
import { createRepricingDryRunServices } from "../../repricing-engine/api/dry-run";
import { createRepricingPolicyRuntime } from "../../repricing-policies/api/runtime";
import { REPRICING_ENGINE_LAUNCH_POLICY_VALUE } from "../../repricing-engine/domain/policy";
import { DEMAND_CURVE_LAUNCH_POLICY_VALUE } from "../../market-estimates/domain/demand-curve-policy";
import { dryRunBody, dryRunContext, seedDryRunListings } from "../../repricing-engine/tests/dry-run-fixture";
import { projectSyntheticPricingHealthPolicy } from "../../../support/runtime-support/pricing-health-browser-seed";
import {
  comparisonAccountId,
  comparisonAdvancedTargets,
  comparisonPolicyId,
  comparisonTestServices,
  createComparisonPolicy,
} from "./goal-comparison-db-fixture";
import { PricingHealthPage } from "../ui/page";
import RepricingPolicyRoute from "../../../routes/marketplace/account-desk-repricing-policy";
import RepricingRoute from "../../../routes/marketplace/account-desk-repricing";
import { pricingApi } from "../../../support/request-support/api-client";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const now = "2026-10-20T00:00:00.000Z";

describeDb("Pricing Goal comparison whole target scope", () => {
  let pools: Readonly<Record<"pricing", PgTransactionalPool>>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["pricing"], "pricing_comparison_9771");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.pricing.query(pricingModule.schemaSql);
  });
  afterAll(async () => closeMultiContextTestPools(pools));
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("retains second-page S2/S5/S3 and movement over 501 products, without mutating the policy", async () => {
    await seedDryRunListings(pools.pricing, 501, 501);
    await pools.pricing.query(
      `INSERT INTO platform_policy_documents
      (document_id, policy_key, context_name, schema_summary, status, value, effective_from, created_at, updated_at)
      VALUES ('pol_synthetic_comparison', 'pricing.demand-curve', 'pricing', 'synthetic', 'active', $1::jsonb,
        '2026-10-01', '2026-10-01', '2026-10-01')`,
      [JSON.stringify(DEMAND_CURVE_LAUNCH_POLICY_VALUE)],
    );
    await pools.pricing.query(`INSERT INTO pricing_demand_curve_versions
      (catalog_item_id, product_id, version, provider_condition, provider_variant, provider_language, fingerprint,
       model_version, policy_revision_id, ladder_method, anchor_condition, exposure_start_reason, sales_coverage,
       supply_status, own_seller_exclusion_applied, built_at, currency_code, fresh_until)
      SELECT catalog_catalog_item_id, product_id, 1, 'Near Mint', 'Normal', 'English', 'synthetic-comparison',
        'synthetic', 'pol_synthetic_comparison:2026-10-01T00:00:00.000Z', 'synthetic', NULL, 'history-window',
        'synthetic', 'observed', true, '2026-10-19', 'USD', '2100-01-01'
      FROM pricing_market_listing_inputs`);
    await pools.pricing.query(`INSERT INTO pricing_demand_curve_points
      (catalog_item_id, product_id, version, percentile, price_amount, buyer_arrival_interval_days,
       competing_seller_count, store_win_share, median_sell_days, qualifying_sale_count, history_capped,
       hopeless, supply_status)
      SELECT catalog_catalog_item_id, product_id, 1, 65,
        CASE WHEN listing_id='lst_7910_00000501' THEN 25 ELSE 15 END,
        NULL, NULL, NULL, 4, 30, false, false, 'observed' FROM pricing_market_listing_inputs`);
    const eventStore = createPostgresEventStore({ pool: pools.pricing });
    const policies = createRepricingPolicyRuntime({ eventStore, db: pools.pricing, goalAdoptions: async () => [] });
    await policies.commandHandler({
      streamId: policies.streamIdForPolicy("rpp_synthetic_comparison"),
      context: dryRunContext,
      command: {
        ...dryRunBody,
        type: "CreateRepricingPolicy",
        policyId: "rpp_synthetic_comparison",
        accountId: "acc_7910",
        name: "Synthetic health policy comparison",
        createdAt: now,
      },
    });
    await projectSyntheticPricingHealthPolicy(pools.pricing, {
      policyId: "rpp_synthetic_comparison",
      accountId: "acc_7910",
    });
    const before = await policies.loadOwnedRepricingPolicy("rpp_synthetic_comparison", "acc_7910");
    const sql: string[] = [];
    const worker = createRepricingDryRunServices(
      {
        connect: pools.pricing.connect.bind(pools.pricing),
        query: async <Row>(query: string, values?: readonly unknown[]) => {
          sql.push(query);
          return pools.pricing.query<Row>(query, values);
        },
      },
      async () => REPRICING_ENGINE_LAUNCH_POLICY_VALUE,
      {
        resolve: async () => {
          throw new Error("No inventory item is present in this synthetic fixture.");
        },
      },
    );
    const health = createPricingHealthServices({
      db: pools.pricing,
      policies: createPolicyRuntime({ eventStore, db: pools.pricing }),
      repricingPolicies: policies,
      repricingEngine: worker,
      forecastLedger: {
        listGoalAdoptions: async () => [
          {
            goalId: "fixed-percentile",
            goalVersion: 1,
            lifecycle: "selectable",
            incumbentVersion: null,
            selectable: true,
            promotable: true,
            reason: null,
            grades: null,
          },
        ],
      },
    });
    const queued = await health.compare("acc_7910", "rpp_synthetic_comparison", dryRunContext);
    expect(queued).toHaveLength(1);
    const id = queued![0]!.dryRunId;
    await pools.pricing.query("UPDATE pricing_repricing_dry_runs SET requested_at=$2 WHERE dry_run_id=$1", [id, now]);
    expect(await worker.processNextDryRunJob({ claimOwnerId: "synthetic-comparison", claimTtlMs: 300_000 })).toBe(1);
    expect(sql.filter((query) => query.includes("WITH advanced AS"))).toHaveLength(2);
    // More than 100 unrelated recent runs must not hide the exact candidate.
    await pools.pricing.query(
      `INSERT INTO pricing_repricing_dry_runs
      (dry_run_id,seller_account_id,replacing_policy_id,body,body_hash,status,requested_at,completed_at,summary,health,updated_at)
      SELECT 'synthetic-unrelated-' || n, seller_account_id,replacing_policy_id,body,'synthetic-unrelated-' || n,
        status,requested_at + n * interval '1 second',completed_at,summary,health,updated_at
      FROM pricing_repricing_dry_runs CROSS JOIN generate_series(1,101) AS n WHERE dry_run_id=$1`,
      [id],
    );
    const data = await health.getHealth("acc_7910", "rpp_synthetic_comparison", now);
    expect(data?.comparison).toHaveLength(1);
    expect(data?.comparison?.[0]).toMatchObject({
      listingCount: 501,
      raised: 1,
      lowered: 500,
      held: 0,
      value: { USD: "7525.00" },
      medianWaitDays: { USD: 4 },
      p90WaitDays: { USD: 4 },
      coverage: { USD: 1 },
      boundStatusCount: { USD: 0 },
      targetRevision: before!.version,
      targetPolicyId: "rpp_synthetic_comparison",
    });
    expect(await policies.loadOwnedRepricingPolicy("rpp_synthetic_comparison", "acc_7910")).toEqual(before);
    await pools.pricing.query("UPDATE pricing_demand_curve_versions SET fresh_until='2026-10-19'");
    expect((await health.getHealth("acc_7910", "rpp_synthetic_comparison", now))?.comparison).toEqual([]);
    await pools.pricing.query("UPDATE pricing_demand_curve_versions SET fresh_until='2100-01-01'");
    await pools.pricing.query(
      "UPDATE pricing_repricing_dry_runs SET body_hash='synthetic-corrupt' WHERE dry_run_id=$1",
      [id],
    );
    expect((await health.getHealth("acc_7910", "rpp_synthetic_comparison", now))?.comparison).toEqual([]);
  });

  it("reads bound-status counts without recalculating stored S5, and invalidates changed listing evidence", async () => {
    await seedDryRunListings(pools.pricing, 1, 1);
    const services = comparisonTestServices(pools.pricing);
    await createComparisonPolicy(pools.pricing, services);
    const runs = (await services.health.compare(comparisonAccountId, comparisonPolicyId, dryRunContext))!;
    for (const run of runs)
      await services.worker.processNextDryRunJob({ claimOwnerId: "synthetic-bounds", claimTtlMs: 300_000 });
    const data = await services.health.getHealth(comparisonAccountId, comparisonPolicyId, now);
    expect(data?.comparison).toHaveLength(runs.length);
    const before = data!.comparison![0]!;
    expect(before.boundStatusCount).toEqual({ USD: 0 });
    await pools.pricing.query(
      `UPDATE pricing_repricing_dry_runs
      SET health=jsonb_set(jsonb_set(health,'{currencies,USD,coverage,boundStatusCount}','7'),
        '{currencies,USD,expectedWait,medianDays}','123') WHERE dry_run_id=$1`,
      [before.dryRunId],
    );
    const stored = await services.health.getHealth(comparisonAccountId, comparisonPolicyId, now);
    expect(stored?.comparison?.find((row) => row.dryRunId === before.dryRunId)).toMatchObject({
      boundStatusCount: { USD: 7 },
      medianWaitDays: { USD: 123 },
    });
    await pools.pricing.query("UPDATE pricing_market_listing_inputs SET price_amount=21");
    expect((await services.health.getHealth(comparisonAccountId, comparisonPolicyId, now))?.comparison).toEqual([]);
  });

  it("invalidates candidates on a target revision even when its body returns to the original hash", async () => {
    await seedDryRunListings(pools.pricing, 1, 1);
    const services = comparisonTestServices(pools.pricing);
    await createComparisonPolicy(pools.pricing, services);
    const runs = (await services.health.compare(comparisonAccountId, comparisonPolicyId, dryRunContext))!;
    for (const run of runs)
      await services.worker.processNextDryRunJob({ claimOwnerId: "synthetic-revision", claimTtlMs: 300_000 });
    expect((await services.health.getHealth(comparisonAccountId, comparisonPolicyId, now))?.comparison).toHaveLength(
      runs.length,
    );
    await services.policies.executeOwnedRepricingPolicy({
      accountId: comparisonAccountId,
      policyId: comparisonPolicyId,
      context: dryRunContext,
      command: {
        ...dryRunBody,
        type: "ReviseRepricingPolicy",
        name: "Revised name",
        revisedAt: "2100-01-01T00:00:00.000Z",
      },
    });
    expect((await services.health.getHealth(comparisonAccountId, comparisonPolicyId, now))?.comparison).toEqual([]);
  });

  it.each(comparisonAdvancedTargets)(
    "opens the existing editor with the intact %s body, no candidate or silent mutation",
    async (_, rules) => {
      const services = comparisonTestServices(pools.pricing);
      await createComparisonPolicy(pools.pricing, services, rules);
      const before = await services.policies.loadOwnedRepricingPolicy(comparisonPolicyId, comparisonAccountId);
      const data = (await services.health.getHealth(comparisonAccountId, comparisonPolicyId, now))!;
      expect(data.branch).toBe("advanced-editor");
      expect(renderToStaticMarkup(createElement(PricingHealthPage, { data }))).toContain(
        `/account/desk/repricing/${comparisonPolicyId}?edit=1`,
      );
      vi.spyOn(pricingApi, "getRepricingAuthoringPrerequisites").mockImplementation(() =>
        services.policies.getAuthoringPrerequisites(comparisonAccountId),
      );
      vi.spyOn(pricingApi, "listRepricingCategories").mockImplementation(() =>
        services.policies.listCategories(comparisonAccountId),
      );
      const Stub = createRoutesStub([{ path: "/account/desk/repricing/:policyId", Component: RepricingPolicyRoute }]);
      render(
        createElement(Stub, {
          initialEntries: [`/account/desk/repricing/${comparisonPolicyId}?edit=1`],
          hydrationData: {
            loaderData: {
              "0": {
                recovery: null,
                policy: before!.state,
                halt: await services.policies.getHalt(comparisonAccountId),
                changesUsedToday: 0,
                activity: null,
                activityFilter: null,
                activityLoadFailed: false,
              },
            },
          },
        }),
      );
      expect(((await screen.findByLabelText("Policy name")) as HTMLInputElement).value).toBe(before!.state.name);
      expect(screen.getByText("Advanced rule editor", { exact: true })).toBeTruthy();
      expect(await services.health.compare(comparisonAccountId, comparisonPolicyId, dryRunContext)).toBeNull();
      expect((await pools.pricing.query("SELECT dry_run_id FROM pricing_repricing_dry_runs")).rows).toEqual([]);
      expect(await services.policies.loadOwnedRepricingPolicy(comparisonPolicyId, comparisonAccountId)).toEqual(before);
    },
  );

  it("opens the existing create editor and preset prompts for a zero-policy account without enqueue", async () => {
    const services = comparisonTestServices(pools.pricing);
    const data = (await services.health.getHealth(comparisonAccountId, undefined, now))!;
    expect(renderToStaticMarkup(createElement(PricingHealthPage, { data }))).toContain(
      "/account/desk/repricing?create=1",
    );
    vi.spyOn(pricingApi, "getRepricingAuthoringPrerequisites").mockImplementation(() =>
      services.policies.getAuthoringPrerequisites(comparisonAccountId),
    );
    vi.spyOn(pricingApi, "listRepricingCategories").mockImplementation(() =>
      services.policies.listCategories(comparisonAccountId),
    );
    const Stub = createRoutesStub([{ path: "/account/desk/repricing", Component: RepricingRoute }]);
    render(
      createElement(Stub, {
        initialEntries: ["/account/desk/repricing?create=1"],
        hydrationData: {
          loaderData: {
            "0": {
              policies: [],
              halt: await services.policies.getHalt(comparisonAccountId),
              dryRuns: [],
              loadFailed: false,
              catchingUp: false,
            },
          },
        },
      }),
    );
    await screen.findByLabelText("Policy name");
    expect(screen.getByLabelText("Minimum price")).toBeTruthy();
    expect((await pools.pricing.query("SELECT dry_run_id FROM pricing_repricing_dry_runs")).rows).toEqual([]);
    expect((await pools.pricing.query("SELECT policy_id FROM pricing_repricing_policies")).rows).toEqual([]);
  });
});
