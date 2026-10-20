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
import { createPricingHealthServices } from "../api/services";
import { createRepricingDryRunServices } from "../../repricing-engine/api/dry-run";
import { createRepricingPolicyRuntime } from "../../repricing-policies/api/runtime";
import { REPRICING_ENGINE_LAUNCH_POLICY_VALUE } from "../../repricing-engine/domain/policy";
import { DEMAND_CURVE_LAUNCH_POLICY_VALUE } from "../../market-estimates/domain/demand-curve-policy";
import { dryRunBody, dryRunContext, seedDryRunListings } from "../../repricing-engine/tests/dry-run-fixture";
import { projectSyntheticPricingHealthPolicy } from "../../../support/runtime-support/pricing-health-browser-seed";

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
      scopeLabel: "Entire selected policy candidate scope",
      targetPolicyId: "rpp_synthetic_comparison",
    });
    expect(await policies.loadOwnedRepricingPolicy("rpp_synthetic_comparison", "acc_7910")).toEqual(before);
    await pools.pricing.query(
      "UPDATE pricing_repricing_dry_runs SET body_hash='synthetic-corrupt' WHERE dry_run_id=$1",
      [id],
    );
    expect((await health.getHealth("acc_7910", "rpp_synthetic_comparison", now))?.comparison).toEqual([]);
  });
});
