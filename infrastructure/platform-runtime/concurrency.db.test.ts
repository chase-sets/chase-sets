import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import {
  bootstrapPlatformControlPlane,
  createPostgresPlatformControlPlane,
  platformControlPlaneSchemaSql,
  reapStaleProjectionOperations,
} from "./control-plane";
import { createPostgresDurableJobStore, durableJobSchemaSql } from "./durable-job-store";
import { createPostgresDurableJobWorkUnitStore, durableJobWorkUnitSchemaSql } from "./durable-job-work-units";
import { createPostgresUcpIdempotencyStore } from "./ucp";
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

  it("lets only one concurrent wake claimer process an eligible hot-lane intent", async () => {
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
      "SELECT state, attempt_count FROM platform_projection_wake_intents WHERE wake_intent_id = $1",
      [intent.wakeIntentId],
    );
    expect(persisted.rows[0]).toMatchObject({ state: "completed", attempt_count: 1 });
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
});
