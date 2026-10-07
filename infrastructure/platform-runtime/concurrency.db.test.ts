import {
  createCheckpointReadinessRecorder,
  createProjectionGroupWorkerRunner,
  createWorkerRunnerLeaseName,
  createWorkerRunnerLoop,
} from "./worker";
import { createProjectionWakeSchedulerRunners } from "./projection-wake-scheduler";
import type { ProjectorHandler } from "@chase-sets/event-core/projector";
import {
  attachReadConsistencyMiddleware,
  bootstrapContextDatabase,
  loadProjectionGroupGeneration,
  resetProjectionGroup,
  syncProjectionGroup,
} from "@chase-sets/bounded-context-runtime";
import { Hono } from "hono";
import {
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  CHASE_SETS_READ_TARGET_CONTEXT_HEADER,
  encodeFreshWriteReceipt,
} from "@chase-sets/http/responses";
import { defineBoundedContextModule } from "@chase-sets/bounded-context-module";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPostgresEventStore,
  type PgQueryFunction,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMountedContextTestRuntime,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import {
  bootstrapPlatformControlPlane,
  createPostgresEvidenceWindowRegistration,
  createPostgresPlatformControlPlane,
  platformControlPlaneSchemaSql,
  reapStaleProjectionOperations,
} from "./control-plane";
import { createPostgresDurableJobStore, durableJobSchemaSql } from "./durable-job-store";
import { createPostgresDurableJobWorkUnitStore, durableJobWorkUnitSchemaSql } from "./durable-job-work-units";
import { createPostgresUcpIdempotencyStore } from "./ucp";
import { createProjectionWakeSchedulerRunners } from "./projection-wake-scheduler";
import {
  createPostgresWorkSignalStore,
  platformWorkSignalStoreSchemaSql,
  type ProjectionWakeIntentEnqueuedEvent,
} from "./work-signal-store";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;

const durableJobTables = {
  jobsTable: "test_durable_jobs",
  eventsTable: "test_durable_job_events",
  notifyChannel: "test_durable_job_events",
} as const;

const durableWorkUnitTables = {
  ...durableJobTables,
  workUnitsTable: "test_durable_job_work_units",
} as const;

type JobPayload = Readonly<{ task: string }>;
type JobProgress = Readonly<{ completed: number }>;
type JobResult = Readonly<{ ok: boolean }>;
type UnitPayload = Readonly<{ item: string }>;
type UnitResult = Readonly<{ ok: boolean }>;

