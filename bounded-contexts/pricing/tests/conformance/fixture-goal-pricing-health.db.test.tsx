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
import { module as pricingModule } from "../../index";
import { GoalComparison, GoalPicker } from "../../features/pricing-health/ui/goal-comparison";
import { dryRunBody, dryRunContext } from "../../features/repricing-engine/tests/dry-run-fixture";
import {
  comparisonAccountId,
  comparisonNow,
  comparisonPolicyId,
  comparisonTestServices,
  createComparisonPolicy,
  syntheticUnavailableEconomics,
} from "../../features/pricing-health/tests/goal-comparison-db-fixture";
import { fixtureFlatOffsetGoal } from "./fixture-flat-offset";
import type { PricingGoalDefinition } from "../../features/repricing-policies/domain/goals/registry";

const registryCapture = vi.hoisted(() => ({
  registries: [] as Array<{
    definitions: () => readonly PricingGoalDefinition[];
    registerPricingGoal: (goal: PricingGoalDefinition) => void;
  }>,
}));
vi.mock("../../features/repricing-policies/domain/goals/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../features/repricing-policies/domain/goals/registry")>();
  return {
    ...actual,
    createPricingGoalRegistry: (...args: Parameters<typeof actual.createPricingGoalRegistry>) => {
      const registry = actual.createPricingGoalRegistry(...args);
      registryCapture.registries.push(registry);
      return registry;
    },
  };
});

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required.");
const describeDb = databaseBaseUrl ? describe : describe.skip;

describeDb("the fixture goal reaches the real Pricing Health registry surface", () => {
  let pools: Readonly<Record<"pricing", PgTransactionalPool>>;
  let services: ReturnType<typeof comparisonTestServices>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["pricing"], "fixture_goal_health_9709");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    expect(registryCapture.registries).toHaveLength(1);
    const registry = registryCapture.registries[0]!;
    expect(registry.definitions().some((goal) => goal.id === fixtureFlatOffsetGoal.id)).toBe(false);
    registry.registerPricingGoal(fixtureFlatOffsetGoal);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.pricing.query(pricingModule.schemaSql);
    await pools.pricing.query(
      `UPDATE pricing_market_listing_inputs SET inventory_item_id='lst_7910_00000001' WHERE listing_id='lst_7910_00000001';
       INSERT INTO pricing_inventory_item_inputs
         (item_id, seller_account_id, catalog_catalog_item_id, product_id, total_quantity,
          acquisition_cost_amount, acquisition_cost_currency_code, updated_at, last_stream_version)
       VALUES ('lst_7910_00000001', 'acc_7910', 'cat_00000000', 'prod_00000000', 1,
          1.00, 'USD', '2026-10-19T00:00:00Z', 1);`,
    );
    services = comparisonTestServices(pools.pricing, { resolve: syntheticUnavailableEconomics });
    await createComparisonPolicy(pools.pricing, services, [
      {
        ...dryRunBody.rules[0]!,
        directive: {
          ...dryRunBody.rules[0]!.directive,
          anchorChain: [
            {
              source: "curve-objective",
              goalId: fixtureFlatOffsetGoal.id,
              goalVersion: 1,
              parameters: { offsetPercentiles: 10 },
            },
          ],
        },
      },
    ]);
  });
  afterAll(async () => closeMultiContextTestPools(pools));

  it("Step 10 — Show the fixture goal in Pricing Health picker and comparison", async () => {
    const data = await services.health.getHealth(comparisonAccountId, comparisonPolicyId, comparisonNow);
    expect(data?.goals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ goalId: fixtureFlatOffsetGoal.id, goalVersion: fixtureFlatOffsetGoal.version }),
      ]),
    );
    const picker = renderToStaticMarkup(createElement(GoalPicker, { goals: data!.goals! }));
    expect(picker).toContain("pricing-health-goal-picker");
    expect(picker).toContain("fixture-flat-offset");

    const runs = await services.health.compare(comparisonAccountId, comparisonPolicyId, dryRunContext);
    expect(runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ goalId: fixtureFlatOffsetGoal.id, goalVersion: fixtureFlatOffsetGoal.version }),
      ]),
    );
    const comparison = renderToStaticMarkup(
      createElement(GoalComparison, {
        branch: "comparison",
        candidates: data?.comparison ?? [],
        recommendation: { kind: "compare-goals" },
        goals: data!.goals!,
      }),
    );
    expect(comparison).toContain("pricing-health-goal-comparison");
  });
});
