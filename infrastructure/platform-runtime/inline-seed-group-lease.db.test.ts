import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { syncProjectionGroup } from "../bounded-context-runtime/index";
import { createApiHost, createProjectionGroupLeasePort } from "./api";
import {
  appendTargetItem,
  createInlineSeedDbFixture,
  createRecordingControlPlane,
  createTargetRegistry,
  deferred,
  holdTargetLease,
  readProjectedItems,
  readTargetCheckpoint,
  readTargetLeases,
  seedTarget,
  SEED_OWNER,
  TARGET_GROUP,
  TARGET_LEASE_NAME,
  type LeaseTraceEntry,
} from "./inline-seed-db-test-support";
import {
  createProjectionGroupRunnerLeaseName,
  createProjectionGroupWorkerRunner,
  tryRunWithRenewedLease,
} from "./worker";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const WORKER_OWNER = "platform-worker-1";
const OPERATION_OWNER = "platform-worker-1:projection-operations";
const waitForSeedMisses = { timeout: 20_000, interval: 50 };

const tokensOf = (trace: readonly LeaseTraceEntry[], ownerId: string, operation: LeaseTraceEntry["operation"]) =>
  trace
    .filter((entry) => entry.ownerId === ownerId && entry.operation === operation)
    .map((entry) => entry.fencingToken!);

