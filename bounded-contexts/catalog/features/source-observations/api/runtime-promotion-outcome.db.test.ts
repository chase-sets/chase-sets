import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
});
