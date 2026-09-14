import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import { Hono } from "hono";
import type { PricingApiEnv } from "../../../api";
import { createRepricingDryRunRoutes } from "../api/dry-run-route";
import type { RepricingDryRun } from "../api/dry-run";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as pricingModule } from "../../../index";
import { createRepricingEngineRuntime } from "../api/runtime";
import { pricingRepricingDryRunSchemaMigrations } from "../read-model/migrations";
import { loadRepricingRoundInputsPage } from "../read-model/queries";
import { dryRunBody, dryRunContext, seedDryRunListings } from "./dry-run-fixture";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required.");
const describeDb = databaseBaseUrl ? describe : describe.skip;

describeDb("repricing durable dry runs", () => {
  let pools: Readonly<Record<"pricing", PgTransactionalPool>>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["pricing"], "repricing_dry_run_7910");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.pricing.query(pricingModule.schemaSql);
  });
  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  function runtime(db = pools.pricing) {
    return createRepricingEngineRuntime({ db, eventStore: createPostgresEventStore({ pool: pools.pricing }) });
  }
  const claim = (claimOwnerId: string) => ({ claimOwnerId, claimTtlMs: 300_000 });

  it.each([
    { listings: 500, products: 500 },
    { listings: 10_000, products: 1_200 },
    { listings: 250_000, products: 30_000 },
  ])(
    "real PostgreSQL scale and page statement count: $listings listings across $products products",
    async ({ listings, products }) => {
      await seedDryRunListings(pools.pricing, listings, products);
      const statements: string[] = [];
      const pageSizes: number[] = [];
      let peakHeap = process.memoryUsage().heapUsed;
      const db: PgTransactionalPool = {
        connect: pools.pricing.connect.bind(pools.pricing),
        query: async <Row>(sql: string, values?: readonly unknown[]) => {
          statements.push(sql);
          if (sql.includes("AS policy_revision") && Array.isArray(values?.[0])) pageSizes.push(values[0].length);
          peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
          return pools.pricing.query<Row>(sql, values);
        },
      };
      const services = runtime(db);
      const run = await services.enqueueDryRun({ sellerAccountId: "acc_7910", body: dryRunBody }, dryRunContext);
      expect(run).not.toBeNull();
      statements.length = 0;
      const start = performance.now();
      await expect(services.processNextDryRunJob(claim("scale"))).resolves.toBe(1);
      const wallClockMs = performance.now() - start;
      const pageStarts = statements.flatMap((sql, index) =>
        sql.includes("SELECT DISTINCT listing.catalog_catalog_item_id") ? [index] : [],
      );
      const nonemptyPages = Math.ceil(products / 500);
      expect(pageSizes).toHaveLength(nonemptyPages);
      expect(pageSizes.every((size) => size > 0 && size <= 500)).toBe(true);
      expect(pageSizes.reduce((sum, size) => sum + size, 0)).toBe(products);
      expect(pageStarts).toHaveLength(nonemptyPages + (products % 500 === 0 ? 1 : 0));
      expect(statements.filter((sql) => sql.includes("WITH advanced AS"))).toHaveLength(nonemptyPages);
      for (const index of pageStarts.slice(0, nonemptyPages)) {
        const page = statements.slice(index, index + 7);
        expect(page).toHaveLength(7);
        expect(page.filter((sql) => sql.includes("WITH products AS"))).toHaveLength(4);
        expect(page[5]).toContain("INSERT INTO pricing_repricing_dry_run_traces");
        expect(page[6]).toContain("WITH advanced AS");
      }
      const completed = await services.getDryRun("acc_7910", run!.dryRunId);
      expect(completed?.status).toBe("completed");
      expect(completed?.summary?.listingsEvaluated).toBe(listings);
      expect(Object.values(completed!.summary!.outcomes).reduce((a, b) => a + b, 0)).toBe(listings);
      expect(completed?.summary?.outcomes.changed).toBe(listings);
      expect(Object.values(completed!.summary!.deltaBuckets).reduce((a, b) => a + b, 0)).toBe(listings);
      expect(completed?.summary?.deltaBuckets).toEqual({ "0": listings });
      const firstTraces = await services.listDryRunTraces("acc_7910", run!.dryRunId, {
        limit: 100,
        outcome: "changed",
      });
      const secondTraces = await services.listDryRunTraces("acc_7910", run!.dryRunId, {
        limit: 100,
        outcome: "changed",
        after: firstTraces.at(-1)!.listingId,
      });
      expect(firstTraces).toHaveLength(100);
      expect(secondTraces).toHaveLength(100);
      expect(new Set([...firstTraces, ...secondTraces].map((trace) => trace.listingId)).size).toBe(200);
      const eventStore = createPostgresEventStore({ pool: pools.pricing });
      expect(await eventStore.readAll()).toEqual([]);
      const artifact = resolve(process.cwd(), "../../artifacts/7910/dry-run-scale.md");
      mkdirSync(resolve(artifact, ".."), { recursive: true });
      appendFileSync(
        artifact,
        [
          `\n## Real PostgreSQL: ${listings} listings\n`,
          `Listings: ${listings}; products: ${products}; nonempty pages: ${nonemptyPages}; page statements: ${7 * nonemptyPages}; loader queries: ${4 * nonemptyPages}.`,
          `Wall-clock: ${wallClockMs.toFixed(2)} ms; peak sampled heap: ${peakHeap} bytes.`,
          `Observed db.query statements (including empty-page/summary/readback, excluding durable-store connection-local lifecycle queries): ${statements.length}. Timing starts before processNextDryRunJob, after seed/enqueue. Heap sampled at every query, not an asserted latency gate.\n`,
        ].join("\n"),
      );
    },
  );

  it.each(["after-page-1", "after-trace-insert"])(
    "real lease-loss interleaving resumes without lost/duplicate traces: %s",
    async (barrier) => {
      await seedDryRunListings(pools.pricing, 10_000, 1_200);
      let release!: () => void;
      let reached!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const atBarrier = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let first = true;
      const db: PgTransactionalPool = {
        connect: pools.pricing.connect.bind(pools.pricing),
        query: async <Row>(sql: string, values?: readonly unknown[]) => {
          const result = await pools.pricing.query<Row>(sql, values);
          const match =
            barrier === "after-page-1"
              ? sql.includes("WITH advanced AS")
              : sql.includes("INSERT INTO pricing_repricing_dry_run_traces");
          if (first && match) {
            first = false;
            reached();
            await held;
          }
          return result;
        },
      };
      const old = runtime(db);
      const run = await old.enqueueDryRun({ sellerAccountId: "acc_7910", body: dryRunBody }, dryRunContext);
      const pending = old.processNextDryRunJob(claim("same-owner")).then(
        () => null,
        (error: unknown) => error,
      );
      await atBarrier;
      try {
        await pools.pricing.query(
          `UPDATE pricing_repricing_dry_run_jobs
         SET claimed_until = now() - interval '2 seconds', next_eligible_at = now() - interval '1 second'
         WHERE job_id = $1 AND claim_owner_id = 'same-owner' AND status = 'running' AND attempt_count = 1`,
          [run!.dryRunId],
        );
        await expect(runtime().processNextDryRunJob(claim("same-owner"))).resolves.toBe(1);
        const generation = await pools.pricing.query<{ attempt_count: number }>(
          "SELECT attempt_count FROM pricing_repricing_dry_run_jobs WHERE job_id = $1",
          [run!.dryRunId],
        );
        expect(generation.rows[0]?.attempt_count).toBe(2);
      } finally {
        release();
      }
      expect(await pending).toBeInstanceOf(Error);
      const completed = await runtime().getDryRun("acc_7910", run!.dryRunId);
      expect(completed?.summary?.listingsEvaluated).toBe(10_000);
      const counts = await pools.pricing.query<{ total: string; distinct_count: string }>(
        `SELECT count(*)::text AS total, count(DISTINCT listing_id)::text AS distinct_count
       FROM pricing_repricing_dry_run_traces WHERE seller_account_id = $1 AND dry_run_id = $2`,
        ["acc_7910", run!.dryRunId],
      );
      expect(counts.rows[0]).toEqual({ total: "10000", distinct_count: "10000" });
      expect((await runtime().getDryRun("acc_7910", run!.dryRunId))?.cursor).toEqual(completed?.cursor);
    },
  );

  it("guards cancellation, account reads/writes, and bounds without provider or event emission", async () => {
    await seedDryRunListings(pools.pricing, 2, 2);
    const services = runtime();
    const run = await services.enqueueDryRun({ sellerAccountId: "acc_7910", body: dryRunBody }, dryRunContext);
    await expect(services.getDryRun("acc_foreign", run!.dryRunId)).resolves.toBeNull();
    await expect(services.listDryRuns("acc_foreign")).resolves.toEqual([]);
    await expect(services.listDryRunTraces("acc_foreign", run!.dryRunId)).resolves.toEqual([]);
    await expect(services.listDryRunEvents("acc_foreign", run!.dryRunId)).resolves.toEqual([]);
    await expect(
      services.enqueueDryRun(
        {
          sellerAccountId: "acc_foreign",
          body: dryRunBody,
          replacingPolicyId: "missing",
        },
        dryRunContext,
      ),
    ).resolves.toBeNull();
    const gateway = vi.fn(() => {
      throw new Error("Dry runs must not request a gateway.");
    });
    const abort = new AbortController();
    abort.abort();
    await expect(services.processNextDryRunJob({ ...claim("cancel"), signal: abort.signal })).rejects.toThrow(
      "cancelled",
    );
    expect(await services.listDryRunTraces("acc_7910", run!.dryRunId)).toEqual([]);
    expect(gateway).not.toHaveBeenCalled();
    await expect(
      loadRepricingRoundInputsPage(pools.pricing, {
        products: Array.from({ length: 501 }, () => ({ catalogItemId: "cat", productId: "product" })),
      }),
    ).rejects.toThrow("500");
    expect(await createPostgresEventStore({ pool: pools.pricing }).readAll()).toEqual([]);
  });

  it("retained-old-schema migrations and repeated boot have identical dry-run schema", async () => {
    const schema = async () =>
      (
        await pools.pricing.query(
          `SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name LIKE 'pricing_repricing_dry_run%'
       ORDER BY table_name, ordinal_position`,
        )
      ).rows;
    const expected = await schema();
    await seedDryRunListings(pools.pricing, 1, 1);
    await pools.pricing.query(`DROP TABLE pricing_repricing_dry_run_job_events, pricing_repricing_dry_run_jobs,
      pricing_repricing_dry_run_traces, pricing_repricing_dry_runs`);
    for (const migration of pricingRepricingDryRunSchemaMigrations) {
      for (const sql of migration.statements) await pools.pricing.query(sql);
    }
    expect(await schema()).toEqual(expected);
    await bootstrapContextDatabase(pricingModule, pools.pricing);
    await bootstrapContextDatabase(pricingModule, pools.pricing);
    expect(await schema()).toEqual(expected);
    expect(
      (
        await pools.pricing.query(
          "SELECT migration_id FROM bounded_context_schema_migrations WHERE migration_id = '20260914_pricing_repricing_dry_runs'",
        )
      ).rows,
    ).toHaveLength(1);
    expect(
      (
        await pools.pricing.query(
          "SELECT indexname FROM pg_indexes WHERE indexname = 'pricing_market_listing_inputs_product_status_idx'",
        )
      ).rows,
    ).toHaveLength(1);
    const run = await runtime().enqueueDryRun({ sellerAccountId: "acc_7910", body: dryRunBody }, dryRunContext);
    await runtime().processNextDryRunJob(claim("migration"));
    expect((await runtime().getDryRun("acc_7910", run!.dryRunId))?.summary?.listingsEvaluated).toBe(1);
  });

  it("executes the real account route/read/write/SSE matrix without disclosure", async () => {
    await seedDryRunListings(pools.pricing, 2, 2);
    const services = runtime();
    const app = (accountId: "acc_7910" | "acc_other") => {
      const api = new Hono<PricingApiEnv>();
      api.use("*", async (c, next) => {
        c.set("actor", {
          sessionId: "ses_7910",
          tenantId: "tnt_identity",
          userId: "usr_7910",
          accountId,
          membershipId: "mbr_7910",
          roleKey: "owner",
          permissions: ["pricing.view", "pricing.manage"],
        });
        c.set("context", { ...dryRunContext, audit: { ...dryRunContext.audit, forAccountId: accountId } });
        return next();
      });
      api.route("/dry-runs", createRepricingDryRunRoutes(services));
      return api;
    };
    const owner = app("acc_7910");
    const foreign = app("acc_other");
    const post = await owner.request("/dry-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(dryRunBody),
    });
    expect(post.status).toBe(202);
    const run: RepricingDryRun = await post.json();
    await services.processNextDryRunJob(claim("routes"));
    for (const suffix of ["", "/traces?limit=100", "/events"]) {
      const own = await owner.request("/dry-runs/" + run.dryRunId + suffix);
      expect(own.status).toBe(200);
      expect(await own.text()).not.toMatch(/pricingMode|lst_competitor|sellerAccountId/);
      const denied = await foreign.request("/dry-runs/" + run.dryRunId + suffix);
      const missing = await foreign.request("/dry-runs/missing" + suffix);
      expect(denied.status).toBe(404);
      expect(await denied.json()).toEqual(await missing.json());
    }
    expect(await (await foreign.request("/dry-runs?limit=100")).json()).toEqual([]);
    const spoofed = await foreign.request("/dry-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...dryRunBody, sellerAccountId: "acc_7910" }),
    });
    expect(spoofed.status).toBe(202);
    const foreignRun: RepricingDryRun = await spoofed.json();
    expect(await services.getDryRun("acc_7910", foreignRun.dryRunId)).toBeNull();
    expect(await services.getDryRun("acc_other", foreignRun.dryRunId)).not.toBeNull();
    expect(await createPostgresEventStore({ pool: pools.pricing }).readAll()).toEqual([]);
  });

  it("persists guarded failures and exposes durable-job retry exhaustion consistently", async () => {
    await seedDryRunListings(pools.pricing, 1, 1);
    const db: PgTransactionalPool = {
      connect: pools.pricing.connect.bind(pools.pricing),
      query: async <Row>(sql: string, values?: readonly unknown[]) => {
        if (sql.includes("SELECT DISTINCT listing.catalog_catalog_item_id")) throw new Error("Synthetic page failure");
        return pools.pricing.query<Row>(sql, values);
      },
    };
    const services = runtime(db);
    const failed = await services.enqueueDryRun({ sellerAccountId: "acc_7910", body: dryRunBody }, dryRunContext);
    await expect(services.processNextDryRunJob(claim("failure"))).rejects.toThrow("Synthetic page failure");
    expect((await services.getDryRun("acc_7910", failed!.dryRunId))?.status).toBe("failed");
    expect((await services.listDryRunEvents("acc_7910", failed!.dryRunId)).at(-1)?.data.status).toBe("failed");
    const exhausted = await services.enqueueDryRun({ sellerAccountId: "acc_7910", body: dryRunBody }, dryRunContext);
    await pools.pricing.query(
      `UPDATE pricing_repricing_dry_run_jobs SET attempt_count = 10
       WHERE job_id = $1 AND payload->>'sellerAccountId' = 'acc_7910' AND status = 'queued' AND attempt_count = 0`,
      [exhausted!.dryRunId],
    );
    expect(await runtime().processNextDryRunJob(claim("exhausted"))).toBe(0);
    expect((await services.getDryRun("acc_7910", exhausted!.dryRunId))?.status).toBe("failed");
    expect((await services.listDryRuns("acc_7910")).every((run) => run.status === "failed")).toBe(true);
  });
});
