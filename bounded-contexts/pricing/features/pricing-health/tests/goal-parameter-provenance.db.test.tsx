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
import { formatDateTime, formatMoney } from "@chase-sets/localization";
import { renderToStaticMarkup } from "react-dom/server";
import { dryRunContext, seedDryRunListings } from "../../repricing-engine/tests/dry-run-fixture";
import {
  comparisonAccountId,
  comparisonNow,
  comparisonPolicyId,
  comparisonTestServices,
  createComparisonPolicy,
} from "./goal-comparison-db-fixture";
import { GoalPicker } from "../ui/goal-comparison";
import { healthNumber, healthPercent, localizedEconomicsReason, localizedEconomicsSource } from "../ui/copy";

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
    await seedDryRunListings(pools.pricing, 2, 1);
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

  it("renders registry controls and resolved Economics provenance, then carries a non-default parameter into compare", async () => {
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
    const html = renderToStaticMarkup(<GoalPicker goals={data!.goals!} />);
    for (const goal of data!.goals!)
      for (const parameter of Object.keys(goal.parameterSchema))
        expect(html).toContain(`name="goal.${goal.goalId}.${goal.goalVersion}.${parameter}"`);
    const request = resolve.mock.calls[0]![0];
    const resolution = await economics.resolve(request);
    expect(resolution.kind).toBe("resolved");
    if (resolution.kind === "resolved") {
      for (const [name, fact] of Object.entries(resolution.economics.facts)) {
        const value =
          fact.effectiveValue === null
            ? "Unavailable"
            : typeof fact.effectiveValue === "object" && "amount" in fact.effectiveValue
              ? formatMoney(fact.effectiveValue.amount, fact.effectiveValue.currency)
              : name.endsWith("Bps")
                ? healthPercent(Number(fact.effectiveValue) / 10_000)
                : name === "dailyReturnHurdle"
                  ? healthPercent(Number(fact.effectiveValue))
                  : healthNumber(Number(fact.effectiveValue));
        expect(html).toContain(value);
        expect(html).toContain(localizedEconomicsSource(fact.source.kind));
        expect(html).toContain(formatDateTime(fact.observedAt));
      }
    }
    const edited = data!.goals!.map((goal) => ({
      goalId: goal.goalId,
      goalVersion: goal.goalVersion,
      parameters: goal.goalId === "fixed-percentile" ? { ...goal.parameters, percentile: 66 } : goal.parameters,
    }));
    const runs = await services.health.compare(comparisonAccountId, comparisonPolicyId, dryRunContext, edited);
    expect(runs).toHaveLength(data!.goals!.length);
    expect(resolve).toHaveBeenCalledTimes(1);
    const fixed = runs!.find((run) => run.goalId === "fixed-percentile")!;
    const row = await pools.pricing.query<{
      body: { rules: Array<{ directive: { anchorChain: Array<{ parameters?: Record<string, number> }> } }> };
    }>("SELECT body FROM pricing_repricing_dry_runs WHERE dry_run_id=$1", [fixed.dryRunId]);
    expect(row.rows[0]?.body.rules[0]?.directive.anchorChain[0]?.parameters).toEqual({ percentile: 66 });

    const editedData = await services.health.getHealth(comparisonAccountId, comparisonPolicyId, comparisonNow, edited);
    const editedCandidate = editedData!.comparison!.find((candidate) => candidate.goalId === "fixed-percentile")!;
    expect(editedCandidate.dryRunId).toBe(fixed.dryRunId);
    expect(editedCandidate.bodyHash).not.toBe(
      (await services.health.getHealth(comparisonAccountId, comparisonPolicyId, comparisonNow))!.comparison!.find(
        (candidate) => candidate.goalId === "fixed-percentile",
      )?.bodyHash,
    );
  });

  it("resolves catalog-filter Economics from the first non-excluded listing", async () => {
    await pools.pricing.query(
      `UPDATE pricing_market_listing_inputs
          SET catalog_catalog_item_id='cat_00000000', product_id='prod_00000000', inventory_item_id='lst_7910_00000002'
        WHERE listing_id='lst_7910_00000002';
       INSERT INTO pricing_inventory_item_inputs
         (item_id, seller_account_id, catalog_catalog_item_id, product_id, total_quantity,
          acquisition_cost_amount, acquisition_cost_currency_code, updated_at, last_stream_version)
       VALUES ('lst_7910_00000002', 'acc_7910', 'cat_00000000', 'prod_00000000', 1,
          1.00, 'USD', '2026-10-19T00:00:00Z', 1);
       INSERT INTO pricing_catalog_item_inputs
         (catalog_item_id, title, status, category_ids, updated_at)
       VALUES ('cat_00000000', 'Synthetic catalog item', 'active', ARRAY['cat_synthetic_a'], '2026-10-19T00:00:00Z');`,
    );
    const eventStore = createPostgresEventStore({ pool: pools.pricing });
    const policies = createPolicyRuntime({ eventStore, db: pools.pricing });
    const economics = createEconomicsServices({
      eventStore,
      db: pools.pricing,
      policies,
      commercialTermsResolver: syntheticTerms,
      channelConnectionIdentityReader: { resolve: async () => null },
    });
    const services = comparisonTestServices(pools.pricing, { resolve: economics.resolve });
    await createComparisonPolicy(pools.pricing, services, undefined, {
      scope: { kind: "catalog-filter", categoryIds: ["cat_synthetic_a"] },
      excludedListingIds: ["lst_7910_00000001"],
    });
    const data = await services.health.getHealth(comparisonAccountId, comparisonPolicyId, comparisonNow);
    const economicsGoal = data?.goals?.find((goal) => goal.requiresEconomics);
    expect(economicsGoal?.economics).not.toBeNull();
    expect(economicsGoal?.economics?.currency).toBe("usd");
  });
});
