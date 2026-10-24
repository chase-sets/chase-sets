import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as pricingModule } from "../../../index";
import { GoalPicker } from "../ui/goal-comparison";
import type { PricingGoalDefinition } from "../../repricing-policies/domain/goals/registry";
import { dryRunContext, seedDryRunListings } from "../../repricing-engine/tests/dry-run-fixture";
import {
  comparisonAccountId,
  comparisonNow,
  comparisonPolicyId,
  comparisonTestServices,
  createComparisonPolicy,
} from "./goal-comparison-db-fixture";

const registryCapture = vi.hoisted(() => ({
  registries: [] as Array<{
    registerPricingGoal: (goal: PricingGoalDefinition) => void;
    definitions: () => readonly PricingGoalDefinition[];
  }>,
}));
vi.mock("../../repricing-policies/domain/goals/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../repricing-policies/domain/goals/registry")>();
  return {
    ...actual,
    createPricingGoalRegistry: (...args: Parameters<typeof actual.createPricingGoalRegistry>) => {
      const registry = actual.createPricingGoalRegistry(...args);
      const fixed = registry.definitions().find((goal) => goal.id === "fixed-percentile");
      if (fixed) {
        registry.registerPricingGoal({ ...fixed, version: 2, lifecycle: "shadow" });
        registry.registerPricingGoal({ ...fixed, version: 3, lifecycle: "selectable" });
        registry.registerPricingGoal({ ...fixed, version: 4, lifecycle: "retired" });
      }
      registryCapture.registries.push(registry);
      return registry;
    },
  };
});

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required.");
const describeDb = databaseBaseUrl ? describe : describe.skip;

describeDb("Pricing Health real-composition registry surface", () => {
  let pools: Readonly<Record<"pricing", PgTransactionalPool>>;
  let services: ReturnType<typeof comparisonTestServices>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["pricing"], "pricing_goal_surface_9771");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.pricing.query(pricingModule.schemaSql);
    await seedDryRunListings(pools.pricing, 2, 2);
    await pools.pricing.query(
      `UPDATE pricing_market_listing_inputs SET inventory_item_id='lst_7910_00000001' WHERE listing_id='lst_7910_00000001';
       INSERT INTO pricing_inventory_item_inputs
         (item_id, seller_account_id, catalog_catalog_item_id, product_id, total_quantity,
          acquisition_cost_amount, acquisition_cost_currency_code, updated_at, last_stream_version)
       VALUES ('lst_7910_00000001', 'acc_7910', 'cat_00000000', 'prod_00000000', 1,
          1.00, 'USD', '2026-10-19T00:00:00Z', 1);`,
    );
    services = comparisonTestServices(pools.pricing);
    await createComparisonPolicy(pools.pricing, services);
  });
  afterAll(async () => closeMultiContextTestPools(pools));

  it("drives the real Adoption Gate and registry, then carries a non-default value into compare readback", async () => {
    const data = await services.health.getHealth(comparisonAccountId, comparisonPolicyId, comparisonNow);
    expect(data?.goals?.map(({ goalId, goalVersion }) => `${goalId}@${goalVersion}`).sort()).toEqual(
      ["fixed-percentile@1", "target-horizon@1", "profit-per-day@1", "hold-value@1", "cash-target@1"].sort(),
    );
    expect(data?.goals?.every((goal) => goal.lifecycle === "selectable")).toBe(true);
    expect(registryCapture.registries).toHaveLength(1);
    const registered = registryCapture.registries[0]!.definitions();
    expect(
      registered.filter((goal) => goal.id === "fixed-percentile").map((goal) => `${goal.id}@${goal.version}`),
    ).toEqual(["fixed-percentile@1", "fixed-percentile@2", "fixed-percentile@3", "fixed-percentile@4"]);
    const adoptions = await services.forecastLedger.listGoalAdoptions();
    expect(adoptions.find((entry) => entry.goalId === "fixed-percentile" && entry.goalVersion === 3)).toMatchObject({
      selectable: false,
      reason: "shadow-grade-missing",
    });
    const html = renderToStaticMarkup(createElement(GoalPicker, { goals: data!.goals! }));
    expect(html).toContain("Price at the 65th market percentile");
    expect(html).not.toContain("Market-evidence pricing goal");
    expect(html).not.toContain("fixed-percentile@1");

    const runs = await services.health.compare(comparisonAccountId, comparisonPolicyId, dryRunContext);
    expect(runs).toHaveLength(data!.goals!.length);
    const fixed = runs!.find((run) => run.goalId === "fixed-percentile")!;
    const rows = await pools.pricing.query<{ body: unknown; body_hash: string }>(
      "SELECT body, body_hash FROM pricing_repricing_dry_runs WHERE dry_run_id=$1",
      [fixed.dryRunId],
    );
    expect(rows.rows[0]?.body).toMatchObject({
      rules: [{ directive: { anchorChain: [{ parameters: { percentile: 65 } }] } }],
    });
    expect(rows.rows[0]?.body_hash).not.toBe(null);
  });
});