describe("platform runtime Postgres concurrency guards", () => {
  let pools: Readonly<Record<"platform", PgTransactionalPool>>;

  beforeAll(async () => {
    if (!adminDatabaseUrl) {
      throw new Error("TEST_DATABASE_URL is required for platform-runtime concurrency DB tests.");
    }

    const databaseUrls = createMultiContextTestDatabaseUrls(adminDatabaseUrl, ["platform"], "platform_concurrency");
    await ensureMultiContextTestDatabases(adminDatabaseUrl, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.platform.query(platformControlPlaneSchemaSql);
    await pools.platform.query(durableJobSchemaSql(durableJobTables));
    await pools.platform.query(durableJobWorkUnitSchemaSql(durableWorkUnitTables));
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  it("lets only one durable worker claim a queued job", async () => {
    const store = createPostgresDurableJobStore<JobPayload, JobProgress, JobResult>(pools.platform, durableJobTables);
    await store.enqueue({
      jobId: "job_double_claim",
      jobKind: "import",
      payload: { task: "sync" },
      progress: { completed: 0 },
    });

    const claims = await Promise.all([
      store.claimNext({ claimOwnerId: "worker_a", claimTtlMs: 30_000 }),
      store.claimNext({ claimOwnerId: "worker_b", claimTtlMs: 30_000 }),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(new Set(claims.filter(Boolean).map((claim) => claim?.claimOwnerId)).size).toBe(1);

    const job = await store.get("job_double_claim");
    expect(job?.status).toBe("running");
    expect(job?.claimOwnerId).toBe(claims.find(Boolean)?.claimOwnerId);
  });

  it("keeps a cancelled durable-job parent terminal when its claimed work unit finishes", async () => {
    const jobStore = createPostgresDurableJobStore<JobPayload, JobProgress, JobResult>(
      pools.platform,
      durableJobTables,
    );
    const unitStore = createPostgresDurableJobWorkUnitStore<
      JobPayload,
      JobProgress,
      JobResult,
      UnitPayload,
      UnitResult
    >(pools.platform, durableWorkUnitTables, { workflowName: "catalog-import" });

    await jobStore.enqueue({
      jobId: "job_cancelled_during_unit",
      jobKind: "import",
      payload: { task: "sync" },
      progress: { completed: 0 },
    });
    await unitStore.enqueue({
      jobId: "job_cancelled_during_unit",
      units: [{ unitId: "unit_1", payload: { item: "card_1" } }],
    });

    const { claim } = await unitStore.claimNext({
      claimOwnerId: "worker_a",
      claimTtlMs: 30_000,
      workflowMaxActiveClaims: 1,
      jobMaxActiveClaims: 1,
    });
    expect(claim?.unit.unitId).toBe("unit_1");

    await expect(
      jobStore.cancel({
        jobId: "job_cancelled_during_unit",
        progress: { completed: 0 },
        errorMessage: "Operator cancelled job.",
      }),
    ).resolves.toMatchObject({ status: "failed", errorMessage: "Operator cancelled job." });

    await expect(
      unitStore.recordTerminal({
        jobId: "job_cancelled_during_unit",
        unitId: "unit_1",
        claimOwnerId: claim!.claimOwnerId,
        claimToken: claim!.claimToken,
        state: "completed",
        unitResult: { ok: true },
        parentProgress: { completed: 1 },
        parentResult: { ok: true },
        completeJob: true,
      }),
    ).resolves.toBe("parent-already-terminal");

    await expect(jobStore.get("job_cancelled_during_unit")).resolves.toMatchObject({
      status: "failed",
      progress: { completed: 0 },
      result: null,
      errorMessage: "Operator cancelled job.",
    });
    await expect(unitStore.listForJob("job_cancelled_during_unit")).resolves.toMatchObject([
      { unitId: "unit_1", state: "completed", result: { ok: true } },
    ]);
  });

  it("rejects stale durable terminals and allows an expired claim to be reclaimed", async () => {
    const store = createPostgresDurableJobStore<JobPayload, JobProgress, JobResult>(pools.platform, durableJobTables);
    await store.enqueue({
      jobId: "job_expired_claim",
      jobKind: "import",
      payload: { task: "sync" },
      progress: { completed: 0 },
    });
    const firstClaim = await store.claimNext({ claimOwnerId: "worker_a", claimTtlMs: 30_000 });
    expect(firstClaim?.claimOwnerId).toBe("worker_a");

    await pools.platform.query(
      `UPDATE ${durableJobTables.jobsTable}
       SET claimed_until = now() - interval '1 second',
           next_eligible_at = now() - interval '1 second'
       WHERE job_id = $1`,
      ["job_expired_claim"],
    );

    await expect(
      store.complete({
        jobId: "job_expired_claim",
        claimOwnerId: "worker_a",
        progress: { completed: 1 },
        result: { ok: true },
      }),
    ).resolves.toBe(false);
    await expect(
      store.fail({
        jobId: "job_expired_claim",
        claimOwnerId: "worker_a",
        progress: { completed: 1 },
        errorMessage: "expired",
      }),
    ).resolves.toBe(false);

    const reclaimed = await store.claimNext({ claimOwnerId: "worker_b", claimTtlMs: 30_000 });
    expect(reclaimed?.jobId).toBe("job_expired_claim");
    expect(reclaimed?.claimOwnerId).toBe("worker_b");
  });

  it("delays stale poison durable jobs, quarantines them at the cap, and lets younger jobs proceed", async () => {
    const store = createPostgresDurableJobStore<JobPayload, JobProgress, JobResult>(pools.platform, durableJobTables, {
      maxAttempts: 2,
      retryBackoffBaseMs: 60_000,
      retryBackoffMaxMs: 60_000,
    });
    await store.enqueue({
      jobId: "job_poison",
      jobKind: "import",
      payload: { task: "poison" },
      progress: { completed: 0 },
    });
    await store.enqueue({
      jobId: "job_younger",
      jobKind: "import",
      payload: { task: "younger" },
      progress: { completed: 0 },
    });

    const firstClaim = await store.claimNext({ claimOwnerId: "worker_a", claimTtlMs: 30_000 });
    expect(firstClaim?.jobId).toBe("job_poison");
    expect(firstClaim?.attemptCount).toBe(1);

    await pools.platform.query(
      `UPDATE ${durableJobTables.jobsTable}
       SET claimed_until = now() - interval '1 second'
       WHERE job_id = $1`,
      ["job_poison"],
    );

    const youngerClaim = await store.claimNext({ claimOwnerId: "worker_b", claimTtlMs: 30_000 });
    expect(youngerClaim?.jobId).toBe("job_younger");

    const delayedPoison = await store.get("job_poison");
    expect(delayedPoison?.status).toBe("running");
    expect(delayedPoison?.claimOwnerId).toBe("worker_a");
    expect(new Date(delayedPoison?.nextEligibleAt ?? 0).getTime()).toBeGreaterThan(Date.now());

    await pools.platform.query(
      `UPDATE ${durableJobTables.jobsTable}
       SET claimed_until = now() - interval '1 second',
           next_eligible_at = now() - interval '1 second',
           attempt_count = 2
       WHERE job_id = $1`,
      ["job_poison"],
    );
    await store.complete({
      jobId: "job_younger",
      claimOwnerId: "worker_b",
      progress: { completed: 1 },
      result: { ok: true },
    });

    await expect(store.claimNext({ claimOwnerId: "worker_c", claimTtlMs: 30_000 })).resolves.toBeNull();
    const quarantined = await store.get("job_poison");

    expect(quarantined).toMatchObject({
      status: "failed",
      claimOwnerId: null,
      errorMessage: "Durable job retry attempts exhausted.",
    });
    expect(quarantined?.completedAt).not.toBeNull();
  });

  it("lets only one durable work-unit worker claim the same unit", async () => {
    const jobStore = createPostgresDurableJobStore<JobPayload, JobProgress, JobResult>(
      pools.platform,
      durableJobTables,
    );
    const unitStore = createPostgresDurableJobWorkUnitStore<
      JobPayload,
      JobProgress,
      JobResult,
      UnitPayload,
      UnitResult
    >(pools.platform, durableWorkUnitTables, { workflowName: "catalog-import" });

    await jobStore.enqueue({
      jobId: "job_unit_double_claim",
      jobKind: "import",
      payload: { task: "sync" },
      progress: { completed: 0 },
    });
    await unitStore.enqueue({
      jobId: "job_unit_double_claim",
      units: [{ unitId: "unit_1", payload: { item: "card_1" } }],
    });

    const outcomes = await Promise.all([
      unitStore.claimNext({
        claimOwnerId: "worker_a",
        claimTtlMs: 30_000,
        workflowMaxActiveClaims: 10,
        jobMaxActiveClaims: 10,
      }),
      unitStore.claimNext({
        claimOwnerId: "worker_b",
        claimTtlMs: 30_000,
        workflowMaxActiveClaims: 10,
        jobMaxActiveClaims: 10,
      }),
    ]);

    const claims = outcomes.map((outcome) => outcome.claim).filter(Boolean);
    expect(claims).toHaveLength(1);
    expect(outcomes.map((outcome) => outcome.outcome.reason)).toContain("claimed");
    expect(
      (await unitStore.listForJob("job_unit_double_claim")).filter((unit) => unit.state === "running"),
    ).toHaveLength(1);
  });

  it("serializes platform lease acquisition and preserves fencing across steals", async () => {
    const controlPlane = createPostgresPlatformControlPlane(pools.platform);

    const leases = await Promise.all([
      controlPlane.acquireLease({ leaseName: "projection:catalog", ownerId: "worker_a", ttlMs: 30_000 }),
      controlPlane.acquireLease({ leaseName: "projection:catalog", ownerId: "worker_b", ttlMs: 30_000 }),
    ]);
    const acquired = leases.filter(Boolean);
    expect(acquired).toHaveLength(1);
    const firstLease = acquired[0]!;

    await pools.platform.query(
      `UPDATE platform_control_leases
       SET expires_at = now() - interval '1 second'
       WHERE lease_name = $1`,
      [firstLease.leaseName],
    );

    const stolen = await controlPlane.acquireLease({
      leaseName: "projection:catalog",
      ownerId: "worker_c",
      ttlMs: 30_000,
    });
    expect(stolen?.ownerId).toBe("worker_c");
    expect(BigInt(stolen?.fencingToken ?? "0")).toBeGreaterThan(BigInt(firstLease.fencingToken));
    await expect(controlPlane.renewLease(firstLease, 30_000)).resolves.toBe(false);
  });

  it("charges projection operation attempts at claim time, backs off reclaims, and quarantines at the cap", async () => {
    const controlPlane = createPostgresPlatformControlPlane(pools.platform);
    const enqueued = await controlPlane.enqueueProjectionOperation({
      operationKind: "retry-blocked-stream",
      contextName: "discovery",
      projectionKey: "discovery-item-detail-projection:catalog:v2",
      streamId: "stream_poison",
    });

    const claimed = await controlPlane.claimProjectionOperation({
      ownerId: "worker_a",
      claimTtlMs: 30_000,
      maxAttempts: 2,
    });
    expect(claimed?.operationId).toBe(enqueued.operationId);
    expect(claimed?.attemptCount).toBe(1);

    // Simulate a worker that died without a terminal write: the claim expires
    // but the backoff horizon set at claim time still blocks a hot reclaim.
    await pools.platform.query(
      `UPDATE platform_projection_operations
       SET claimed_until = now() - interval '1 second'
       WHERE operation_id = $1`,
      [enqueued.operationId],
    );
    await expect(
      controlPlane.claimProjectionOperation({ ownerId: "worker_b", claimTtlMs: 30_000, maxAttempts: 2 }),
    ).resolves.toBeNull();

    await pools.platform.query(
      `UPDATE platform_projection_operations
       SET next_eligible_at = now() - interval '1 second'
       WHERE operation_id = $1`,
      [enqueued.operationId],
    );
    const reclaimed = await controlPlane.claimProjectionOperation({
      ownerId: "worker_b",
      claimTtlMs: 30_000,
      maxAttempts: 2,
    });
    expect(reclaimed?.operationId).toBe(enqueued.operationId);
    expect(reclaimed?.attemptCount).toBe(2);
    expect(reclaimed?.startedAt).toBe(claimed?.startedAt);

    // Second death: the attempt budget is exhausted, so the sweep dead-letters
    // the operation instead of reclaiming it forever.
    await pools.platform.query(
      `UPDATE platform_projection_operations
       SET claimed_until = now() - interval '1 second',
           next_eligible_at = now() - interval '1 second'
       WHERE operation_id = $1`,
      [enqueued.operationId],
    );
    await expect(
      controlPlane.claimProjectionOperation({ ownerId: "worker_c", claimTtlMs: 30_000, maxAttempts: 2 }),
    ).resolves.toBeNull();

    const quarantined = await controlPlane.getProjectionOperation(enqueued.operationId);
    expect(quarantined?.state).toBe("failed");
    expect(quarantined?.error).toMatchObject({ code: "attempts_exhausted" });
    expect(quarantined?.completedAt).not.toBeNull();
  });

  it("requeues a retryable projection operation failure with backoff so younger operations proceed", async () => {
    const controlPlane = createPostgresPlatformControlPlane(pools.platform);
    const head = await controlPlane.enqueueProjectionOperation({
      operationKind: "retry-blocked-stream",
      contextName: "discovery",
      projectionKey: "discovery-search-item-projection:catalog:v5",
      streamId: "stream_head",
    });
    const younger = await controlPlane.enqueueProjectionOperation({
      operationKind: "retry-blocked-stream",
      contextName: "identity",
      projectionKey: "identity-consent-projection:identity:v1",
      streamId: "stream_younger",
    });

    const claimed = await controlPlane.claimProjectionOperation({ ownerId: "worker_a", claimTtlMs: 30_000 });
    expect(claimed?.operationId).toBe(head.operationId);

    await expect(
      controlPlane.failProjectionOperation({
        operationId: head.operationId,
        ownerId: "worker_a",
        fencingToken: claimed?.claimFencingToken ?? "0",
        error: { message: "Projection runner lease 'projection-group:x' is already active." },
        retryable: true,
      }),
    ).resolves.toBe(true);

    const requeued = await controlPlane.getProjectionOperation(head.operationId);
    expect(requeued?.state).toBe("queued");
    expect(requeued?.claimOwnerId).toBeNull();
    expect(new Date(requeued?.nextEligibleAt ?? 0).getTime()).toBeGreaterThan(Date.now());
    expect(requeued?.error).toMatchObject({
      message: "Projection runner lease 'projection-group:x' is already active.",
    });

    // The requeued head operation is parked behind its backoff, so the
    // younger operation is claimable instead of starving behind it.
    const next = await controlPlane.claimProjectionOperation({ ownerId: "worker_a", claimTtlMs: 30_000 });
    expect(next?.operationId).toBe(younger.operationId);
  });

  it("reclaims a ghost running operation whose claim expiry was cleared", async () => {
    // Issue #4496 ghost shape observed on staging: state='running',
    // attempt_count=0, an old started_at, and no claim expiry. Both the
    // reclaim and dead-letter sweeps compare `claimed_until <= now()`, which
    // is NULL for this row, so without the explicit NULL arm the ghost is
    // invisible forever while every younger operation queues behind it.
    const controlPlane = createPostgresPlatformControlPlane(pools.platform);
    const ghost = await controlPlane.enqueueProjectionOperation({
      operationKind: "retry-blocked-stream",
      contextName: "discovery",
      projectionKey: "discovery-item-detail-projection:catalog:v2",
      streamId: "stream_ghost",
    });
    await pools.platform.query(
      `UPDATE platform_projection_operations
       SET state = 'running',
           claim_owner_id = 'pod_dead',
           claim_fencing_token = 1,
           claimed_until = NULL,
           attempt_count = 0,
           next_eligible_at = now() - interval '1 hour',
           requested_at = now() - interval '5 hours',
           started_at = now() - interval '4 hours',
           updated_at = now() - interval '4 hours'
       WHERE operation_id = $1`,
      [ghost.operationId],
    );
    const younger = await controlPlane.enqueueProjectionOperation({
      operationKind: "retry-blocked-stream",
      contextName: "discovery",
      projectionKey: "discovery-search-item-projection:catalog:v5",
      streamId: "stream_younger",
    });

    const reclaimed = await controlPlane.claimProjectionOperation({ ownerId: "worker_b", claimTtlMs: 30_000 });
    expect(reclaimed?.operationId).toBe(ghost.operationId);
    expect(reclaimed?.state).toBe("running");
    expect(reclaimed?.attemptCount).toBe(1);
    expect(reclaimed?.claimOwnerId).toBe("worker_b");
    expect(reclaimed?.claimedUntil).not.toBeNull();

    const next = await controlPlane.claimProjectionOperation({ ownerId: "worker_b", claimTtlMs: 30_000 });
    expect(next?.operationId).toBe(younger.operationId);
  });

  it("dead-letters a ghost running operation that already exhausted its attempts", async () => {
    const controlPlane = createPostgresPlatformControlPlane(pools.platform);
    const ghost = await controlPlane.enqueueProjectionOperation({
      operationKind: "retry-blocked-stream",
      contextName: "discovery",
      projectionKey: "discovery-item-detail-projection:catalog:v2",
      streamId: "stream_ghost_exhausted",
    });
    await pools.platform.query(
      `UPDATE platform_projection_operations
       SET state = 'running',
           claim_owner_id = 'pod_dead',
           claim_fencing_token = 5,
           claimed_until = NULL,
           attempt_count = 5,
           next_eligible_at = now() - interval '1 hour',
           started_at = now() - interval '4 hours',
           updated_at = now() - interval '4 hours'
       WHERE operation_id = $1`,
      [ghost.operationId],
    );

    await expect(
      controlPlane.claimProjectionOperation({ ownerId: "worker_b", claimTtlMs: 30_000, maxAttempts: 5 }),
    ).resolves.toBeNull();

    const quarantined = await controlPlane.getProjectionOperation(ghost.operationId);
    expect(quarantined?.state).toBe("failed");
    expect(quarantined?.error).toMatchObject({ code: "attempts_exhausted" });
    expect(quarantined?.claimOwnerId).toBeNull();
    expect(quarantined?.completedAt).not.toBeNull();
  });

  it("never reaps or reclaims an actively claimed running operation", async () => {
    const controlPlane = createPostgresPlatformControlPlane(pools.platform);
    const enqueued = await controlPlane.enqueueProjectionOperation({
      operationKind: "retry-blocked-stream",
      contextName: "discovery",
      projectionKey: "discovery-item-detail-projection:catalog:v2",
      streamId: "stream_live",
    });
    const claimed = await controlPlane.claimProjectionOperation({ ownerId: "worker_a", claimTtlMs: 60_000 });
    expect(claimed?.operationId).toBe(enqueued.operationId);

    await expect(reapStaleProjectionOperations(pools.platform)).resolves.toBe(0);
    await expect(
      controlPlane.claimProjectionOperation({ ownerId: "worker_b", claimTtlMs: 60_000 }),
    ).resolves.toBeNull();

    const untouched = await controlPlane.getProjectionOperation(enqueued.operationId);
    expect(untouched?.state).toBe("running");
    expect(untouched?.claimOwnerId).toBe("worker_a");
    expect(untouched?.attemptCount).toBe(1);
  });

  it("converges existing ghost operations at control-plane bootstrap without manual SQL", async () => {
    const controlPlane = createPostgresPlatformControlPlane(pools.platform);
    const seedOperation = async (streamId: string) =>
      controlPlane.enqueueProjectionOperation({
        operationKind: "retry-blocked-stream",
        contextName: "discovery",
        projectionKey: "discovery-item-detail-projection:catalog:v2",
        streamId,
      });

    // A genuinely live claim must survive bootstrap untouched. Claim it
    // before seeding the ghost shapes so the claim deterministically picks it.
    const live = await seedOperation("stream_live_bootstrap");
    const liveClaim = await controlPlane.claimProjectionOperation({
      ownerId: "worker_live",
      claimTtlMs: 120_000,
      operationKinds: ["retry-blocked-stream"],
    });
    expect(liveClaim?.operationId).toBe(live.operationId);

    // The staging #4496 ghost: running, cleared claim expiry, zero attempts.
    const ghost = await seedOperation("stream_ghost_bootstrap");
    await pools.platform.query(
      `UPDATE platform_projection_operations
       SET state = 'running',
           claim_owner_id = 'pod_dead',
           claim_fencing_token = 1,
           claimed_until = NULL,
           attempt_count = 0,
           started_at = now() - interval '4 hours',
           updated_at = now() - interval '4 hours'
       WHERE operation_id = $1`,
      [ghost.operationId],
    );
    // A worker died after claiming: the claim expiry lapsed hours ago.
    const expired = await seedOperation("stream_expired_bootstrap");
    await pools.platform.query(
      `UPDATE platform_projection_operations
       SET state = 'running',
           claim_owner_id = 'pod_dead',
           claim_fencing_token = 1,
           claimed_until = now() - interval '3 hours',
           attempt_count = 1,
           started_at = now() - interval '3 hours',
           updated_at = now() - interval '3 hours'
       WHERE operation_id = $1`,
      [expired.operationId],
    );
    // A cancel request that lost its executor must terminate, not requeue.
    const cancelRequested = await seedOperation("stream_cancel_bootstrap");
    await pools.platform.query(
      `UPDATE platform_projection_operations
       SET state = 'cancel_requested',
           claim_owner_id = 'pod_dead',
           claim_fencing_token = 1,
           claimed_until = NULL,
           attempt_count = 1,
           started_at = now() - interval '2 hours',
           updated_at = now() - interval '2 hours'
       WHERE operation_id = $1`,
      [cancelRequested.operationId],
    );
    await bootstrapPlatformControlPlane(pools.platform);

    const reapedGhost = await controlPlane.getProjectionOperation(ghost.operationId);
    expect(reapedGhost?.state).toBe("queued");
    expect(reapedGhost?.attemptCount).toBe(1);
    expect(reapedGhost?.claimOwnerId).toBeNull();
    expect(reapedGhost?.claimedUntil).toBeNull();
    expect(reapedGhost?.error).toMatchObject({ code: "stale_claim_reaped" });
    expect(new Date(reapedGhost?.nextEligibleAt ?? 0).getTime()).toBeGreaterThan(Date.now());

    const reapedExpired = await controlPlane.getProjectionOperation(expired.operationId);
    expect(reapedExpired?.state).toBe("queued");
    expect(reapedExpired?.attemptCount).toBe(2);
    expect(reapedExpired?.claimOwnerId).toBeNull();

    const terminatedCancel = await controlPlane.getProjectionOperation(cancelRequested.operationId);
    expect(terminatedCancel?.state).toBe("cancelled");
    expect(terminatedCancel?.completedAt).not.toBeNull();

    const untouchedLive = await controlPlane.getProjectionOperation(live.operationId);
    expect(untouchedLive?.state).toBe("running");
    expect(untouchedLive?.claimOwnerId).toBe("worker_live");
    expect(untouchedLive?.attemptCount).toBe(1);

    // The reap publishes status events so operators watching the operation
    // observe the transition instead of a silent state jump.
    const ghostEvents = await controlPlane.listProjectionOperationEvents(ghost.operationId);
    expect(ghostEvents.length).toBeGreaterThanOrEqual(2);
    expect(ghostEvents.at(-1)?.operation.state).toBe("queued");
  });

  it("lets only one scheduled runner claimant advance the cadence row", async () => {
    const controlPlane = createPostgresPlatformControlPlane(pools.platform);

    const claims = await Promise.all([
      controlPlane.claimScheduledRunner({ runnerName: "catalog-sync", intervalMs: 60_000 }),
      controlPlane.claimScheduledRunner({ runnerName: "catalog-sync", intervalMs: 60_000 }),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it("reserves UCP idempotency keys before execution under concurrent callers", async () => {
    const store = createPostgresUcpIdempotencyStore<Readonly<{ ok: boolean }>>(pools.platform);
    const createdAt = new Date().toISOString();

    const reservations = await Promise.all([
      store.reserve({
        key: "complete_checkout:buyer:key_1",
        requestHash: "hash_a",
        createdAt,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      store.reserve({
        key: "complete_checkout:buyer:key_1",
        requestHash: "hash_a",
        createdAt,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    ]);

    expect(reservations.map((reservation) => reservation.outcome).sort()).toEqual(["pending", "reserved"]);
    const reserved = reservations.find((reservation) => reservation.outcome === "reserved");
    expect(reserved?.record.status).toBe("pending");

    await store.complete({ ...reserved!.record, response: { ok: true } });
    await expect(
      store.reserve({
        key: "complete_checkout:buyer:key_1",
        requestHash: "hash_a",
        createdAt: new Date().toISOString(),
      }),
    ).resolves.toMatchObject({ outcome: "completed", record: { response: { ok: true } } });
    await expect(
      store.reserve({
        key: "complete_checkout:buyer:key_1",
        requestHash: "hash_b",
        createdAt: new Date().toISOString(),
      }),
    ).resolves.toMatchObject({ outcome: "conflict" });
  });

  it("upgrades a pre-existing operations table missing the retry columns without failing bootstrap", async () => {
    // Reproduces issue #4599's staging bootstrap failure: the table already exists
    // from a prior deploy (so CREATE TABLE IF NOT EXISTS is a no-op) and is missing
    // attempt_count / next_eligible_at, yet holds terminal, queued, and ghost-running
    // rows. Re-applying the schema SQL must add the columns and build the claimable
    // index instead of raising 42703 ("column next_eligible_at does not exist").
    await pools.platform.query(`
      DROP TABLE IF EXISTS platform_projection_operation_events CASCADE;
      DROP TABLE IF EXISTS platform_projection_operations CASCADE;
      CREATE TABLE platform_projection_operations (
        operation_id text PRIMARY KEY,
        operation_kind text NOT NULL,
        state text NOT NULL,
        context_name text NOT NULL,
        projection_name text NULL,
        projection_key text NULL,
        stream_id text NULL,
        requested_by_user_id text NULL,
        requested_by_account_id text NULL,
        claim_owner_id text NULL,
        claim_fencing_token bigint NULL,
        claimed_until timestamptz NULL,
        event_sequence integer NOT NULL DEFAULT 0,
        progress jsonb NOT NULL DEFAULT '{}'::jsonb,
        result jsonb NULL,
        error jsonb NULL,
        requested_at timestamptz NOT NULL,
        started_at timestamptz NULL,
        updated_at timestamptz NOT NULL,
        completed_at timestamptz NULL
      );
      INSERT INTO platform_projection_operations
        (operation_id, operation_kind, state, context_name, requested_at, updated_at, started_at)
      VALUES
        ('op_failed', 'rebuild-context', 'failed', 'catalog', now() - interval '2 hours', now(), NULL),
        ('op_queued', 'rebuild-context', 'queued', 'catalog', now() - interval '1 hour', now(), NULL),
        ('op_ghost', 'rebuild-projection-group', 'running', 'catalog', now() - interval '3 hours', now(), now() - interval '3 hours');
    `);

    const upgradedAtOrAfter = new Date();
    await expect(pools.platform.query(platformControlPlaneSchemaSql)).resolves.toBeDefined();

    const rows = await pools.platform.query(
      `SELECT operation_id, attempt_count, next_eligible_at
       FROM platform_projection_operations
       ORDER BY operation_id`,
    );
    expect(rows.rows).toHaveLength(3);
    for (const row of rows.rows as unknown as ReadonlyArray<{
      attempt_count: number;
      next_eligible_at: Date;
    }>) {
      // Existing rows converge on a full attempt budget (0) and an immediate horizon
      // so queued/ghost operations become claimable right away.
      expect(Number(row.attempt_count)).toBe(0);
      expect(new Date(row.next_eligible_at).getTime()).toBeLessThanOrEqual(upgradedAtOrAfter.getTime() + 1_000);
    }

    const claimableIndex = await pools.platform.query(
      `SELECT 1 FROM pg_indexes WHERE indexname = 'platform_projection_operations_claimable_idx'`,
    );
    expect(claimableIndex.rowCount).toBe(1);

    // The upgraded ghost row (running, no claim expiry) must actually be
    // claimable on the executor's first pass — before the NULL-claim arm it
    // matched neither the reclaim nor the dead-letter sweep and sat `running`
    // forever (issue #4496 ghost operations).
    const controlPlane = createPostgresPlatformControlPlane(pools.platform);
    const reclaimedGhost = await controlPlane.claimProjectionOperation({ ownerId: "worker_a", claimTtlMs: 30_000 });
    expect(reclaimedGhost?.operationId).toBe("op_ghost");
    expect(reclaimedGhost?.state).toBe("running");
    expect(reclaimedGhost?.attemptCount).toBe(1);
    expect(reclaimedGhost?.claimedUntil).not.toBeNull();
  });

  it("coalesces concurrent wake enqueues at the greatest required position", async () => {
    await pools.platform.query(platformWorkSignalStoreSchemaSql);
    const store = createPostgresWorkSignalStore(pools.platform);
    const commonIntent = {
      sourceContextName: "catalog",
      targetContextName: "checkout",
      projectionName: "checkout-session-projection",
      checkpointKey: "checkout.session-projection:catalog:v1",
      priorityLane: "hot" as const,
      origin: "relay" as const,
    };

    await Promise.all([
      store.enqueueProjectionWakeIntent({
        ...commonIntent,
        requiredPosition: 41n,
        requiredCursor: "catalog:41",
      }),
      store.enqueueProjectionWakeIntent({
        ...commonIntent,
        requiredPosition: 73n,
        requiredCursor: "catalog:73",
      }),
    ]);

    const persisted = await pools.platform.query(
      `SELECT count(*)::integer AS row_count,
              min(required_position)::text AS required_position,
              min(required_cursor) AS required_cursor
       FROM platform_projection_wake_intents`,
    );
    expect(persisted.rows[0]).toMatchObject({
      row_count: 1,
      required_position: "73",
      required_cursor: "catalog:73",
    });
  });

  it("satisfies checkpoint waiters exactly at the ready-position boundary", async () => {
    await pools.platform.query(platformWorkSignalStoreSchemaSql);
    const store = createPostgresWorkSignalStore(pools.platform);
    const commonWaiter = {
      checkpointKey: "checkout.session-projection:catalog:v1",
      sourceContextName: "catalog",
      targetContextName: "checkout",
      projectionName: "checkout-session-projection",
      origin: "api-wait" as const,
    };

    await store.addCheckpointWaiter({
      ...commonWaiter,
      waiterId: "waiter_at_boundary_before_ready",
      requiredPosition: 42n,
    });
    await store.addCheckpointWaiter({
      ...commonWaiter,
      waiterId: "waiter_above_boundary_before_ready",
      requiredPosition: 43n,
    });
    await store.recordCheckpointReady({
      checkpointKey: commonWaiter.checkpointKey,
      sourceContextName: commonWaiter.sourceContextName,
      targetContextName: commonWaiter.targetContextName,
      projectionName: commonWaiter.projectionName,
      readyPosition: 42n,
      readyCursor: "catalog:42",
    });

    const atBoundaryAfterReady = await store.addCheckpointWaiter({
      ...commonWaiter,
      waiterId: "waiter_at_boundary_after_ready",
      requiredPosition: 42n,
    });
    const aboveBoundaryAfterReady = await store.addCheckpointWaiter({
      ...commonWaiter,
      waiterId: "waiter_above_boundary_after_ready",
      requiredPosition: 43n,
    });
    const persisted = await pools.platform.query(
      `SELECT waiter_id, satisfied_at IS NOT NULL AS satisfied
       FROM platform_projection_checkpoint_waiters
       ORDER BY waiter_id`,
    );

    expect(atBoundaryAfterReady.satisfiedAt).not.toBeNull();
    expect(aboveBoundaryAfterReady.satisfiedAt).toBeNull();
    expect(persisted.rows).toEqual([
      { waiter_id: "waiter_above_boundary_after_ready", satisfied: false },
      { waiter_id: "waiter_above_boundary_before_ready", satisfied: false },
      { waiter_id: "waiter_at_boundary_after_ready", satisfied: true },
      { waiter_id: "waiter_at_boundary_before_ready", satisfied: true },
    ]);
  });

  it("lets only one concurrent wake claimer win a fencing token for an eligible hot-lane intent", async () => {
    await pools.platform.query(platformWorkSignalStoreSchemaSql);
    const store = createPostgresWorkSignalStore(pools.platform);
    const intent = await store.enqueueProjectionWakeIntent({
      sourceContextName: "checkout",
      targetContextName: "checkout",
      projectionName: "checkout-session-projection",
      checkpointKey: "checkout.session-projection:checkout:v1",
      requiredPosition: 7n,
      priorityLane: "hot",
      origin: "relay",
    });

    // Hold two physical clients before starting either statement so both
    // claim queries race the same eligible row instead of pool scheduling
    // accidentally serializing the regression.
    const clientA = await pools.platform.connect();
    const clientB = await pools.platform.connect();
    try {
      const storeA = createPostgresWorkSignalStore(clientA);
      const storeB = createPostgresWorkSignalStore(clientB);
      const claims = await Promise.all([
        storeA.claimNextProjectionWakeIntent({
          claimOwnerId: "worker-a:projection-wake-scheduler.hot.lane-1",
          claimTtlMs: 60_000,
          priorityLanes: ["hot"],
          targetContextNames: ["checkout"],
        }),
        storeB.claimNextProjectionWakeIntent({
          claimOwnerId: "worker-b:projection-wake-scheduler.hot.lane-1",
          claimTtlMs: 60_000,
          priorityLanes: ["hot"],
          targetContextNames: ["checkout"],
        }),
      ]);

      const [claim] = claims.filter((candidate) => candidate !== null);
      expect(claims.filter((candidate) => candidate !== null)).toHaveLength(1);
      expect(claim?.wakeIntentId).toBe(intent.wakeIntentId);
      expect(claim?.attemptCount).toBe(1);
      expect(claim?.claimFencingToken).toBe(1n);

      await expect(
        store.completeProjectionWakeIntent({
          wakeIntentId: intent.wakeIntentId,
          claimOwnerId: claim!.claimOwnerId!,
          claimFencingToken: claim!.claimFencingToken!,
        }),
      ).resolves.toBe("completed");
    } finally {
      clientA.release();
      clientB.release();
    }

    await expect(
      store.claimNextProjectionWakeIntent({
        claimOwnerId: "worker-c:projection-wake-scheduler.hot.lane-1",
        claimTtlMs: 60_000,
        priorityLanes: ["hot"],
        targetContextNames: ["checkout"],
      }),
    ).resolves.toBeNull();

    const persisted = await pools.platform.query(
      "SELECT state, attempt_count, claim_fencing_token::text FROM platform_projection_wake_intents WHERE wake_intent_id = $1",
      [intent.wakeIntentId],
    );
    expect(persisted.rows[0]).toMatchObject({ state: "completed", attempt_count: 1, claim_fencing_token: "1" });
  });

  it("reclaims an expired wake-intent row pinned by an orphaned transaction", async () => {
    // Regression for issue #4649 (staging drill 28950995223): four identity
    // relay intents sat `queued` with attemptCount 0 through active claim and
    // cleanup passes because a hung transaction from the deploy-churn window
    // held their row locks. Every mutating scan on the table uses
    // FOR UPDATE SKIP LOCKED (claims, cleanup-expire) or a plain FOR UPDATE
    // (the enqueue coalescing read), so a pinned row silently starves claims,
    // survives the reaper, and can wedge the relay's fan-out loop behind an
    // unbounded lock wait.
    await pools.platform.query(platformWorkSignalStoreSchemaSql);
    const enqueueEvents: ProjectionWakeIntentEnqueuedEvent[] = [];
    const store = createPostgresWorkSignalStore(pools.platform, {
      enqueueLockTimeoutMs: 250,
      orphanedWakeTransactionMinAgeMs: 0,
      observer: { projectionWakeIntentEnqueued: (event) => enqueueEvents.push(event) },
    });

    const pinned = await store.enqueueProjectionWakeIntent({
      sourceContextName: "identity",
      targetContextName: "commercial-terms",
      projectionName: "commercial-terms-account-projection",
      checkpointKey: "commercial-terms-account-projection:identity:v1",
      requiredPosition: 12n,
      priorityLane: "standard",
      origin: "relay",
    });
    const healthy = await store.enqueueProjectionWakeIntent({
      sourceContextName: "checkout",
      targetContextName: "checkout",
      projectionName: "checkout-session-projection",
      checkpointKey: "checkout.session-projection:checkout:v1",
      requiredPosition: 7n,
      priorityLane: "standard",
      origin: "relay",
    });

    const pinningClient = await pools.platform.connect();
    let pinningClientWasTerminated = false;
    try {
      await pinningClient.query("BEGIN");
      await pinningClient.query(
        "SELECT wake_intent_id FROM platform_projection_wake_intents WHERE wake_intent_id = $1 FOR UPDATE",
        [pinned.wakeIntentId],
      );

      // 1. The relay's coalescing enqueue must not wedge behind the pinned
      //    row: it returns within the bounded lock wait with an explicit
      //    `blocked` outcome and the existing durable record, without
      //    mutating the row.
      const blocked = await store.enqueueProjectionWakeIntent({
        sourceContextName: "identity",
        targetContextName: "commercial-terms",
        projectionName: "commercial-terms-account-projection",
        checkpointKey: "commercial-terms-account-projection:identity:v1",
        requiredPosition: 40n,
        priorityLane: "standard",
        origin: "relay",
      });
      expect(blocked.wakeIntentId).toBe(pinned.wakeIntentId);
      expect(enqueueEvents.at(-1)).toMatchObject({
        outcome: "blocked",
        targetContextName: "commercial-terms",
        priorityLane: "standard",
      });
      const pinnedRowAfterBlocked = await pools.platform.query(
        "SELECT required_position, attempt_count, state FROM platform_projection_wake_intents WHERE wake_intent_id = $1",
        [pinned.wakeIntentId],
      );
      expect(pinnedRowAfterBlocked.rows[0]).toMatchObject({
        required_position: "12",
        attempt_count: 0,
        state: "queued",
      });

      // 2. Claims skip the pinned row (SKIP LOCKED) instead of blocking, and
      //    still serve the rest of the lane — the drill's starvation shape:
      //    the pinned intent stays queued at attempt 0 while later intents
      //    complete around it.
      const claimed = await store.claimNextProjectionWakeIntent({
        claimOwnerId: "worker-a:projection-wake-scheduler.standard.lane-1",
        claimTtlMs: 60_000,
        priorityLanes: ["standard"],
        targetContextNames: ["checkout", "commercial-terms", "identity"],
      });
      expect(claimed?.wakeIntentId).toBe(healthy.wakeIntentId);
      await store.completeProjectionWakeIntent({
        wakeIntentId: healthy.wakeIntentId,
        claimOwnerId: "worker-a:projection-wake-scheduler.standard.lane-1",
        claimFencingToken: claimed!.claimFencingToken!,
      });

      // 3. The reaper identifies the exact expired tuple locker through
      //    xmax/backend_xid, terminates only this old same-role idle
      //    transaction, then expires and prunes the row through the normal
      //    locked state transition. The completed healthy row is pruned too.
      const horizon = new Date(Date.now() + 30 * 60 * 1000);
      const reclaimedCleanup = await store.cleanupExpiredWorkSignals({ before: horizon });
      pinningClientWasTerminated = true;
      expect(reclaimedCleanup).toMatchObject({
        reclaimedPinnedWakeIntents: 1,
        reclaimedOrphanTransactions: 1,
        expiredWakeIntents: 1,
        remainingPinnedWakeIntents: 0,
        prunedWakeIntents: 2,
      });
      await expect(pinningClient.query("SELECT 1")).rejects.toThrow();
    } finally {
      if (!pinningClientWasTerminated) {
        await pinningClient.query("ROLLBACK").catch(() => undefined);
      }
      pinningClient.release(pinningClientWasTerminated ? new Error("backend terminated by cleanup test") : undefined);
    }

    const remaining = await pools.platform.query(
      "SELECT COUNT(*)::integer AS remaining FROM platform_projection_wake_intents",
    );
    expect(remaining.rows[0]).toMatchObject({ remaining: 0 });
  });

  it("observes but does not terminate a recently-idle wake-intent locker", async () => {
    await pools.platform.query(platformWorkSignalStoreSchemaSql);
    const store = createPostgresWorkSignalStore(pools.platform, {
      orphanedWakeTransactionMinAgeMs: 60_000,
    });
    const intent = await store.enqueueProjectionWakeIntent({
      sourceContextName: "identity",
      targetContextName: "auth",
      projectionName: "auth-session-projection",
      checkpointKey: "auth-session-projection:identity:v1",
      requiredPosition: 12n,
      priorityLane: "standard",
      origin: "relay",
    });

    const pinningClient = await pools.platform.connect();
    try {
      await pinningClient.query("BEGIN");
      await pinningClient.query(
        "SELECT wake_intent_id FROM platform_projection_wake_intents WHERE wake_intent_id = $1 FOR UPDATE",
        [intent.wakeIntentId],
      );

      const result = await store.cleanupExpiredWorkSignals({
        before: new Date(Date.now() + 30 * 60 * 1000),
      });
      expect(result).toMatchObject({
        reclaimedPinnedWakeIntents: 0,
        reclaimedOrphanTransactions: 0,
        expiredWakeIntents: 0,
        remainingPinnedWakeIntents: 1,
      });
      await expect(pinningClient.query("SELECT 1 AS still_connected")).resolves.toMatchObject({
        rows: [{ still_connected: 1 }],
      });
    } finally {
      await pinningClient.query("ROLLBACK").catch(() => undefined);
      pinningClient.release();
    }

    const released = await store.cleanupExpiredWorkSignals({ before: new Date(Date.now() + 30 * 60 * 1000) });
    expect(released).toMatchObject({
      expiredWakeIntents: 1,
      remainingPinnedWakeIntents: 0,
    });
  });

  it("boots the exact evidence-window schema from empty and converges idempotently", async () => {
    await pools.platform.query("DROP TABLE evidence_window CASCADE");
    await bootstrapPlatformControlPlane(pools.platform);
    await expect(bootstrapPlatformControlPlane(pools.platform)).resolves.toBeUndefined();

    const columns = await pools.platform.query<{
      column_name: string;
      data_type: string;
      is_nullable: "YES" | "NO";
      column_default: string | null;
    }>(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'evidence_window'
       ORDER BY ordinal_position`,
    );
    expect(columns.rows).toEqual([
      { column_name: "window_id", data_type: "text", is_nullable: "NO", column_default: null },
      { column_name: "state", data_type: "text", is_nullable: "NO", column_default: null },
      { column_name: "opened_at", data_type: "timestamp with time zone", is_nullable: "NO", column_default: null },
      { column_name: "expires_at", data_type: "timestamp with time zone", is_nullable: "NO", column_default: null },
      { column_name: "retention_seconds", data_type: "integer", is_nullable: "NO", column_default: null },
      { column_name: "closed_at", data_type: "timestamp with time zone", is_nullable: "YES", column_default: null },
      { column_name: "observed_mode", data_type: "text", is_nullable: "NO", column_default: null },
      { column_name: "version", data_type: "integer", is_nullable: "NO", column_default: null },
    ]);

    const constraints = await pools.platform.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'evidence_window'::regclass`,
    );
    expect(constraints.rows.map((row) => row.definition).join("\n")).toMatch(/PRIMARY KEY \(window_id\)/);
    expect(constraints.rows).toHaveLength(8);

    const indexes = await pools.platform.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'evidence_window'
       ORDER BY indexname`,
    );
    expect(indexes.rows).toHaveLength(2);
    expect(indexes.rows.find((row) => row.indexname === "evidence_window_single_open_idx")?.indexdef).toMatch(
      /UNIQUE INDEX .* \(\(true\)\) WHERE \(state = 'open'::text\)/,
    );
    const tables = await pools.platform.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name LIKE 'evidence_window%'
       ORDER BY table_name`,
    );
    expect(tables.rows).toEqual([{ table_name: "evidence_window" }, { table_name: "evidence_window_provider_write" }]);
  });

  it("admits exactly one of two concurrent opens through the database constraint", async () => {
    const registration = createPostgresEvidenceWindowRegistration(pools.platform);
    const attempts = await Promise.allSettled([
      registration.open({ windowId: "10000000000000000000000000000000", retentionSeconds: 3_600 }),
      registration.open({ windowId: "20000000000000000000000000000000", retentionSeconds: 3_600 }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    expect(attempts.find((attempt) => attempt.status === "rejected")).toMatchObject({
      reason: { code: "evidence-window-already-open" },
    });
    const stored = await pools.platform.query<{ open_count: number; total_count: number }>(
      `SELECT
         COUNT(*) FILTER (WHERE state = 'open')::integer AS open_count,
         COUNT(*)::integer AS total_count
       FROM evidence_window`,
    );
    expect(stored.rows[0]).toEqual({ open_count: 1, total_count: 1 });
  });

  it("reads expiry without mutation and atomically retires it during a raced replacement", async () => {
    const registration = createPostgresEvidenceWindowRegistration(pools.platform);
    const expiredId = "30000000000000000000000000000000";
    await expect(registration.current()).resolves.toBeNull();
    await registration.open({ windowId: expiredId, retentionSeconds: 3_600 });
    await expect(registration.current()).resolves.toMatchObject({ windowId: expiredId, version: 1 });
    await pools.platform.query(
      `UPDATE evidence_window
       SET opened_at = statement_timestamp() - interval '3600 seconds',
           expires_at = statement_timestamp(),
           retention_seconds = 3600
       WHERE window_id = $1`,
      [expiredId],
    );
    const expiry = await pools.platform.query<{ expires_at: Date }>(
      "SELECT expires_at FROM evidence_window WHERE window_id = $1",
      [expiredId],
    );
    await expect(registration.current()).resolves.toBeNull();
    await expect(registration.current()).resolves.toBeNull();
    await expect(
      pools.platform.query("SELECT state, version FROM evidence_window WHERE window_id = $1", [expiredId]),
    ).resolves.toMatchObject({ rows: [{ state: "open", version: 1 }] });

    const replacements = await Promise.allSettled([
      registration.open({ windowId: "40000000000000000000000000000000", retentionSeconds: 3_600 }),
      registration.open({ windowId: "50000000000000000000000000000000", retentionSeconds: 3_600 }),
    ]);
    expect(replacements.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(replacements.find((attempt) => attempt.status === "rejected")).toMatchObject({
      reason: { code: "evidence-window-already-open" },
    });

    const rows = await pools.platform.query<{
      window_id: string;
      state: "open" | "closed";
      expires_at: Date;
      closed_at: Date | null;
      version: number;
    }>("SELECT window_id, state, expires_at, closed_at, version FROM evidence_window ORDER BY window_id");
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.find((row) => row.window_id === expiredId)).toMatchObject({ state: "closed", version: 2 });
    expect(rows.rows.find((row) => row.window_id === expiredId)?.closed_at?.toISOString()).toBe(
      expiry.rows[0]?.expires_at.toISOString(),
    );
    expect(rows.rows.filter((row) => row.state === "open")).toHaveLength(1);
  });

  it("closes current and expired windows with expected-version guards and idempotent repeats", async () => {
    const registration = createPostgresEvidenceWindowRegistration(pools.platform);
    const currentId = "60000000000000000000000000000000";
    const opened = await registration.open({ windowId: currentId, retentionSeconds: 3_600 });
    await expect(registration.close({ windowId: currentId, expectedVersion: 2 })).rejects.toMatchObject({
      code: "evidence-window-stale-write-rejected",
    });
    const closed = await registration.close({ windowId: currentId, expectedVersion: opened.version });
    expect(closed).toMatchObject({ windowId: currentId, state: "closed", version: 2 });
    await expect(registration.current()).resolves.toBeNull();
    await expect(registration.close({ windowId: currentId, expectedVersion: 1 })).resolves.toEqual(closed);
    await expect(
      registration.close({ windowId: "70000000000000000000000000000000", expectedVersion: 1 }),
    ).rejects.toMatchObject({ code: "evidence-window-unknown" });
    await expect(registration.open({ windowId: currentId, retentionSeconds: 3_600 })).rejects.toMatchObject({
      code: "evidence-window-storage-failed",
    });

    const expiredId = "80000000000000000000000000000000";
    await registration.open({ windowId: expiredId, retentionSeconds: 3_600 });
    await pools.platform.query(
      `UPDATE evidence_window
       SET opened_at = statement_timestamp() - interval '3600 seconds',
           expires_at = statement_timestamp(),
           retention_seconds = 3600
       WHERE window_id = $1`,
      [expiredId],
    );
    const beforeClose = await pools.platform.query<{ expires_at: Date }>(
      "SELECT expires_at FROM evidence_window WHERE window_id = $1",
      [expiredId],
    );
    const expiredClose = await registration.close({ windowId: expiredId, expectedVersion: 1 });
    expect(expiredClose).toEqual({
      windowId: expiredId,
      state: "closed",
      closedAt: beforeClose.rows[0]?.expires_at.toISOString(),
      version: 2,
    });
    const retained = await pools.platform.query<{ total_count: number }>(
      "SELECT COUNT(*)::integer AS total_count FROM evidence_window",
    );
    expect(retained.rows[0]).toEqual({ total_count: 2 });
  });
});

describe("busy-group-pass-attribution Postgres", () => {
  let pools: Readonly<Record<"platform" | "inventory" | "catalog" | "marketplace", PgTransactionalPool>>;

  beforeAll(async () => {
    if (!adminDatabaseUrl) throw new Error("TEST_DATABASE_URL is required for busy-group attribution.");
    const urls = createMultiContextTestDatabaseUrls(
      adminDatabaseUrl,
      ["platform", "inventory", "catalog", "marketplace"],
      "busy_group_attribution",
    );
    await ensureMultiContextTestDatabases(adminDatabaseUrl, urls);
    pools = createMultiContextTestPools(urls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.platform.query(platformControlPlaneSchemaSql);
  });

  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  it.each([
    {
      shape: "inventory-supply",
      sourceContextName: "inventory" as const,
      projectionName: "marketplace-inventory-supply-projection",
      subscriptionVersion: 1,
      order: 30,
      initialCount: 50,
      concurrentCount: 1,
      createdType: "inventory.item.created",
      changedType: "inventory.item.adjusted",
      timeoutMs: 2500,
      pollIntervalMs: 75,
    },
    {
      shape: "marketplace-listing",
      sourceContextName: "marketplace" as const,
      projectionName: "marketplace-listing-projection",
      subscriptionVersion: 2,
      order: 22,
      initialCount: 172,
      concurrentCount: 5,
      createdType: "marketplace.listing.created",
      changedType: "marketplace.listing.price-updated",
      timeoutMs: 900,
      pollIntervalMs: 50,
    },
  ])("busy-group-exact-receipt-read $shape", async (fixture) => {
    const startedAt = performance.now();
    const traceLimit = 5 * 1024 * 1024;
    let traceBytes = 0;
    let omittedRecords = 0;
    let sequence = 0;
    const trace = (phase: string, fields: Readonly<Record<string, unknown>> = {}) => {
      const line = JSON.stringify({
        attribution: "busy-group-pass-attribution",
        case: fixture.shape,
        group: fixture.projectionName,
        sequence: ++sequence,
        elapsedMs: performance.now() - startedAt,
        phase,
        ...fields,
      });
      const bytes = Buffer.byteLength(line + "\n", "utf8");
      // Reserve space for the terminal completeness record, even if a noisy runner fills the cap.
      if (traceBytes + bytes > traceLimit - 1024) {
        omittedRecords += 1;
        return;
      }
      traceBytes += bytes;
      console.info(line);
    };
    let connectionId = 0;
    const targetPool: PgTransactionalPool = {
      ...pools.marketplace,
      query: <Row = Record<string, unknown>>(...[sql, values]: Parameters<PgQueryFunction>) =>
        pools.marketplace.query<Row>(sql, values),
      connect: async () => {
        const connection = ++connectionId;
        trace("connection-request", { connection });
        const client = await pools.marketplace.connect();
        trace("connection-acquired", { connection });
        let checkpoint: Readonly<{ checkpointKey: unknown; position: unknown }> | undefined;
        const query: PgQueryFunction = async <Row = Record<string, unknown>>(
          ...[sql, values]: Parameters<PgQueryFunction>
        ) => {
          const command = sql.trim().toUpperCase();
          const checkpointWrite = command.includes("INSERT INTO EVENT_SUBSCRIPTION_CHECKPOINTS");
          const ownedWrite = command.includes("INSERT INTO BUSY_GROUP_OWNED_ITEMS");
          const kind = checkpointWrite
            ? "checkpoint-write"
            : command.includes("PG_ADVISORY_XACT_LOCK")
              ? "advisory-lock"
              : ["BEGIN", "COMMIT", "ROLLBACK"].includes(command)
                ? command
                : "statement";
          const identity = {
            connection,
            kind,
            ...(ownedWrite ? { position: values?.[1], eventId: values?.[2] } : {}),
          };
          trace("db-request", identity);
          try {
            const result = await client.query<Row>(sql, values);
            trace("db-returned", identity);
            if (checkpointWrite) checkpoint = { checkpointKey: values?.[0], position: values?.[4] };
            if (command === "COMMIT" && checkpoint) trace("checkpoint-committed", { connection, ...checkpoint });
            if (command === "COMMIT" || command === "ROLLBACK") checkpoint = undefined;
            return result;
          } catch (error) {
            trace("db-failed", { connection, kind });
            throw error;
          }
        };
        return {
          query,
          release: (error) => {
            trace("connection-release", { connection, failed: error !== undefined });
            client.release(error);
          },
        };
      },
    };
    let resolveApplying: (() => void) | null = null;
    const applying = new Promise<void>((resolve) => {
      resolveApplying = resolve;
    });
    const apply: ProjectorHandler = async (event, context) => {
      const identity = { eventId: event.id, position: event.globalPosition, streamId: event.streamId };
      trace("apply-start", identity);
      resolveApplying?.();
      try {
        await context!.db!.query(
          `INSERT INTO busy_group_owned_items (stream_id, position, event_id)
           VALUES ($1, $2::bigint, $3)
           ON CONFLICT (stream_id) DO UPDATE SET position = EXCLUDED.position, event_id = EXCLUDED.event_id`,
          [event.streamId, event.globalPosition, event.id],
        );
        trace("apply-end", identity);
      } catch (error) {
        trace("apply-failed", identity);
        throw error;
      }
    };
    const subscriptions = [
      ...(fixture.sourceContextName === "marketplace"
        ? [
            {
              sourceContextName: "catalog",
              projectionName: fixture.projectionName,
              subscriptionName: "marketplace.catalog-listing-projection",
              subscriptionVersion: 1,
              filterToEventTypes: true,
              eventTypes: ["catalog.catalog-item.product-measures-resolved"],
              order: 21,
              handlers: { "catalog.catalog-item.product-measures-resolved": apply },
            },
          ]
        : []),
      {
        sourceContextName: fixture.sourceContextName,
        projectionName: fixture.projectionName,
        subscriptionName:
          fixture.sourceContextName === "marketplace"
            ? "marketplace.self-listing-projection"
            : "marketplace.inventory-supply-projection",
        subscriptionVersion: fixture.subscriptionVersion,
        filterToEventTypes: fixture.sourceContextName === "marketplace",
        eventTypes: [fixture.createdType, fixture.changedType],
        order: fixture.order,
        handlers: { [fixture.createdType]: apply, [fixture.changedType]: apply },
      },
    ];
    const sourceModule = (contextName: string) =>
      defineBoundedContextModule({
        manifest: { contextName, apiBasePath: `/${contextName}`, streamPrefix: `${contextName}.` },
        schemaSql: "",
        createServices: () => ({}),
        buildApis: () => [],
      });
    const marketplace = defineBoundedContextModule({
      manifest: {
        contextName: "marketplace",
        apiBasePath: "/marketplace",
        streamPrefix: "marketplace.",
        eventSubscriptions: subscriptions.map(({ handlers: _handlers, ...subscription }) => ({
          ...subscription,
          projectionHandlerSetNames: [fixture.projectionName],
        })),
        projectionGroups: [
          {
            projectionName: fixture.projectionName,
            sourceContextNames: subscriptions.map((subscription) => subscription.sourceContextName),
            ownedTables: ["busy_group_owned_items"],
            resetStrategy: "truncate-owned-tables",
          },
        ],
      },
      schemaSql:
        "CREATE TABLE busy_group_owned_items (stream_id text PRIMARY KEY, position bigint NOT NULL, event_id text NOT NULL)",
      createServices: () => ({}),
      buildApis: () => [],
      buildSubscriptions: () => subscriptions,
    });
    const inventory = sourceModule("inventory");
    const catalog = sourceModule("catalog");
    let pollLoop: ReturnType<typeof createWorkerRunnerLoop> | undefined;
    let wakeLoop: ReturnType<typeof createWorkerRunnerLoop> | undefined;
    let clientTimer: ReturnType<typeof setTimeout> | undefined;
    let passed = false;
    try {
      await bootstrapContextDatabase(inventory, pools.inventory);
      await bootstrapContextDatabase(catalog, pools.catalog);
      await bootstrapContextDatabase(marketplace, pools.marketplace);
      const runtime = createMountedContextTestRuntime([
        { contextName: "inventory", module: inventory, pool: pools.inventory, ports: {}, mountRole: "source-only" },
        { contextName: "catalog", module: catalog, pool: pools.catalog, ports: {}, mountRole: "source-only" },
        { contextName: "marketplace", module: marketplace, pool: targetPool, ports: {} },
      ]);
      const group = runtime.projectionGroups[0];
      const realControlPlane = createPostgresPlatformControlPlane(pools.platform);
      const controlPlane: typeof realControlPlane = {
        ...realControlPlane,
        acquireLease: async (input) => {
          const identity = { leaseName: input.leaseName, ownerId: input.ownerId };
          trace("lease-request", identity);
          const lease = await realControlPlane.acquireLease(input);
          trace(lease ? "lease-acquired" : "lease-busy", { ...identity, fencingToken: lease?.fencingToken });
          return lease;
        },
        releaseLease: async (lease) => {
          const identity = { leaseName: lease.leaseName, ownerId: lease.ownerId, fencingToken: lease.fencingToken };
          trace("lease-release-request", identity);
          await realControlPlane.releaseLease(lease);
          trace("lease-released", identity);
        },
      };
      const signals = createPostgresWorkSignalStore(pools.platform, { readConsistencyGateway: {} });
      const worker = createProjectionGroupWorkerRunner(group);
      const loopOptions = {
        controlPlane,
        maxConcurrentRunners: 2,
        leaseTtlMs: 30_000,
        leaseRenewIntervalMs: 10_000,
        pollIntervalMs: 1000,
        observer: {
          runnerCompleted: (event: { runnerName: string; processed: number }) => trace("runner-completed", event),
          runnerFailed: (event: { runnerName: string }) => trace("runner-failed", { runnerName: event.runnerName }),
        },
      };
      pollLoop = createWorkerRunnerLoop({
        ...loopOptions,
        workerId: `attribution-poll-${fixture.shape}`,
        runners: [
          {
            ...worker,
            runOnce: async (context) => {
              trace("pass-start", { ownerId: context?.ownerId });
              try {
                const result = await worker.runOnce(context);
                trace("pass-end", { processed: result.processed, position: result.lastGlobalPosition });
                return result;
              } catch (error) {
                trace("pass-failed");
                throw error;
              }
            },
          },
        ],
      });
      wakeLoop = createWorkerRunnerLoop({
        ...loopOptions,
        workerId: `attribution-wake-${fixture.shape}`,
        runners: createProjectionWakeSchedulerRunners({
          workerId: `attribution-wake-${fixture.shape}`,
          controlPlane,
          workSignalStore: signals,
          projectionGroups: runtime.projectionGroups,
          observer: {
            wakeIntentClaimed: (event) =>
              trace("wake-claimed", { checkpointKey: event.checkpointKey, position: event.requiredPosition }),
            wakeIntentDeferred: (event) =>
              trace("wake-deferred", { checkpointKey: event.checkpointKey, position: event.requiredPosition }),
            wakeIntentCompleted: (event) =>
              trace("wake-completed", { checkpointKey: event.checkpointKey, position: event.checkpointPosition }),
            wakeIntentRunFailed: () => trace("wake-failed"),
          },
        }),
      });
      const store = createPostgresEventStore({ pool: pools[fixture.sourceContextName] });
      const eventContext = {
        tenantId: "tenant_attribution" as never,
        audit: { performedByUserId: "user_attribution" as never, forAccountId: "account_attribution" as never },
      };
      const streamId = `${fixture.sourceContextName}.attribution`;
      const initial = await store.appendToStream({
        streamId,
        expectedVersion: "no_stream",
        events: Array.from({ length: fixture.initialCount }, (_, index) => ({
          eventType: index === 0 ? fixture.createdType : fixture.changedType,
          payload: {},
        })),
        context: eventContext,
      });
      trace("initial-appended", { position: initial.at(-1)!.globalPosition, count: initial.length });
      pollLoop.start();
      // Observe real application starting; do not hold the transaction or delay the holder.
      await applying;
      trace("concurrent-append-start");
      const appended = await store.appendToStream({
        streamId,
        expectedVersion: fixture.initialCount,
        events: Array.from({ length: fixture.concurrentCount }, () => ({
          eventType: fixture.changedType,
          payload: {},
        })),
        context: eventContext,
      });
      const position = appended.at(-1)!.globalPosition;
      const eventIds = appended.map((event) => event.eventId);
      const receipt = encodeFreshWriteReceipt({
        observedAtMs: Date.now(),
        sources: [{ sourceContextName: fixture.sourceContextName, maxGlobalPosition: position, eventIds }],
      });
      trace("receipt", { sourceContextName: fixture.sourceContextName, position, eventIds });
      const app = new Hono();
      attachReadConsistencyMiddleware(
        app,
        [
          {
            contextName: "marketplace",
            mountPath: "/api/marketplace",
            readFreshnessRoutes: [{ routePath: "/owned", dependencies: [{ projectionName: fixture.projectionName }] }],
          },
        ],
        runtime.projectionGroups,
        {
          timeoutMs: fixture.timeoutMs,
          pollIntervalMs: fixture.pollIntervalMs,
          workSignalGateway: signals.readConsistencyGateway,
          recordReadConsistencyAudit: (record) =>
            trace("read-audit", {
              outcome: record.outcome,
              durationMs: record.durationMs,
              waitMode: record.waitMode,
              pending: record.pending,
            }),
        },
      );
      app.get("/api/marketplace/owned", async (context) => {
        const result = await pools.marketplace.query<{ position: string; event_id: string }>(
          "SELECT position::text, event_id FROM busy_group_owned_items WHERE stream_id = $1",
          [streamId],
        );
        trace("owned-query-visible", { requiredPosition: position, rows: result.rows });
        return context.json(result.rows);
      });
      const readStartedAt = performance.now();
      trace("read-start", { position, serverBoundMs: fixture.timeoutMs, clientBoundMs: 5000 });
      const read = app.request("/api/marketplace/owned", {
        headers: {
          [CHASE_SETS_READ_AFTER_WRITE_HEADER]: receipt,
          [CHASE_SETS_READ_TARGET_CONTEXT_HEADER]: "marketplace",
        },
      });
      wakeLoop.start();
      const response = await Promise.race([
        read,
        new Promise<never>((_resolve, reject) => {
          clientTimer = setTimeout(
            () => reject(new Error("busy-group exact receipt exceeded 5000ms client bound")),
            5000,
          );
        }),
      ]);
      const elapsedMs = performance.now() - readStartedAt;
      trace("read-end", { status: response.status, requestDurationMs: elapsedMs, position });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([{ position, event_id: appended.at(-1)!.eventId }]);
      expect(elapsedMs).toBeLessThan(fixture.timeoutMs);
      expect(elapsedMs).toBeLessThan(5000);
      expect(omittedRecords).toBe(0);
      passed = true;
    } finally {
      if (clientTimer) clearTimeout(clientTimer);
      try {
        trace("read-bound-snapshot-start", { passed });
        const checkpoints = await pools.marketplace.query(
          "SELECT checkpoint_key, last_global_position::text FROM event_subscription_checkpoints ORDER BY checkpoint_key",
        );
        const visible = await pools.marketplace.query("SELECT position::text, event_id FROM busy_group_owned_items");
        trace("read-bound-durable-state", { checkpoints: checkpoints.rows, visible: visible.rows });
      } finally {
        trace("cleanup-start", { passed });
        await Promise.all([pollLoop?.stop(), wakeLoop?.stop()]);
        console.info(
          JSON.stringify({
            attribution: "busy-group-pass-attribution",
            case: fixture.shape,
            phase: "trace-complete",
            passed,
            traceBytes,
            omittedRecords,
          }),
        );
      }
    }
  });
});

describe("subscription pass checkpoint bounds Postgres", () => {
  let pools: Readonly<Record<"checkpoint", PgTransactionalPool>>;

  beforeAll(async () => {
    if (!adminDatabaseUrl) throw new Error("TEST_DATABASE_URL is required for checkpoint bounds DB tests.");
    const urls = createMultiContextTestDatabaseUrls(adminDatabaseUrl, ["checkpoint"], "checkpoint_bounds");
    await ensureMultiContextTestDatabases(adminDatabaseUrl, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  it.each(["api-wait", "relay"] as const)(
    "idle-tail-wake-durable-settlement / idle-tail-wake-safety: %s survives a fresh API and repeated wakes",
    async (origin) => {
      const module = defineBoundedContextModule({
        manifest: {
          contextName: "checkpoint",
          apiBasePath: "/checkpoint",
          streamPrefix: "checkpoint.",
          eventSubscriptions: ["sell-list", "session"].map((name) => ({
            sourceContextName: "checkpoint",
            projectionName: name,
            subscriptionVersion: 1,
            projectionHandlerSetNames: [name],
            eventTypes: [`checkpoint.${name}`],
          })),
          projectionGroups: ["sell-list", "session"].map((name) => ({
            projectionName: name,
            sourceContextNames: ["checkpoint"],
            ownedTables: [name === "sell-list" ? "sell_list_owned" : "session_owned"],
            resetStrategy: "truncate-owned-tables" as const,
          })),
        },
        schemaSql: `CREATE TABLE sell_list_owned (event_id text PRIMARY KEY, position bigint NOT NULL);
          CREATE TABLE session_owned (event_id text PRIMARY KEY, position bigint NOT NULL)`,
        createServices: () => ({}),
        buildApis: () => [],
        buildSubscriptions: () =>
          ["sell-list", "session"].map((name) => ({
            subscriptionName: `checkpoint.${name}`,
            projectionName: name,
            sourceContextName: "checkpoint",
            subscriptionVersion: 1,
            eventTypes: [`checkpoint.${name}`],
            streamPrefixes: [`checkpoint.${name}-`],
            handlers: {
              [`checkpoint.${name}`]: async (event, context) => {
                const table = name === "sell-list" ? "sell_list_owned" : "session_owned";
                await context!.db!.query(`INSERT INTO ${table} VALUES ($1, $2::bigint)`, [
                  event.id,
                  event.globalPosition,
                ]);
              },
            },
          })),
      });
      await bootstrapContextDatabase(module, pools.checkpoint);
      await pools.checkpoint.query(platformControlPlaneSchemaSql);
      await pools.checkpoint.query(platformWorkSignalStoreSchemaSql);
      const mount = () =>
        createMountedContextTestRuntime([{ contextName: "checkpoint", module, pool: pools.checkpoint, ports: {} }]);
      const runtime = mount();
      const session = runtime.projectionGroups.find((group) => group.projectionName === "session")!;
      const subscription = session.subscriptionRunners[0]!;
      const controlPlane = createPostgresPlatformControlPlane(pools.checkpoint);
      const signals = createPostgresWorkSignalStore(pools.checkpoint, { readConsistencyGateway: {} });
      const store = createPostgresEventStore({ pool: pools.checkpoint });
      const append = (name: string) =>
        store.appendToStream({
          streamId: `checkpoint.sell-list-${name}`,
          expectedVersion: "no_stream",
          events: [{ eventType: "checkpoint.sell-list", payload: {} }],
          context: {
            tenantId: "tenant_test" as never,
            audit: { performedByUserId: "user_test" as never, forAccountId: "account_test" as never },
          },
        });
      const first = (await append("first"))[0]!;
      // Prime the same runner closures used by the scheduler, without forced settlement.
      const primedAt = Date.now();
      for (const group of runtime.projectionGroups) {
        const worker = createProjectionGroupWorkerRunner(group);
        await worker.runOnce();
        await worker.runOnce();
      }
      expect((await subscription.refreshStatus()).lastGlobalPosition).toBe(first.globalPosition);
      await pools.checkpoint.query(`
        CREATE TABLE checkpoint_writes (checkpoint_key text NOT NULL);
        CREATE FUNCTION count_checkpoint_write() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO checkpoint_writes VALUES (NEW.checkpoint_key); RETURN NEW; END $$;
        CREATE TRIGGER count_checkpoint_write AFTER INSERT OR UPDATE ON event_subscription_checkpoints
          FOR EACH ROW EXECUTE FUNCTION count_checkpoint_write();
      `);
      const event = (await append("second"))[0]!;
      const before = await subscription.refreshStatus();
      expect(before.lastGlobalPosition).toBe(first.globalPosition);
      expect(before.sourceHeadGlobalPosition).toBe(event.globalPosition);
      expect(BigInt(event.globalPosition) - BigInt(first.globalPosition)).toBeLessThan(100n);
      const receipt = encodeFreshWriteReceipt({
        observedAtMs: Date.now(),
        sources: [
          { sourceContextName: "checkpoint", maxGlobalPosition: event.globalPosition, eventIds: [event.eventId] },
        ],
      });
      const headers = { [CHASE_SETS_READ_AFTER_WRITE_HEADER]: receipt };
      const createApi = (groups: typeof runtime.projectionGroups) => {
        const app = new Hono();
        attachReadConsistencyMiddleware(app, [{ contextName: "checkpoint", mountPath: "/checkpoint" }], groups, {
          timeoutMs: 100,
          pollIntervalMs: 10,
          workSignalGateway: signals.readConsistencyGateway,
        });
        app.get("/checkpoint/composite-review", async (c) =>
          c.json(
            (await pools.checkpoint.query("SELECT event_id, position::text FROM sell_list_owned ORDER BY position"))
              .rows,
          ),
        );
        return app;
      };
      const app = createApi(runtime.projectionGroups);
      if (origin === "relay") {
        for (const group of runtime.projectionGroups) {
          await signals.enqueueProjectionWakeIntent({
            sourceContextName: "checkpoint",
            targetContextName: "checkpoint",
            projectionName: group.projectionName,
            checkpointKey: group.subscriptionRunners[0]!.checkpointKey,
            requiredPosition: event.globalPosition,
            priorityLane: "hot",
            origin,
          });
        }
      } else {
        const pending = await app.request("/checkpoint/composite-review", { headers });
        expect(pending.status).toBe(503);
        expect(await pending.json()).toMatchObject({
          error: { code: "projection_freshness_timeout", waitMode: "target-context" },
        });
      }
      const [scheduler] = createProjectionWakeSchedulerRunners({
        workerId: "idle-tail-worker",
        controlPlane,
        workSignalStore: signals,
        projectionGroups: runtime.projectionGroups,
        lanes: [{ lane: "hot", runnerCount: 1 }],
      });
      await scheduler.runOnce();
      expect(Date.now() - primedAt, "test must remain inside the ordinary idle heartbeat").toBeLessThan(60_000);
      const durable = await subscription.refreshStatus();
      const progress = await pools.checkpoint.query(
        `SELECT c.last_global_position::text AS checkpoint, r.ready_position::text AS readiness,
          w.state, w.origin, w.required_position::text AS required
         FROM event_subscription_checkpoints c
         JOIN platform_projection_checkpoint_readiness r USING (checkpoint_key)
         JOIN platform_projection_wake_intents w USING (checkpoint_key)
         WHERE c.checkpoint_key = $1`,
        [subscription.checkpointKey],
      );
      // Soft assertions retain the main's false-completion/read-failure evidence together.
      expect.soft(progress.rows).toEqual([
        {
          checkpoint: event.globalPosition,
          readiness: event.globalPosition,
          state: "completed",
          origin,
          required: event.globalPosition,
        },
      ]);
      expect.soft(durable.lastGlobalPosition).toBe(event.globalPosition);
      expect
        .soft(
          (
            await pools.checkpoint.query(
              "SELECT count(*)::integer AS count FROM checkpoint_writes WHERE checkpoint_key = $1",
              [subscription.checkpointKey],
            )
          ).rows,
        )
        .toEqual([{ count: 1 }]);
      const fresh = await app.request("/checkpoint/composite-review", { headers });
      expect.soft(fresh.status).toBe(200);
      if (fresh.status === 200)
        expect(await fresh.json()).toEqual([
          { event_id: first.eventId, position: first.globalPosition },
          { event_id: event.eventId, position: event.globalPosition },
        ]);
      expect((await pools.checkpoint.query("SELECT * FROM session_owned")).rows).toEqual([]);
      expect
        .soft((await createApi(mount().projectionGroups).request("/checkpoint/composite-review", { headers })).status)
        .toBe(200);

      const checkpointRows = () =>
        pools.checkpoint.query(
          "SELECT checkpoint_key, last_global_position::text, xmin::text FROM event_subscription_checkpoints ORDER BY checkpoint_key",
        );
      const saved = (await checkpointRows()).rows;
      for (const group of runtime.projectionGroups) {
        await signals.enqueueProjectionWakeIntent({
          sourceContextName: "checkpoint",
          targetContextName: "checkpoint",
          projectionName: group.projectionName,
          checkpointKey: group.subscriptionRunners[0]!.checkpointKey,
          requiredPosition: event.globalPosition,
          priorityLane: "hot",
          origin,
        });
      }
      await scheduler.runOnce();
      await scheduler.runOnce();
      expect((await checkpointRows()).rows).toEqual(saved);
      expect(
        (
          await pools.checkpoint.query(
            "SELECT checkpoint_key, count(*)::integer AS count FROM checkpoint_writes GROUP BY checkpoint_key ORDER BY checkpoint_key",
          )
        ).rows,
      ).toEqual(
        runtime.projectionGroups
          .map((group) => ({
            checkpoint_key: group.subscriptionRunners[0]!.checkpointKey,
            count: 1,
          }))
          .sort((left, right) => left.checkpoint_key.localeCompare(right.checkpoint_key)),
      );
    },
  );

  it.each([false, true])(
    "keeps receipt E pending until its owned application commits (refresh=%s)",
    async (refresh) => {
      const makeBarrier = () => {
        let enter!: () => void;
        let release!: () => void;
        const entered = new Promise<void>((resolve) => {
          enter = resolve;
        });
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          entered,
          release,
          wait: async () => {
            enter();
            await released;
          },
        };
      };
      const firstApplication = makeBarrier();
      const nextApplication = makeBarrier();
      const appliedIds: string[] = [];
      const module = defineBoundedContextModule({
        manifest: {
          contextName: "checkpoint",
          apiBasePath: "/checkpoint",
          streamPrefix: "checkpoint.",
          eventSubscriptions: [
            {
              sourceContextName: "checkpoint",
              projectionName: "checkpoint-owned",
              subscriptionVersion: 1,
              projectionHandlerSetNames: ["checkpoint-owned"],
              eventTypes: ["checkpoint.recorded"],
            },
          ],
          projectionGroups: [
            {
              projectionName: "checkpoint-owned",
              sourceContextNames: ["checkpoint"],
              ownedTables: ["checkpoint_owned"],
              resetStrategy: "truncate-owned-tables",
            },
          ],
        },
        schemaSql:
          "CREATE TABLE checkpoint_owned (id integer PRIMARY KEY, event_id text NOT NULL, position bigint NOT NULL)",
        createServices: () => ({}),
        buildApis: () => [],
        buildSubscriptions: () => [
          {
            subscriptionName: "checkpoint.owned",
            projectionName: "checkpoint-owned",
            sourceContextName: "checkpoint",
            subscriptionVersion: 1,
            batchSize: 3,
            eventTypes: ["checkpoint.recorded"],
            handlers: {
              "checkpoint.recorded": async (event, context) => {
                await context!.db!.query(
                  `INSERT INTO checkpoint_owned VALUES (1, $1, $2::bigint)
               ON CONFLICT (id) DO UPDATE SET event_id = EXCLUDED.event_id, position = EXCLUDED.position`,
                  [event.id, event.globalPosition],
                );
                appliedIds.push(String(event.id));
                await (event.globalPosition === "1" ? firstApplication : nextApplication).wait();
              },
            },
          },
        ],
      });
      await bootstrapContextDatabase(module, pools.checkpoint);
      await pools.checkpoint.query(platformControlPlaneSchemaSql);
      await pools.checkpoint.query(platformWorkSignalStoreSchemaSql);
      const runtime = createMountedContextTestRuntime([
        { contextName: "checkpoint", module, pool: pools.checkpoint, ports: {} },
      ]);
      const group = runtime.projectionGroups[0]!;
      const subscription = group.subscriptionRunners[0]!;
      const worker = createProjectionGroupWorkerRunner(group, {
        onCheckpointsAdvanced: createCheckpointReadinessRecorder(createPostgresWorkSignalStore(pools.checkpoint)),
      });
      const controlPlane = createPostgresPlatformControlPlane(pools.checkpoint);
      const lease = await controlPlane.acquireLease({
        leaseName: createWorkerRunnerLeaseName(worker),
        ownerId: "checkpoint-bound-worker",
        ttlMs: 30_000,
      });
      expect(lease).not.toBeNull();
      if (!lease) throw new Error("Checkpoint bounds worker did not acquire its group lease.");
      const context = { ownerId: lease.ownerId, fencingToken: lease.fencingToken, settleIdleCheckpoints: true };
      const store = createPostgresEventStore({ pool: pools.checkpoint });
      const append = (streamId: string) =>
        store.appendToStream({
          streamId,
          expectedVersion: "no_stream",
          events: [{ eventType: "checkpoint.recorded", payload: {} }],
          context: {
            tenantId: "tenant_test" as never,
            audit: { performedByUserId: "user_test" as never, forAccountId: "account_test" as never },
          },
        });
      const readOwned = async () =>
        (await pools.checkpoint.query("SELECT event_id, position::text FROM checkpoint_owned WHERE id = 1")).rows;
      const readProgress = async () =>
        (
          await pools.checkpoint.query(
            `SELECT c.last_global_position::text AS checkpoint, c.lease_owner_id, c.lease_fencing_token::text,
              r.ready_position::text AS readiness
       FROM event_subscription_checkpoints c
       JOIN platform_projection_checkpoint_readiness r USING (checkpoint_key)
       WHERE c.checkpoint_key = $1`,
            [subscription.checkpointKey],
          )
        ).rows;
      const app = new Hono();
      attachReadConsistencyMiddleware(app, [{ contextName: "checkpoint", mountPath: "/checkpoint" }], [group], {
        // Immediate predicate probe, not a product latency/deadline test.
        timeoutMs: 0,
      });
      app.get("/checkpoint/owned", async (c) => c.json(await readOwned()));
      let activePass: ReturnType<typeof worker.runOnce> | undefined;
      try {
        const first = await append("checkpoint.first");
        expect(first[0]!.globalPosition).toBe("1");
        activePass = worker.runOnce(context);
        await firstApplication.entered;
        const appended = await append("checkpoint.next");
        const event = appended[0]!;
        expect(event.globalPosition).toBe("2");
        if (refresh) {
          await worker.refreshPriority!();
          expect(subscription.getStatus()).toMatchObject({
            sourceHeadGlobalPosition: "2",
            lastGlobalPosition: "0",
            outstandingEventCount: "2",
            state: "running",
          });
        }
        firstApplication.release();
        expect(await activePass).toMatchObject({ processed: 1, lastGlobalPosition: "1" });
        activePass = undefined;
        expect(await readOwned()).toEqual([{ event_id: first[0]!.eventId, position: "1" }]);
        expect(await readProgress()).toEqual([
          {
            checkpoint: "1",
            readiness: "1",
            lease_owner_id: lease.ownerId,
            lease_fencing_token: lease.fencingToken,
          },
        ]);
        const headers = {
          [CHASE_SETS_READ_AFTER_WRITE_HEADER]: encodeFreshWriteReceipt({
            observedAtMs: Date.now(),
            sources: [
              { sourceContextName: "checkpoint", maxGlobalPosition: event.globalPosition, eventIds: [event.eventId] },
            ],
          }),
        };
        const pending = await app.request("/checkpoint/owned", { headers });
        expect(pending.status).toBe(503);
        expect(await pending.json()).toMatchObject({
          error: {
            code: "projection_freshness_timeout",
            pending: [
              {
                lastGlobalPosition: "1",
                requiredGlobalPosition: "2",
              },
            ],
          },
        });
        expect(appliedIds).toEqual([first[0]!.eventId]);
        activePass = worker.runOnce(context);
        await nextApplication.entered;
        expect(await readOwned()).toEqual([{ event_id: first[0]!.eventId, position: "1" }]);
        expect((await app.request("/checkpoint/owned", { headers })).status).toBe(503);
        nextApplication.release();
        expect(await activePass).toMatchObject({ processed: 1, lastGlobalPosition: "2" });
        activePass = undefined;
        expect(await readProgress()).toEqual([
          {
            checkpoint: "2",
            readiness: "2",
            lease_owner_id: lease.ownerId,
            lease_fencing_token: lease.fencingToken,
          },
        ]);
        const fresh = await app.request("/checkpoint/owned", { headers });
        expect(fresh.status).toBe(200);
        expect(await fresh.json()).toEqual([{ event_id: event.eventId, position: "2" }]);
        expect(await worker.runOnce(context)).toMatchObject({ processed: 0, lastGlobalPosition: "2" });
        expect(appliedIds).toEqual([first[0]!.eventId, event.eventId]);
      } finally {
        firstApplication.release();
        nextApplication.release();
        try {
          await activePass;
        } finally {
          await controlPlane.releaseLease(lease);
        }
      }
    },
  );
});

describe("projection-group-recovery-marker Postgres", () => {
  let pools: Readonly<Record<"marker", PgTransactionalPool>>;
  let failProjection = false;
  const module = defineBoundedContextModule({
    manifest: {
      contextName: "marker",
      apiBasePath: "/marker",
      streamPrefix: "marker.",
      eventSubscriptions: [
        {
          sourceContextName: "marker",
          projectionName: "worker-marker",
          subscriptionVersion: 1,
          projectionHandlerSetNames: ["worker-marker"],
          eventTypes: ["marker.recorded"],
          streamPrefixes: ["marker."],
        },
      ],
      projectionGroups: [
        {
          projectionName: "worker-marker",
          sourceContextNames: ["marker"],
          ownedTables: ["worker_marker_items"],
          resetStrategy: "truncate-owned-tables",
        },
      ],
    },
    schemaSql: "CREATE TABLE worker_marker_items (item_id text PRIMARY KEY)",
    createServices: () => ({}),
    buildApis: () => [],
    buildSubscriptions: () => [
      {
        subscriptionName: "marker.worker",
        projectionName: "worker-marker",
        sourceContextName: "marker",
        subscriptionVersion: 1,
        eventTypes: ["marker.recorded"],
        streamPrefixes: ["marker."],
        handlers: {
          "marker.recorded": async (event, context) => {
            if (failProjection) throw new Error("marker projection blocked");
            await context!.db!.query("INSERT INTO worker_marker_items VALUES ($1) ON CONFLICT DO NOTHING", [
              event.streamId,
            ]);
          },
        },
      },
    ],
  });
  beforeAll(async () => {
    if (!adminDatabaseUrl) throw new Error("TEST_DATABASE_URL is required for worker recovery DB tests.");
    const urls = createMultiContextTestDatabaseUrls(adminDatabaseUrl, ["marker"], "worker_marker");
    await ensureMultiContextTestDatabases(adminDatabaseUrl, urls);
    pools = createMultiContextTestPools(urls);
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(module, pools.marker);
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  it("recovery reset, busy/blocked retention, stale capture and restart settle use the database token", async () => {
    const makeGroup = () =>
      createMountedContextTestRuntime([{ contextName: "marker", module, pool: pools.marker, ports: {} }])
        .projectionGroups[0];
    const group = makeGroup();
    const key = { targetContextName: "marker", projectionName: "worker-marker" };
    const read = () => loadProjectionGroupGeneration(pools.marker, key);
    const store = createPostgresEventStore({ pool: pools.marker });
    const append = (streamId: string) =>
      store.appendToStream({
        streamId,
        expectedVersion: "no_stream",
        events: [{ eventType: "marker.recorded", payload: {} }],
        context: {
          tenantId: "tenant_test" as never,
          audit: { performedByUserId: "user_test" as never, forAccountId: "account_test" as never },
        },
      });
    await append("marker.first");
    await syncProjectionGroup(group);
    await pools.marker.query("DELETE FROM event_projection_recovery_markers");
    const runner = group.subscriptionRunners[0];
    await runner.refreshStatus();
    expect(group.getStatus().recoveryRequired).toBe(true);
    const worker = createProjectionGroupWorkerRunner(group);
    await expect(worker.runOnce()).resolves.toMatchObject({ processed: 1 });
    await expect(read()).resolves.toEqual({ activeGeneration: "1", rebuildingGeneration: "2", state: "rebuilding" });
    await append("marker.second");
    failProjection = true;
    await expect(worker.runOnce()).resolves.toMatchObject({ processed: 1, blockedStreams: 1 });
    await expect(read()).resolves.toMatchObject({ rebuildingGeneration: "2", state: "rebuilding" });
    await expect(worker.runOnce()).resolves.toMatchObject({ processed: 0, blockedStreams: 1 });
    await expect(read()).resolves.toMatchObject({ rebuildingGeneration: "2", state: "rebuilding" });
    failProjection = false;
    await expect(resetProjectionGroup(group)).resolves.toMatchObject({ generation: "3" });
    await expect(worker.runOnce()).resolves.toMatchObject({ processed: 2, blockedStreams: 0 });
    const readRevision = async () => {
      const result = await pools.marker.query(
        `SELECT projection_revision FROM event_projection_group_revisions
         WHERE target_context_name = $1 AND projection_name = $2`,
        [key.targetContextName, key.projectionName],
      );
      return result.rows;
    };
    const revisionBeforeRefusal = await readRevision();
    await expect(worker.runOnce()).rejects.toThrow("rejected stale rebuild token");
    await expect(read()).resolves.toEqual({ activeGeneration: "1", rebuildingGeneration: "3", state: "rebuilding" });
    expect(await readRevision()).toEqual(revisionBeforeRefusal);
    const restarted = createProjectionGroupWorkerRunner(makeGroup());
    await expect(restarted.runOnce()).resolves.toMatchObject({ processed: 0, blockedStreams: 0 });
    await expect(read()).resolves.toEqual({ activeGeneration: "3", rebuildingGeneration: null, state: "active" });
    await resetProjectionGroup(group);
    const crashed = createProjectionGroupWorkerRunner({
      ...group,
      subscriptionRunners: [
        {
          ...runner,
          runOnce: async () => {
            throw new Error("worker process crashed");
          },
        },
      ],
    });
    await expect(crashed.runOnce()).rejects.toThrow("worker process crashed");
    await expect(read()).resolves.toMatchObject({ rebuildingGeneration: "4", state: "rebuilding" });
    const recovered = createProjectionGroupWorkerRunner(makeGroup());
    await expect(recovered.runOnce()).resolves.toMatchObject({ processed: 2 });
    await expect(read()).resolves.toMatchObject({ state: "rebuilding" });
    await recovered.runOnce();
    await expect(read()).resolves.toEqual({ activeGeneration: "4", rebuildingGeneration: null, state: "active" });
    await restarted.runOnce();
    await expect(read()).resolves.toEqual({ activeGeneration: "4", rebuildingGeneration: null, state: "active" });
  });
});
