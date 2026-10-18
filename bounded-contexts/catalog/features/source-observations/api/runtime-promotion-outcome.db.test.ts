import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { module as catalogModule } from "../../../index";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import type { CatalogItemServices } from "../../catalog-items/api/runtime";
import type { ReferenceDataServices } from "../../reference-data/api/runtime";
import { createSourceObservationRuntime } from "./runtime";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["catalog"] as const;

const context = {
  tenantId: "tnt_identity" as never,
  audit: {
    performedByUserId: "usr_identity_system" as never,
    forAccountId: "acc_identity_system" as never,
  },
};

describeDb("source observation promotion outcome db", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      contextNames,
      "catalog_source_observation_promotion_outcome",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.catalog.query(catalogModule.schemaSql);
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  it("reads a terminal promotion failure from the appended durable event instead of the mutable job row", async () => {
    const deps = {
      db: pools.catalog,
      eventStore: createPostgresEventStore({ pool: pools.catalog }),
      checkpointStore: createPostgresProjectionStore({ db: pools.catalog }),
    } as CatalogRuntimeDeps;
    const runtime = createSourceObservationRuntime(deps, {} as CatalogItemServices, {} as ReferenceDataServices);
    const job = await runtime.enqueueBulkReviewJob({
      action: "promote",
      observationIds: ["obs_missing"],
      context,
    });

    await expect(
      runtime.processNextBulkReviewJob({
        claimOwnerId: "promotion-outcome-db-proof",
        claimTtlMs: 120_000,
      }),
    ).resolves.toBe(1);

    const outcome = await runtime.getBulkReviewPromotionOutcome(job.jobId);
    expect(outcome).toMatchObject({
      jobId: job.jobId,
      terminalState: "failed",
      requested: 1,
      promoted: 0,
      skipped: 0,
      failed: 1,
      outcomes: [
        {
          observationId: "obs_missing",
          status: "failed",
          reason: "Source observation was not found.",
        },
      ],
    });

    await pools.catalog.query(
      `UPDATE catalog_source_observation_bulk_review_jobs
       SET result = NULL,
           status = 'running',
           completed_at = NULL
       WHERE job_id = $1`,
      [job.jobId],
    );

    await expect(runtime.getBulkReviewPromotionOutcome(job.jobId)).resolves.toEqual(outcome);
    const events = await pools.catalog.query<{ snapshot: { status: string; result: unknown } }>(
      `SELECT snapshot
       FROM catalog_source_observation_bulk_review_job_events
       WHERE job_id = $1
       ORDER BY sequence ASC`,
      [job.jobId],
    );
    expect(events.rows.at(-1)?.snapshot).toMatchObject({
      status: "completed",
      result: { requested: 1, failed: 1 },
    });
  });

  it("fails every retired TCGplayer import and reapply job without retry or provider resolution", async () => {
    const deps = {
      db: pools.catalog,
      eventStore: createPostgresEventStore({ pool: pools.catalog }),
      checkpointStore: createPostgresProjectionStore({ db: pools.catalog }),
    } as CatalogRuntimeDeps;
    const runtime = createSourceObservationRuntime(deps, {} as CatalogItemServices, {} as ReferenceDataServices);
    const providerRegistry = runtime.providerAdapterRegistry;
    const providerLookup = vi.spyOn(providerRegistry, "get");
    const externalFetch = vi.fn(async () => {
      throw new Error("retired TCGplayer jobs must not call a provider");
    });
    vi.stubGlobal("fetch", externalFetch);
    const now = new Date().toISOString();
    const progress = { phase: "queued", completed: 0, total: 1, currentName: null, status: null };
    const eventContext = {
      tenantId: "tnt_identity",
      audit: { performedByUserId: "usr_identity_system", forAccountId: "acc_identity_system" },
    };
    const jobs = [
      ["retired-import-queued", "import", "queued", null],
      ["retired-import-claimed", "import", "running", "2020-01-01T00:00:00Z"],
      ["retired-reapply-queued", "reapply", "queued", null],
      ["retired-reapply-claimed", "reapply", "running", "2020-01-01T00:00:00Z"],
    ] as const;

    try {
      for (const [jobId, action, status, claimedUntil] of jobs) {
        await pools.catalog.query(
          `INSERT INTO catalog_source_observation_integration_durable_jobs
             (job_id, job_kind, status, payload, progress, result, error_message, event_context,
              claim_owner_id, claimed_until, attempt_count, next_eligible_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, NULL, NULL, $6::jsonb,
                   $7, $8::timestamptz, 0, now(), $9::timestamptz, $9::timestamptz)`,
          [
            jobId,
            action,
            status,
            JSON.stringify({ action, scope: { provider: "tcgplayer", language: "en" } }),
            JSON.stringify(progress),
            JSON.stringify(eventContext),
            claimedUntil ? "stale-owner" : null,
            claimedUntil,
            now,
          ],
        );
      }
      await pools.catalog.query(
        `INSERT INTO catalog_source_observation_integration_work_units
           (job_id, unit_id, unit_kind, state, payload, result, error_message, attempt_count, created_at, updated_at)
         VALUES ('retired-reapply-queued', 'retired-reapply-unit', 'reapply', 'queued', $1::jsonb, NULL, NULL, 0, now(), now())`,
        [JSON.stringify({ observationId: "retired-observation" })],
      );

      for (let index = 0; index < jobs.length; index += 1) {
        await expect(
          runtime.processNextIntegrationJob({ claimOwnerId: `retired-proof-${index}`, claimTtlMs: 60_000 }),
        ).resolves.toBe(1);
      }

      const persisted = await pools.catalog.query<{
        job_id: string;
        status: string;
        attempt_count: number;
        error_message: string | null;
        claim_owner_id: string | null;
      }>(
        `SELECT job_id, status, attempt_count, error_message, claim_owner_id
           FROM catalog_source_observation_integration_durable_jobs
          WHERE job_id = ANY($1::text[])
          ORDER BY job_id`,
        [jobs.map(([jobId]) => jobId)],
      );
      expect(persisted.rows).toHaveLength(jobs.length);
      expect(persisted.rows).toEqual(
        jobs.map(([jobId]) => ({
          job_id: jobId,
          status: "failed",
          attempt_count: 1,
          error_message: "TCGplayer server transport is retired; use the browser handoff.",
          claim_owner_id: null,
        })),
      );
      const unit = await pools.catalog.query(
        `SELECT state, attempt_count, error_message, claim_owner_id
           FROM catalog_source_observation_integration_work_units
          WHERE job_id = 'retired-reapply-queued' AND unit_id = 'retired-reapply-unit'`,
      );
      expect(unit.rows).toEqual([
        {
          state: "failed",
          attempt_count: 1,
          error_message: "TCGplayer server transport is retired; use the browser handoff.",
          claim_owner_id: null,
        },
      ]);
      expect(providerLookup).not.toHaveBeenCalled();
      expect(externalFetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      await pools.catalog.query(
        `DELETE FROM catalog_source_observation_integration_durable_jobs WHERE job_id = ANY($1::text[])`,
        [jobs.map(([jobId]) => jobId)],
      );
    }
  });
});
