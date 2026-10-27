// @vitest-environment jsdom
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createNoopCommercialTermsResolver, type CommercialTermsResolver } from "@chase-sets/commercial-terms/server";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { eventSubscriptionSchemaSql } from "@chase-sets/bounded-context-runtime";
import { createPolicyRuntime } from "@chase-sets/platform-policy/runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as pricingModule } from "../../../index";
import { createEconomicsServices } from "../../economics/api/services";
import { dryRunContext, seedDryRunListings } from "../../repricing-engine/tests/dry-run-fixture";
import {
  comparisonAccountId,
  comparisonNow,
  comparisonPolicyId,
  comparisonTestServices,
  createComparisonPolicy,
} from "./goal-comparison-db-fixture";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required.");
const describeDb = databaseBaseUrl ? describe : describe.skip;

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
    scheduleId: "synthetic-pricing-health-schedule",
    agreementId: null,
    resolvedAt: input.effectiveAt!,
  }),
};

describeDb("Pricing Health goal parameter and Economics provenance", () => {
  let pools: Readonly<Record<"pricing", PgTransactionalPool>>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["pricing"], "pricing_goal_provenance_10279");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.pricing.query(pricingModule.schemaSql);
    await pools.pricing.query(eventSubscriptionSchemaSql);
    await seedDryRunListings(pools.pricing, 1, 1);
    await pools.pricing.query(
      `UPDATE pricing_market_listing_inputs SET inventory_item_id='lst_7910_00000001' WHERE listing_id='lst_7910_00000001';
       INSERT INTO pricing_inventory_item_inputs
         (item_id, seller_account_id, catalog_catalog_item_id, product_id, total_quantity,
          acquisition_cost_amount, acquisition_cost_currency_code, updated_at, last_stream_version)
       VALUES ('lst_7910_00000001', 'acc_7910', 'cat_00000000', 'prod_00000000', 1,
          1.00, 'USD', '2026-10-19T00:00:00Z', 1);`,
    );
  });
  afterAll(async () => closeMultiContextTestPools(pools));

  it("resolves one first-listing Economics snapshot and carries a non-default parameter into compare", async () => {
    const eventStore = createPostgresEventStore({ pool: pools.pricing });
    const policies = createPolicyRuntime({ eventStore, db: pools.pricing });
    const economics = createEconomicsServices({
      eventStore,
      db: pools.pricing,
      policies,
      commercialTermsResolver: syntheticTerms,
      channelConnectionIdentityReader: { resolve: async () => null },
    });
    const resolve = vi.fn(economics.resolve);
    const services = comparisonTestServices(pools.pricing, { resolve });
    await createComparisonPolicy(pools.pricing, services);
    const data = await services.health.getHealth(comparisonAccountId, comparisonPolicyId, comparisonNow);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(data?.goals?.some((goal) => goal.requiresEconomics && goal.economics !== null)).toBe(true);
    const edited = data!.goals!.map((goal) => ({
      goalId: goal.goalId,
      goalVersion: goal.goalVersion,
      parameters: goal.goalId === "fixed-percentile" ? { ...goal.parameters, percentile: 66 } : goal.parameters,
    }));
    const runs = await services.health.compare(comparisonAccountId, comparisonPolicyId, dryRunContext, edited);
    expect(runs).toHaveLength(data!.goals!.length);
    const fixed = runs!.find((run) => run.goalId === "fixed-percentile")!;
    const row = await pools.pricing.query<{
      body: { rules: Array<{ directive: { anchorChain: Array<{ parameters?: Record<string, number> }> } }> };
    }>("SELECT body FROM pricing_repricing_dry_runs WHERE dry_run_id=$1", [fixed.dryRunId]);
    expect(row.rows[0]?.body.rules[0]?.directive.anchorChain[0]?.parameters).toEqual({ percentile: 66 });
  });
});
