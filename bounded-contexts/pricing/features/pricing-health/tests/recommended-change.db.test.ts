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
import { readComparisonFacts } from "../read-model/queries";
import { dryRunBody, dryRunContext, seedDryRunListings } from "../../repricing-engine/tests/dry-run-fixture";
import {
  comparisonAccountId as accountId,
  comparisonPolicyId as policyId,
  comparisonNow as now,
  comparisonAdvancedTargets,
  comparisonContribution,
  comparisonSummary,
  comparisonTestServices,
  createComparisonPolicy,
  storeComparisonRun,
} from "./goal-comparison-db-fixture";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required.");
const describeDb = databaseBaseUrl ? describe : describe.skip;

describeDb("S12 over stored synthetic A1 runs through the real composition", () => {
  let pools: Readonly<Record<"pricing", PgTransactionalPool>>;
  let services: ReturnType<typeof comparisonTestServices>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["pricing"], "pricing_recommendation_9771");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.pricing.query(pricingModule.schemaSql);
    await seedDryRunListings(pools.pricing, 2, 2);
    services = comparisonTestServices(pools.pricing);
  });
  afterAll(async () => closeMultiContextTestPools(pools));

  const read = () => services.health.getHealth(accountId, policyId, now);
  async function choices() {
    const data = await read();
    return data!.goals!;
  }
  async function basis(contributions = [comparisonContribution()]) {
    return storeComparisonRun(pools.pricing, services, {
      body: dryRunBody,
      contributions,
      health: comparisonSummary(contributions),
    });
  }
  async function candidate(index = 0, profit = 3, capital = 0.1, wait = 3, contributions = [comparisonContribution()]) {
    const goal = (await choices())[index]!;
    return storeComparisonRun(pools.pricing, services, {
      body: buildCandidateBody(dryRunBody, goal),
      contributions,
      health: comparisonSummary(contributions, profit, capital, wait),
      requestedAt: "2026-10-20T00:00:02.000Z",
    });
  }

  it("checks no basis before halt and halt before a profitable candidate", async () => {
    await createComparisonPolicy(pools.pricing, services);
    await services.policies.setHalt(accountId, true, dryRunContext);
    expect((await read())?.recommendation?.kind).toBe("compute-verdict");
    await basis();
    await candidate();
    expect((await read())?.recommendation?.kind).toBe("halted");
    await services.policies.setHalt(accountId, false, dryRunContext);
    expect((await read())?.recommendation).toMatchObject({
      kind: "switch",
      delta: 1,
      waitDelta: -2,
      raised: 0,
      lowered: 0,
      held: 1,
    });
  });

  it("compares E identities, not equal cardinalities", async () => {
    await createComparisonPolicy(pools.pricing, services);
    await basis();
    await candidate(0, 3, 0.1, 3, [comparisonContribution(2)]);
    expect((await read())?.recommendation?.kind).toBe("refresh");
  });

  it("partitions currencies and refuses to compare profits across them", async () => {
    await createComparisonPolicy(pools.pricing, services);
    await pools.pricing.query(
      "UPDATE pricing_market_listing_inputs SET price_currency_code='EUR' WHERE listing_id=$1",
      [comparisonContribution(2).listingId],
    );
    const contributions = [comparisonContribution(), { ...comparisonContribution(2), currencyCode: "EUR" }];
    await basis(contributions);
    await candidate(0, 100, 1, 1, contributions);
    const data = await read();
    expect(data?.comparison?.[0]?.value).toEqual({ USD: "20.00", EUR: "20.00" });
    expect(data?.recommendation?.kind).toBe("compare-goals");
  });

  it.each(["S9", "S5", "goal id"] as const)("breaks equal S8 ties by %s", async (tieBreak) => {
    await createComparisonPolicy(pools.pricing, services);
    await basis();
    const goals = await choices();
    const capital =
      tieBreak === "S9" ? goals.map((_, index) => 0.1 + 0.1 * ((index + 1) % goals.length)) : goals.map(() => 0.1);
    const wait = tieBreak === "S5" ? goals.map((_, index) => goals.length - index) : goals.map(() => 3);
    for (let index = 0; index < goals.length; index++) await candidate(index, 3, capital[index], wait[index]);
    const expectedGoalId =
      tieBreak === "S9"
        ? goals[capital.findIndex((value) => value === Math.max(...capital))]!.goalId
        : tieBreak === "S5"
          ? goals[wait.findIndex((value) => value === Math.min(...wait))]!.goalId
          : [...goals].sort((a, b) => a.goalId.localeCompare(b.goalId))[0]!.goalId;
    expect((await read())?.recommendation).toMatchObject({
      kind: "switch",
      goalId: expectedGoalId,
    });
  });

  it("requires a minor-unit improvement; distinguishes incomplete from complete comparison", async () => {
    await createComparisonPolicy(pools.pricing, services);
    await basis();
    expect((await read())?.recommendation?.kind).toBe("compare-goals");
    for (let index = 0; index < (await choices()).length; index++) await candidate(index, 2.004);
    expect((await read())?.recommendation?.kind).toBe("no-change");
  });

  it.each(["economics", "value-at-risk", "floor-binding", "stale-curve"] as const)(
    "uses quantity-weighted current listed values for %s attention",
    async (reason) => {
      await createComparisonPolicy(pools.pricing, services);
      await pools.pricing.query("UPDATE pricing_market_listing_inputs SET quantity_cap=3 WHERE listing_id=$1", [
        comparisonContribution().listingId,
      ]);
      const base = comparisonContribution();
      const contribution = {
        ...base,
        quantity: 3,
        economics: reason === "economics" ? null : base.economics,
        risk: reason === "economics" || reason === "value-at-risk" ? ("slow" as const) : ("none" as const),
        modeled: reason === "stale-curve" ? null : base.modeled,
        modeledReason: reason === "stale-curve" ? ("stale-curve" as const) : null,
      };
      const id = await storeComparisonRun(pools.pricing, services, {
        body: dryRunBody,
        contributions: [contribution],
        health: comparisonSummary([contribution]),
        floorBinding: reason !== "stale-curve",
      });
      const facts = await readComparisonFacts(pools.pricing, { accountId, dryRunId: id, now });
      expect(facts.attentionValues.USD?.[reason]).toEqual({ value: 60, count: 1 });
      expect((await read())?.recommendation).toMatchObject({
        kind: "attention",
        reason,
        affectedListedValue: 60,
        count: 1,
      });
    },
  );

  it.each(comparisonAdvancedTargets)("emits no recommendation or runs for %s targets", async (_, rules) => {
    await createComparisonPolicy(pools.pricing, services, rules);
    expect((await read())?.recommendation).toBeUndefined();
    expect(await services.health.compare(accountId, policyId, dryRunContext)).toBeNull();
    expect((await pools.pricing.query("SELECT dry_run_id FROM pricing_repricing_dry_runs")).rows).toEqual([]);
  });

  it("emits no recommendation for a zero-policy account", async () => {
    const data = await services.health.getHealth(accountId, undefined, now);
    expect(data).toMatchObject({ branch: "create-editor", comparison: [], goals: [] });
    expect(data?.recommendation).toBeUndefined();
    expect(await services.health.compare(accountId, policyId, dryRunContext)).toBeNull();
  });
});
