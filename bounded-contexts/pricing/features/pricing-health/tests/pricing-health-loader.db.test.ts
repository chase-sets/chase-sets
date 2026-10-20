import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createPostgresEventStore, withPgTransaction, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createPolicyRuntime } from "@chase-sets/platform-policy/runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as pricingModule } from "../../../index";
import type { PricingApiEnv } from "../../../api";
import { createPricingHealthServices } from "../api/services";
import { createPricingHealthRoutes } from "../api/route";
import { createRepricingDryRunServices, hashRepricingDryRunBody } from "../../repricing-engine/api/dry-run";
import { REPRICING_ENGINE_LAUNCH_POLICY_VALUE } from "../../repricing-engine/domain/policy";
import { dryRunBody, dryRunContext, seedDryRunListings } from "../../repricing-engine/tests/dry-run-fixture";
import {
  projectSyntheticPricingHealthPolicy,
  seedSyntheticPricingHealthInputs,
} from "../../../support/runtime-support/pricing-health-browser-seed";
import { gradingRulesVersion } from "../../forecast-ledger/domain/grade-ledger";
import { FORECAST_LEDGER_LAUNCH_POLICY_VALUE } from "../../forecast-ledger/domain/policy";
import { listForecastGrades } from "../../forecast-ledger/read-model/queries";
import { loader } from "../../../routes/marketplace/account-desk-pricing-health";
import { createRepricingPolicyRuntime } from "../../repricing-policies/api/runtime";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const listingId = "lst_7910_00000001";
const now = "2026-10-19T10:00:00.000Z";
const rulesVersion = gradingRulesVersion(FORECAST_LEDGER_LAUNCH_POLICY_VALUE);

