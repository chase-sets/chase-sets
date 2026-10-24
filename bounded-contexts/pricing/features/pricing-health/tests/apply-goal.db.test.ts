import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { PricingApiEnv } from "../../../api";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createPostgresEventStore } from "@chase-sets/event-core-postgres";
import { module as pricingModule } from "../../../index";
import { buildCandidateBody } from "../api/goal-comparison";
import { createPricingHealthRoutes } from "../api/route";
import { PricingHealthApplyRefusedError } from "../api/services";
import {
  comparisonAccountId,
  comparisonAdvancedTargets,
  comparisonPolicyId,
  comparisonTestServices,
  createComparisonPolicy,
} from "./goal-comparison-db-fixture";
import { dryRunContext, dryRunBody, seedDryRunListings } from "../../repricing-engine/tests/dry-run-fixture";
import { hashRepricingDryRunBody } from "../../repricing-engine/api/dry-run";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const now = "2026-10-20T00:00:00.000Z";

describeDb("Pricing Health apply compared goal", () => {
  let pools: Readonly<Record<"pricing", PgTransactionalPool>>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["pricing"], "pricing_apply_goal_9772");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.pricing.query(pricingModule.schemaSql);
    await seedDryRunListings(pools.pricing, 1, 1);
  });
  afterAll(async () => closeMultiContextTestPools(pools));

  async function fixture() {
    const services = comparisonTestServices(pools.pricing);
    await createComparisonPolicy(pools.pricing, services);
    const choice = { goalId: "fixed-percentile", goalVersion: 1, parameters: { percentile: 65 } } as const;
    const body = buildCandidateBody(dryRunBody, choice);
    const queued = await services.worker.enqueueDryRun(
      { sellerAccountId: comparisonAccountId, replacingPolicyId: comparisonPolicyId, body },
      dryRunContext,
    );
    if (!queued) throw new Error("candidate enqueue refused");
    await pools.pricing.query(
      `UPDATE pricing_repricing_dry_runs SET status='completed', requested_at=$2, completed_at=$2,
       summary=$3::jsonb, health=$4::jsonb WHERE dry_run_id=$1`,
      [
        queued.dryRunId,
        now,
        JSON.stringify({
          listingsEvaluated: 1,
          outcomes: { skipped: 1 },
          skipReasons: { "within-tolerance": 1 },
          flags: {},
          deltaBuckets: {},
          withinTolerance: 1,
        }),
        JSON.stringify({
          capturedAt: now,
          population: { listingCount: 1, unitCount: 1 },
          currencies: {},
          uncategorized: { listingCount: 0, unitCount: 0, reasons: {} },
        }),
      ],
    );
    await pools.pricing.query("UPDATE pricing_repricing_dry_run_jobs SET status='completed' WHERE job_id=$1", [
      queued.dryRunId,
    ]);
    await pools.pricing.query(
      `INSERT INTO pricing_repricing_dry_run_traces
       (dry_run_id,seller_account_id,listing_id,outcome,skip_reason,flags,delta_cents,trace,health)
       VALUES ($1,$2,'lst_7910_00000001','skipped','within-tolerance','{}',0,'{}'::jsonb,$3::jsonb)`,
      [
        queued.dryRunId,
        comparisonAccountId,
        JSON.stringify({
          listingId: "lst_7910_00000001",
          quantity: 1,
          currentPriceAmount: "20.00",
          currencyCode: "USD",
          modeled: null,
          economics: null,
          risk: "unknown",
        }),
      ],
    );
    return { services, choice, body, dryRunId: queued.dryRunId };
  }

  it("revises once, preserving the body fence and every non-anchor field", async () => {
    const { services, choice, body, dryRunId } = await fixture();
    const before = await services.policies.loadOwnedRepricingPolicy(comparisonPolicyId, comparisonAccountId);
    const result = await services.health.applyGoal(
      comparisonAccountId,
      comparisonPolicyId,
      {
        dryRunId,
        targetRevision: before!.version,
        targetBodyHash: hashRepricingDryRunBody(dryRunBody),
        candidateBodyHash: hashRepricingDryRunBody(body),
        ...choice,
      },
      dryRunContext,
    );
    expect(result).toMatchObject({ policyId: comparisonPolicyId, previousRevision: 1, revision: 2, dryRunId });
    const after = await services.policies.loadOwnedRepricingPolicy(comparisonPolicyId, comparisonAccountId);
    expect(after!.state.rules[0]!.directive).toEqual(body.rules[0]!.directive);
    expect(after!.state.scope).toEqual(before!.state.scope);
    expect(after!.state.excludedListingIds).toEqual(before!.state.excludedListingIds);
    expect(after!.state.maxChangesPerDay).toBe(before!.state.maxChangesPerDay);
    expect(
      (await createPostgresEventStore({ pool: pools.pricing }).readAll()).filter(
        (event) => event.eventType === "pricing.repricing-policy.revised",
      ),
    ).toHaveLength(1);
  });

  it.each(["failed", "foreign", "halt", "floor"])("refuses %s without a revision", async (reason) => {
    const { services, dryRunId, body, choice } = await fixture();
    if (reason === "failed")
      await pools.pricing.query("UPDATE pricing_repricing_dry_runs SET status='failed' WHERE dry_run_id=$1", [
        dryRunId,
      ]);
    if (reason === "foreign")
      await pools.pricing.query(
        "UPDATE pricing_repricing_dry_runs SET replacing_policy_id='rpp_foreign' WHERE dry_run_id=$1",
        [dryRunId],
      );
    if (reason === "halt") await services.policies.setHalt(comparisonAccountId, true, dryRunContext);
    if (reason === "floor")
      await pools.pricing.query(
        "UPDATE pricing_repricing_dry_runs SET summary=jsonb_set(summary,'{flags,floor-binding}','1') WHERE dry_run_id=$1",
        [dryRunId],
      );
    const before = await services.policies.loadOwnedRepricingPolicy(comparisonPolicyId, comparisonAccountId);
    await expect(
      services.health.applyGoal(
        comparisonAccountId,
        comparisonPolicyId,
        {
          dryRunId,
          targetRevision: before!.version,
          targetBodyHash: hashRepricingDryRunBody(dryRunBody),
          candidateBodyHash: hashRepricingDryRunBody(body),
          ...choice,
        },
        dryRunContext,
      ),
    ).rejects.toBeInstanceOf(PricingHealthApplyRefusedError);
    expect((await services.policies.loadOwnedRepricingPolicy(comparisonPolicyId, comparisonAccountId))!.version).toBe(
      before!.version,
    );
  });

  it("rejects an incomplete receipt before any revision (mutant: omit completed/summary fence)", async () => {
    const { services, dryRunId, body, choice } = await fixture();
    const before = await services.policies.loadOwnedRepricingPolicy(comparisonPolicyId, comparisonAccountId);
    await pools.pricing.query("UPDATE pricing_repricing_dry_runs SET completed_at=NULL WHERE dry_run_id=$1", [
      dryRunId,
    ]);
    await expect(
      services.health.applyGoal(
        comparisonAccountId,
        comparisonPolicyId,
        {
          dryRunId,
          targetRevision: before!.version,
          targetBodyHash: hashRepricingDryRunBody(dryRunBody),
          candidateBodyHash: hashRepricingDryRunBody(body),
          ...choice,
        },
        dryRunContext,
      ),
    ).rejects.toMatchObject({ code: "candidate_incomplete" });
    expect((await services.policies.loadOwnedRepricingPolicy(comparisonPolicyId, comparisonAccountId))!.version).toBe(
      before!.version,
    );
  });

  it("rejects a body-fence mismatch without a revision (mutant: remove target hash fence)", async () => {
    const { services, dryRunId, body, choice } = await fixture();
    const before = await services.policies.loadOwnedRepricingPolicy(comparisonPolicyId, comparisonAccountId);
    await expect(
      services.health.applyGoal(
        comparisonAccountId,
        comparisonPolicyId,
        {
          dryRunId,
          targetRevision: before!.version,
          targetBodyHash: "0".repeat(64),
          candidateBodyHash: hashRepricingDryRunBody(body),
          ...choice,
        },
        dryRunContext,
      ),
    ).rejects.toMatchObject({ code: "policy_changed" });
    expect((await services.policies.loadOwnedRepricingPolicy(comparisonPolicyId, comparisonAccountId))!.version).toBe(
      before!.version,
    );
  });

  it("rejects a race after the target read without a second revision (mutant: ignore expectedVersion)", async () => {
    const { services, dryRunId, body, choice } = await fixture();
    const before = await services.policies.loadOwnedRepricingPolicy(comparisonPolicyId, comparisonAccountId);
    const original = services.policies.executeOwnedRepricingPolicy;
    vi.spyOn(services.policies, "executeOwnedRepricingPolicy").mockImplementation(async (input) => {
      await original({
        ...input,
        command: {
          ...dryRunBody,
          type: "ReviseRepricingPolicy",
          name: "Racing revision",
          revisedAt: now,
        },
      });
      throw new Error("synthetic optimistic concurrency race");
    });
    await expect(
      services.health.applyGoal(
        comparisonAccountId,
        comparisonPolicyId,
        {
          dryRunId,
          targetRevision: before!.version,
          targetBodyHash: hashRepricingDryRunBody(dryRunBody),
          candidateBodyHash: hashRepricingDryRunBody(body),
          ...choice,
        },
        dryRunContext,
      ),
    ).rejects.toMatchObject({ code: "policy_changed" });
    expect((await services.policies.loadOwnedRepricingPolicy(comparisonPolicyId, comparisonAccountId))!.version).toBe(
      before!.version + 1,
    );
  });

  it("refuses apply when the manage permission is lost without mutating the DB (mutant: remove route permission guard)", async () => {
    const { services } = await fixture();
    const before = await services.policies.loadOwnedRepricingPolicy(comparisonPolicyId, comparisonAccountId);
    const app = new Hono<PricingApiEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", { accountId: comparisonAccountId, permissions: ["pricing.view"] } as never);
      c.set("context", dryRunContext as never);
      return next();
    });
    app.route("/health", createPricingHealthRoutes(services.health));
    const response = await app.request(`/health/${comparisonPolicyId}/apply-goal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        dryRunId: "run",
        targetRevision: before!.version,
        targetBodyHash: "0".repeat(64),
        candidateBodyHash: "0".repeat(64),
        goalId: "fixed-percentile",
        goalVersion: 1,
        parameters: { percentile: 65 },
      }),
    });
    expect(response.status).toBe(403);
    expect((await services.policies.loadOwnedRepricingPolicy(comparisonPolicyId, comparisonAccountId))!.version).toBe(
      before!.version,
    );
  });

  it("refuses an Adoption Gate selection without a revision (mutant: trust request goal identity)", async () => {
    const { services, dryRunId, body } = await fixture();
    const before = await services.policies.loadOwnedRepricingPolicy(comparisonPolicyId, comparisonAccountId);
    await expect(
      services.health.applyGoal(
        comparisonAccountId,
        comparisonPolicyId,
        {
          dryRunId,
          targetRevision: before!.version,
          targetBodyHash: hashRepricingDryRunBody(dryRunBody),
          candidateBodyHash: hashRepricingDryRunBody(body),
          goalId: "fixed-percentile",
          goalVersion: 2,
          parameters: { percentile: 65 },
        },
        dryRunContext,
      ),
    ).rejects.toMatchObject({ code: "adoption_gate_refused" });
    expect((await services.policies.loadOwnedRepricingPolicy(comparisonPolicyId, comparisonAccountId))!.version).toBe(
      before!.version,
    );
  });

  it.each(comparisonAdvancedTargets)("proves the DB advanced-editor branch for %s targets", async (_, rules) => {
    const services = comparisonTestServices(pools.pricing);
    await createComparisonPolicy(pools.pricing, services, rules);
    await expect(services.health.getHealth(comparisonAccountId, comparisonPolicyId, now)).resolves.toMatchObject({
      branch: "advanced-editor",
      comparison: [],
      goals: [],
    });
  });

  it("proves the DB zero-policy create-editor branch", async () => {
    const services = comparisonTestServices(pools.pricing);
    await expect(services.health.getHealth(comparisonAccountId, undefined, now)).resolves.toMatchObject({
      branch: "create-editor",
      comparison: [],
      goals: [],
    });
  });
});
