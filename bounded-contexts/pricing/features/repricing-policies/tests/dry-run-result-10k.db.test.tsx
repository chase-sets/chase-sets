import { renderToStaticMarkup } from "react-dom/server";
import { t } from "@chase-sets/localization";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as pricingModule } from "../../../index";
import type { PricingApiEnv } from "../../../api";
import { createRepricingEngineRuntime } from "../../repricing-engine/tests/round-runtime-fixture";
import { createRepricingDryRunRoutes } from "../../repricing-engine/api/dry-run-route";
import type { RepricingDryRun } from "../../repricing-engine/api/dry-run";
import type { RepricingPolicyListingTrace } from "../../repricing-engine/domain/fact";
import { dryRunBody, dryRunContext, seedDryRunListings } from "../../repricing-engine/tests/dry-run-fixture";
import { DryRunResult } from "../ui/dry-run-result";
import { repricingClampCopyKeys } from "../ui/activity-copy";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required.");
const describeDb = databaseBaseUrl ? describe : describe.skip;

describeDb("integrated 10k rendering", () => {
  let pools: Readonly<Record<"pricing", PgTransactionalPool>>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["pricing"], "dry_run_render_7915");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    await resetMultiContextTestSchemas(pools);
    await pools.pricing.query(pricingModule.schemaSql);
  });
  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });
  it("renders real handler totals, nonzero clamp/tolerance/bucket SQL counts and advancing bounded samples", async () => {
    const db = pools.pricing;
    await seedDryRunListings(db, 10_000, 1_200);
    await db.query("UPDATE pricing_market_listing_inputs SET quantity_cap = right(listing_id, 4)::integer % 4 + 1");
    const directive = dryRunBody.rules[0]!.directive;
    const body = {
      ...dryRunBody,
      rules: [
        {
          conditions: [{ type: "quantity-at-least" as const, quantity: 4 }],
          directive: {
            ...directive,
            offset: { mode: "percent" as const, percent: -90 },
            floor: { mode: "absolute" as const, amount: "10" },
          },
        },
        {
          conditions: [{ type: "quantity-at-least" as const, quantity: 3 }],
          directive: { ...directive, ceiling: { mode: "absolute" as const, amount: "12" } },
        },
        {
          conditions: [{ type: "quantity-at-least" as const, quantity: 2 }],
          directive: { ...directive, maxMovePercent: 5 },
        },
        { conditions: [], directive: { ...directive, terminal: { kind: "fallback-price" as const, amount: "20" } } },
      ],
    };
    const services = createRepricingEngineRuntime({ db, eventStore: createPostgresEventStore({ pool: db }) });
    const app = new Hono<PricingApiEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", {
        sessionId: "ses_7915",
        tenantId: "tnt_identity",
        userId: "usr_7910",
        accountId: "acc_7910",
        membershipId: "mbr_7915",
        roleKey: "owner",
        permissions: ["pricing.view", "pricing.manage"],
      });
      c.set("context", dryRunContext);
      return next();
    });
    app.route("/dry-runs", createRepricingDryRunRoutes(services));
    const response = await app.request("/dry-runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(202);
    const queued = (await response.json()) as RepricingDryRun;
    await expect(
      services.processNextDryRunJob({ claimOwnerId: "synthetic-render-7915", claimTtlMs: 300_000 }),
    ).resolves.toBe(1);
    const run = (await (await app.request(`/dry-runs/${queued.dryRunId}`)).json()) as RepricingDryRun;
    expect(run.status).toBe("completed");
    const totals = (
      await db.query<{ total: number; tolerance: number }>(
        `SELECT count(*)::integer AS total,
      count(*) FILTER (WHERE skip_reason = 'within-tolerance')::integer AS tolerance
      FROM pricing_repricing_dry_run_traces WHERE dry_run_id = $1`,
        [run.dryRunId],
      )
    ).rows[0]!;
    const flags = (
      await db.query<{ key: string; count: number }>(
        `SELECT flag AS key, count(*)::integer AS count FROM pricing_repricing_dry_run_traces
      CROSS JOIN LATERAL unnest(flags) AS flag WHERE dry_run_id = $1 GROUP BY flag`,
        [run.dryRunId],
      )
    ).rows;
    const buckets = (
      await db.query<{ key: string; count: number }>(
        `SELECT width_bucket(delta_cents::numeric / (trace->>'currentPriceAmount')::numeric,
      ARRAY[-20,-10,-5,-1,1,5,10,20]::numeric[])::text AS key, count(*)::integer AS count
      FROM pricing_repricing_dry_run_traces WHERE dry_run_id = $1 AND outcome = 'changed' GROUP BY 1`,
        [run.dryRunId],
      )
    ).rows;
    expect(totals).toEqual({ total: 10_000, tolerance: 2_500 });
    expect(run.summary?.listingsEvaluated).toBe(totals.total);
    expect(run.summary?.withinTolerance).toBe(totals.tolerance);
    expect(run.summary?.flags).toEqual(Object.fromEntries(flags.map((row) => [row.key, row.count])));
    expect(run.summary?.flags).toEqual({ "floor-binding": 2_500, "ceiling-binding": 2_500, "max-move-binding": 2_500 });
    expect(run.summary?.deltaBuckets).toEqual(Object.fromEntries(buckets.map((row) => [row.key, row.count])));
    const first = (await (
      await app.request(`/dry-runs/${run.dryRunId}/traces?limit=100`)
    ).json()) as RepricingPolicyListingTrace[];
    const second = (await (
      await app.request(`/dry-runs/${run.dryRunId}/traces?limit=100&after=${first.at(-1)!.listingId}`)
    ).json()) as RepricingPolicyListingTrace[];
    expect(first).toHaveLength(100);
    expect(second).toHaveLength(100);
    expect(second[0]!.listingId > first.at(-1)!.listingId).toBe(true);
    expect(new Set([...first, ...second].map((trace) => trace.listingId)).size).toBe(200);
    const html = renderToStaticMarkup(<DryRunResult run={run} traces={first} onNext={() => undefined} />);
    expect(html).toContain("over 10,000 listings");
    expect(html).toMatch(/Listings evaluated[\s\S]*?>10,000</);
    expect(html).toMatch(/Within tolerance[\s\S]*?>2,500</);
    for (const key of ["floor", "ceiling", "maxMove"] as const) {
      expect(html).toContain(`${t(repricingClampCopyKeys[key])}</dt><dd`);
      expect(html).toMatch(new RegExp(`${t(repricingClampCopyKeys[key])}</dt><dd[^>]*>2,500</dd>`));
    }
    expect(html).toContain("Next 100 results");
    for (const bucket of buckets) expect(html).toContain(new Intl.NumberFormat("en").format(bucket.count));
    expect(html).toContain(first[0]!.listingId);
    expect(html).not.toContain(second[0]!.listingId);
  });
});