describeDb("Pricing Health real loader and grade queries", () => {
  let pools: Readonly<Record<"pricing", PgTransactionalPool>>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["pricing"], "pricing_health_9770");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.pricing.query(pricingModule.schemaSql);
    await seedDryRunListings(pools.pricing, 1, 1);
  });
  afterAll(async () => closeMultiContextTestPools(pools));

  function services() {
    const eventStore = createPostgresEventStore({ pool: pools.pricing });
    const worker = createRepricingDryRunServices(pools.pricing, async () => REPRICING_ENGINE_LAUNCH_POLICY_VALUE, {
      resolve: async () => {
        throw new Error("The listing has no inventory item; no Economics call is expected.");
      },
    });
    return {
      worker,
      health: createPricingHealthServices({
        db: pools.pricing,
        policies: createPolicyRuntime({ eventStore, db: pools.pricing }),
        repricingEngine: worker,
        forecastLedger: { listGoalAdoptions: async () => [] },
        repricingPolicies: createRepricingPolicyRuntime({
          eventStore,
          db: pools.pricing,
          goalAdoptions: async () => [],
        }),
      }),
    };
  }

  async function policy(id: `rpp_${string}` = "rpp_synthetic_health", accountId: `acc_${string}` = "acc_7910") {
    const body = {
      ...dryRunBody,
      rules: dryRunBody.rules.map((rule) => ({
        ...rule,
        directive: {
          ...rule.directive,
          anchorChain: [
            {
              source: "curve-objective" as const,
              goalId: "fixed-percentile",
              goalVersion: 1,
              parameters: { percentile: 50 },
            },
          ],
          tolerance: { mode: "absolute" as const, amount: "100000.00" },
        },
      })),
    };
    const runtime = createRepricingPolicyRuntime({
      eventStore: createPostgresEventStore({ pool: pools.pricing }),
      db: pools.pricing,
      goalAdoptions: async () => [],
    });
    await runtime.commandHandler({
      streamId: runtime.streamIdForPolicy(id),
      context: dryRunContext,
      command: {
        ...body,
        type: "CreateRepricingPolicy",
        policyId: id,
        accountId,
        name: "Synthetic health policy",
        createdAt: now,
      },
    });
    await expect(
      projectSyntheticPricingHealthPolicy(pools.pricing, { policyId: id, accountId: "acc_foreign_probe" }),
    ).rejects.toThrow("refuses");
    await projectSyntheticPricingHealthPolicy(pools.pricing, { policyId: id, accountId });
    return body;
  }

  it("requires explicit selection for multiple active owned policies and never falls back from a foreign ID", async () => {
    const { health } = services();
    expect(await health.getHealth("acc_7910", undefined, now)).toMatchObject({
      policies: [],
      target: null,
      health: null,
    });
    await policy();
    await policy("rpp_second");
    await policy("rpp_foreign", "acc_foreign");
    expect(await health.getHealth("acc_7910", undefined, now)).toMatchObject({ target: null, health: null });
    expect(await health.getHealth("acc_7910", "rpp_foreign", now)).toBeNull();
    expect(await health.compute("acc_7910", "rpp_foreign", dryRunContext)).toBeNull();
    await pools.pricing.query("UPDATE pricing_repricing_policies SET status='paused' WHERE policy_id='rpp_second'");
    expect(await health.getHealth("acc_7910", undefined, now)).toMatchObject({
      target: { policyId: "rpp_synthetic_health" },
    });
    expect(await health.getHealth("acc_7910", "rpp_second", now)).toBeNull();
  });

  it("mounted loader reads a real completed worker summary, old/null stays null and a revised body invalidates it", async () => {
    const body = await policy();
    const fixture = await seedSyntheticPricingHealthInputs(pools.pricing, { accountId: "acc_7910", listingId, now });
    const { worker, health } = services();
    expect(await health.getHealth("acc_7910", undefined, now)).toMatchObject({ health: null, run: null });
    const run = (await health.compute("acc_7910", "rpp_synthetic_health", dryRunContext))!;
    await pools.pricing.query("UPDATE pricing_repricing_dry_runs SET requested_at=$2 WHERE dry_run_id=$1", [
      run.dryRunId,
      now,
    ]);
    expect(run.bodyHash).toBe(hashRepricingDryRunBody(body));
    expect(await worker.processNextDryRunJob({ claimOwnerId: "synthetic-health", claimTtlMs: 300_000 })).toBe(1);
    const read = (await health.getHealth("acc_7910", undefined, now))!;
    expect(read.health?.currencies.USD?.modeledValueAmount).toBe(fixture.expected.modeledValueAmount);
    expect(read.health?.currencies.USD?.expectedSales.listingCount).toBe(0.6321205588285577);
    expect(read.health?.currencies.USD?.expectedSales.valueAmount).toBe(fixture.expected.expectedSalesValueAmount);
    const app = new Hono<PricingApiEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", { accountId: "acc_7910", permissions: ["pricing.view"] } as never);
      return next();
    });
    app.route("/api/marketplace/account/pricing-health", createPricingHealthRoutes(health));
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).pathname === "/api/auth/session")
        return Response.json({ actor: { accountId: "acc_7910", permissions: ["pricing.view"] } });
      return app.fetch(request);
    });
    try {
      const response = await loader({
        request: new Request("http://localhost/account/desk/pricing-health"),
        params: {},
        context: {},
      } as never);
      expect(response).toMatchObject({
        data: { health: read.health, run: { dryRunId: run.dryRunId }, canCompute: false },
      });
    } finally {
      vi.unstubAllGlobals();
    }
    await pools.pricing.query("UPDATE pricing_repricing_dry_runs SET health=NULL WHERE dry_run_id=$1", [run.dryRunId]);
    expect(await health.getHealth("acc_7910", undefined, now)).toMatchObject({ health: null, run: null });
    await pools.pricing.query("UPDATE pricing_repricing_dry_runs SET health=$2::jsonb WHERE dry_run_id=$1", [
      run.dryRunId,
      JSON.stringify(read.health),
    ]);
    const runtime = createRepricingPolicyRuntime({
      eventStore: createPostgresEventStore({ pool: pools.pricing }),
      db: pools.pricing,
      goalAdoptions: async () => [],
    });
    await runtime.executeOwnedRepricingPolicy({
      policyId: "rpp_synthetic_health",
      accountId: "acc_7910",
      context: dryRunContext,
      command: {
        ...body,
        type: "ReviseRepricingPolicy",
        name: "Synthetic health policy",
        maxChangesPerDay: 101,
        revisedAt: now,
      },
    });
    // Leave the policy projection unchanged: only the folded current body may select the verdict.
    expect(await health.getHealth("acc_7910", undefined, now)).toMatchObject({ health: null, run: null });
  });

  it("selects incumbent goal/version, latest closed day per kind/horizon/model under current rules, with 29/30 disclosure", async () => {
    await policy();
    await seedSyntheticPricingHealthInputs(pools.pricing, { accountId: "acc_7910", listingId, now });
    const { health } = services();
    await pools.pricing.query(`INSERT INTO pricing_forecast_grades
      SELECT goal_id, goal_version, role, forecast_kind, model, horizon_days, closed_on - 1,
        rules_version, input_version, jsonb_set(grade, '{soldShare}', '0.99'), graded_at
      FROM pricing_forecast_grades`);
    const read = (await health.getHealth("acc_7910", undefined, now))!;
    expect(read.grades).toHaveLength(1);
    expect(read.grades[0]).toMatchObject({
      goalId: "fixed-percentile",
      goalVersion: 1,
      closedOn: "2026-10-19",
      status: "disclosed",
      values: { soldShare: 0.6, expectedShare: 0.7, brier: 0.2, baseRateBrier: 0.24 },
    });
    await pools.pricing.query(
      `UPDATE pricing_forecast_grades SET grade=jsonb_set(grade, '{count}', '29') WHERE closed_on='2026-10-19'`,
    );
    const hidden = (await health.getHealth("acc_7910", undefined, now))!.grades;
    expect(hidden[0]).not.toHaveProperty("values");
    expect(JSON.stringify(hidden)).not.toMatch(/count|soldShare|expectedShare|brier|deciles/i);
    await withPgTransaction(pools.pricing, async (db) => {
      for (const change of [
        "role='shadow'",
        "goal_version=2",
        "goal_id='target-horizon'",
        "closed_on='2026-10-20'",
        "rules_version='old-rules'",
        "horizon_days=90",
      ]) {
        await db.query("SAVEPOINT synthetic_control");
        await db.query(`UPDATE pricing_forecast_grades SET ${change} WHERE closed_on='2026-10-19'`);
        const rows = await listForecastGrades(db, {
          goalId: "fixed-percentile",
          goalVersion: 1,
          role: "incumbent",
          rulesVersion,
          latest: { closedOnOrBefore: "2026-10-19", horizonsDays: [14, 21, 28], limit: 100 },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]?.closedOn).toBe("2026-10-18");
        await db.query("ROLLBACK TO SAVEPOINT synthetic_control");
      }
    });
    await pools.pricing.query(`INSERT INTO pricing_forecast_grades
      SELECT goal_id, goal_version, role, 'condition-rate', model, 14, closed_on,
        rules_version, input_version, grade, graded_at FROM pricing_forecast_grades WHERE closed_on='2026-10-19'`);
    await pools.pricing.query(`INSERT INTO pricing_forecast_grades
      SELECT goal_id, goal_version, role, forecast_kind, 'synthetic-other-model', horizon_days, closed_on,
        rules_version, input_version, grade, graded_at FROM pricing_forecast_grades
      WHERE closed_on='2026-10-18' AND forecast_kind='curve'`);
    const dimensions = (await health.getHealth("acc_7910", undefined, now))!.grades;
    expect(dimensions).toHaveLength(3);
    expect(dimensions).toContainEqual(
      expect.objectContaining({ forecastKind: "condition-rate", horizonDays: 14, closedOn: "2026-10-19" }),
    );
    expect(dimensions).toContainEqual(
      expect.objectContaining({ forecastKind: "curve", model: "synthetic-other-model", closedOn: "2026-10-18" }),
    );
  });
});
