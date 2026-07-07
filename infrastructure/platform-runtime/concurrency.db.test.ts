import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresPlatformControlPlane, platformControlPlaneSchemaSql } from "./control-plane";
import { createPostgresDurableJobStore, durableJobSchemaSql } from "./durable-job-store";
import { createPostgresDurableJobWorkUnitStore, durableJobWorkUnitSchemaSql } from "./durable-job-work-units";
import { createPostgresUcpIdempotencyStore } from "./ucp";

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
});
