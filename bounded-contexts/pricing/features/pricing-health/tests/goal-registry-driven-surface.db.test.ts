import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as pricingModule } from "../../../index";
import { buildCandidateBody } from "../api/goal-comparison";
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
    expect(data?.goals?.map(({ goalId, goalVersion }) => `${goalId}@${goalVersion}`)).toEqual(
      expect.arrayContaining([
        "fixed-percentile@1",
        "target-horizon@1",
        "profit-per-day@1",
        "hold-value@1",
        "cash-target@1",
      ]),
    );
    expect(data?.goals?.every((goal) => goal.lifecycle === "selectable")).toBe(true);

    const edited = data!.goals!.map((goal) => ({
      goalId: goal.goalId,
      goalVersion: goal.goalVersion,
      parameters: {
        ...goal.parameters,
        ...(goal.goalId === "fixed-percentile" ? { percentile: 66 } : {}),
      },
    }));
    const runs = await services.health.compare(comparisonAccountId, comparisonPolicyId, dryRunContext, edited);
    expect(runs).toHaveLength(data!.goals!.length);
    const fixed = runs!.find((run) => run.goalId === "fixed-percentile")!;
    const rows = await pools.pricing.query<{ body: unknown; body_hash: string }>(
      "SELECT body, body_hash FROM pricing_repricing_dry_runs WHERE dry_run_id=$1",
      [fixed.dryRunId],
    );
    expect(rows.rows[0]?.body).toMatchObject({
      rules: [{ directive: { anchorChain: [{ parameters: { percentile: 66 } }] } }],
    });
    expect(rows.rows[0]?.body_hash).not.toBe(null);
  });
});