describeDb("inline seed group lease (real Postgres)", () => {
  const fixture = createInlineSeedDbFixture("inline_seed_group_lease");
  const pools = () => fixture.pools();

  beforeAll(fixture.beforeAll);
  beforeEach(fixture.beforeEach);
  afterAll(fixture.afterAll);

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("writes checkpoints with the seed owner and fencing token and releases every lease by exact token", async () => {
    const plane = createRecordingControlPlane(pools().platform);
    await appendTargetItem(pools(), "item-1");

    await seedTarget(pools(), createTargetRegistry({}), plane.recording);

    const acquired = tokensOf(plane.trace, SEED_OWNER, "acquired");
    expect(acquired.length).toBeGreaterThan(0);
    expect(tokensOf(plane.trace, SEED_OWNER, "released")).toEqual(acquired);
    expect(await readProjectedItems(pools())).toEqual(["item-1"]);
    const checkpoint = await readTargetCheckpoint(pools());
    expect(checkpoint).toMatchObject({ checkpoint: "1", ownerId: SEED_OWNER });
    expect(acquired).toContain(checkpoint?.fencingToken);
    expect(await readTargetLeases(plane.controlPlane)).toEqual([]);
  });

  it("waits while a worker group runner holds the lease, advances nothing, then takes over after the worker yields", async () => {
    const plane = createRecordingControlPlane(pools().platform);
    const registry = createTargetRegistry({});
    await appendTargetItem(pools(), "item-1");
    await seedTarget(pools(), registry, plane.recording);
    const before = await readTargetCheckpoint(pools());
    await appendTargetItem(pools(), "item-2");
    plane.trace.length = 0;

    const workerGroup = createApiHost(registry, "platform-api", { pools: pools() }).projectionGroups[0]!;
    const yieldGate = deferred();
    const worker = tryRunWithRenewedLease(
      plane.recording,
      {
        leaseName: createProjectionGroupRunnerLeaseName(workerGroup),
        ownerId: WORKER_OWNER,
        ttlMs: 120_000,
        renewIntervalMs: 30_000,
        metadata: { origin: "projection-group-worker" },
      },
      async (context) => {
        await yieldGate.promise;
        return createProjectionGroupWorkerRunner(workerGroup).runOnce(context);
      },
    );
    await vi.waitFor(() => expect(tokensOf(plane.trace, WORKER_OWNER, "acquired")).toHaveLength(1));
    const seed = seedTarget(pools(), registry, plane.recording);
    await vi.waitFor(() => expect(plane.seedAttempts()).toBeGreaterThanOrEqual(2), waitForSeedMisses);

    expect(tokensOf(plane.trace, SEED_OWNER, "acquired")).toEqual([]);
    expect(await readProjectedItems(pools())).toEqual(["item-1"]);
    expect(await readTargetCheckpoint(pools())).toEqual(before);

    yieldGate.resolve();
    // The worker, not the waiting seed, projects item-2; the seed then finds nothing left to apply.
    await expect(worker).resolves.toMatchObject({ acquired: true, result: { processed: 1 } });
    await seed;

    const [workerToken] = tokensOf(plane.trace, WORKER_OWNER, "acquired");
    const seedTokens = tokensOf(plane.trace, SEED_OWNER, "acquired");
    const workerRelease = plane.trace.findIndex(
      (entry) => entry.ownerId === WORKER_OWNER && entry.operation === "released",
    );
    const firstSeedAcquire = plane.trace.findIndex(
      (entry) => entry.ownerId === SEED_OWNER && entry.operation === "acquired",
    );
    expect(firstSeedAcquire).toBeGreaterThan(workerRelease);
    expect(seedTokens.every((token) => BigInt(token) > BigInt(workerToken!))).toBe(true);
    expect(await readProjectedItems(pools())).toEqual(["item-1", "item-2"]);
    expect(await readTargetCheckpoint(pools())).toMatchObject({ checkpoint: "2" });
    expect(await readTargetLeases(plane.controlPlane)).toEqual([]);
  });

  it("never resets, truncates, or deletes checkpoints of a stale group while a projection operation holds its lease", async () => {
    const plane = createRecordingControlPlane(pools().platform);
    await appendTargetItem(pools(), "item-1");
    await seedTarget(pools(), createTargetRegistry({}, 1), plane.recording);
    const before = await readTargetCheckpoint(pools());
    await appendTargetItem(pools(), "item-2");
    plane.trace.length = 0;

    const operation = await holdTargetLease(plane.recording, OPERATION_OWNER, {
      metadata: { origin: "projection-operation", operationId: "op-1" },
    });
    // Revision 2 makes the seed's first sync rebuild the group: truncate, delete checkpoints, replay.
    const seed = seedTarget(pools(), createTargetRegistry({}, 2), plane.recording);
    await vi.waitFor(() => expect(plane.seedAttempts()).toBeGreaterThanOrEqual(2), waitForSeedMisses);

    expect(tokensOf(plane.trace, SEED_OWNER, "acquired")).toEqual([]);
    expect(await readProjectedItems(pools())).toEqual(["item-1"]);
    expect(await readTargetCheckpoint(pools())).toEqual(before);

    await operation.release();
    await seed;

    const [rebuildToken] = tokensOf(plane.trace, SEED_OWNER, "acquired");
    expect(BigInt(rebuildToken!)).toBeGreaterThan(BigInt(operation.lease.fencingToken));
    expect(await readProjectedItems(pools())).toEqual(["item-1", "item-2"]);
    const rebuilt = await readTargetCheckpoint(pools());
    expect(rebuilt).toMatchObject({ checkpoint: "2", ownerId: SEED_OWNER });
    expect(BigInt(rebuilt!.fencingToken!)).toBeGreaterThanOrEqual(BigInt(rebuildToken!));
    expect(await readTargetLeases(plane.controlPlane)).toEqual([]);
  });

  it("fences a same-host seed reclaim: the token bumps and the stale seed holder's refused renewal stops it before any write", async () => {
    const plane = createRecordingControlPlane(pools().platform);
    const registry = createTargetRegistry({});
    await appendTargetItem(pools(), "item-1");
    await seedTarget(pools(), registry, plane.recording);
    await appendTargetItem(pools(), "item-2");
    // Renewal ticks run only when the test advances them; acquisition retries keep real timeouts.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

    const acquiredByStaleHolder = deferred();
    const staleGate = deferred();
    let staleToken: string | undefined;
    const staleHolder = createProjectionGroupLeasePort(plane.recording, "platform-api").runWithLease(
      TARGET_GROUP,
      new AbortController().signal,
      async (context) => {
        staleToken = context.fencingToken;
        acquiredByStaleHolder.resolve();
        await staleGate.promise;
        const staleGroup = createApiHost(registry, "platform-api", { pools: pools() }).projectionGroups[0]!;
        await syncProjectionGroup(staleGroup, context);
      },
    );
    await acquiredByStaleHolder.promise;

    // The same owner id reclaims the live lease at once with a higher fencing token.
    await seedTarget(pools(), registry, plane.recording);
    const reclaimTokens = tokensOf(plane.trace, SEED_OWNER, "acquired").filter(
      (token) => BigInt(token) > BigInt(staleToken!),
    );
    expect(reclaimTokens.length).toBeGreaterThan(0);
    expect(await readProjectedItems(pools())).toEqual(["item-1", "item-2"]);
    const reclaimed = await readTargetCheckpoint(pools());
    expect(reclaimTokens).toContain(reclaimed?.fencingToken);

    vi.advanceTimersByTime(30_000);
    await Promise.all(plane.renewals);
    await new Promise((resolve) => setImmediate(resolve));
    expect(plane.trace).toContainEqual({ operation: "renewal-refused", ownerId: SEED_OWNER, fencingToken: staleToken });

    await appendTargetItem(pools(), "item-3");
    staleGate.resolve();
    await expect(staleHolder).rejects.toThrow(`Lost lease '${TARGET_LEASE_NAME}'.`);
    expect(await readProjectedItems(pools())).toEqual(["item-1", "item-2"]);
    expect(await readTargetCheckpoint(pools())).toEqual(reclaimed);
    expect(await readTargetLeases(plane.controlPlane)).toEqual([]);
  });
});
