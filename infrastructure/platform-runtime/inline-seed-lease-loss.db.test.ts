import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  appendTargetItem,
  createInlineSeedDbFixture,
  createRecordingControlPlane,
  createTargetRegistry,
  holdTargetLease,
  readProjectedItems,
  readTargetCheckpoint,
  readTargetLeases,
  seedTarget,
  SEED_OWNER,
  TARGET_LEASE_NAME,
} from "./inline-seed-db-test-support";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const HOLDER_OWNER = "platform-worker-1";
const THIEF_OWNER = "platform-worker-2";
// Longer than two seed lease retry intervals (500 ms), so a late acquisition would be recorded.
const RETRY_QUIET_PERIOD_MS = 1_200;

const substepTimeout = (timeoutMs: number) =>
  expect.objectContaining({
    name: "SeedApiHostSubstepTimeoutError",
    code: "BOOTSTRAP_SEED_SUBSTEP_TIMEOUT",
    message: expect.stringContaining(`substep 'projection-sync:target' exceeded ${timeoutMs}ms`),
  });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describeDb("inline seed lease loss (real Postgres)", () => {
  const fixture = createInlineSeedDbFixture("inline_seed_lease_loss");
  const pools = () => fixture.pools();

  beforeAll(fixture.beforeAll);
  beforeEach(fixture.beforeEach);
  afterAll(fixture.afterAll);

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function seededOnce(plane: ReturnType<typeof createRecordingControlPlane>) {
    await appendTargetItem(pools(), "item-1");
    await seedTarget(pools(), createTargetRegistry({}), plane.recording);
    const checkpoint = await readTargetCheckpoint(pools());
    await appendTargetItem(pools(), "item-2");
    plane.trace.length = 0;
    return checkpoint;
  }

  it("misses until the caller's substep deadline, fails with the seed substep error, and never acquires afterwards", async () => {
    const plane = createRecordingControlPlane(pools().platform);
    const before = await seededOnce(plane);
    const holder = await holdTargetLease(plane.controlPlane, HOLDER_OWNER);

    await expect(
      seedTarget(pools(), createTargetRegistry({}), plane.recording, { substepTimeoutMs: 3_000 }),
    ).rejects.toEqual(substepTimeout(3_000));
    const attemptsAtRejection = plane.seedAttempts();
    expect(attemptsAtRejection).toBeGreaterThanOrEqual(2);
    expect(plane.trace.filter((entry) => entry.ownerId === SEED_OWNER).map((entry) => entry.operation)).toEqual(
      Array.from({ length: attemptsAtRejection }, () => "missed"),
    );

    await sleep(RETRY_QUIET_PERIOD_MS);
    expect(plane.seedAttempts()).toBe(attemptsAtRejection);
    expect(await readProjectedItems(pools())).toEqual(["item-1"]);
    expect(await readTargetCheckpoint(pools())).toEqual(before);
    expect(await readTargetLeases(plane.controlPlane)).toEqual([
      { ownerId: HOLDER_OWNER, fencingToken: holder.lease.fencingToken },
    ]);
    await holder.release();
  });

  it("does not take a holder's lease that expires after the seed rejected", async () => {
    const plane = createRecordingControlPlane(pools().platform);
    const before = await seededOnce(plane);
    // Never renewed; its TTL outlasts the seed's schema bootstrap plus the sync deadline, then lapses.
    const holder = await holdTargetLease(plane.controlPlane, HOLDER_OWNER, { ttlMs: 8_000 });

    await expect(
      seedTarget(pools(), createTargetRegistry({}), plane.recording, { substepTimeoutMs: 2_500 }),
    ).rejects.toEqual(substepTimeout(2_500));
    const attemptsAtRejection = plane.seedAttempts();
    await vi.waitFor(
      async () => {
        const expired = await pools().platform.query(
          "SELECT 1 FROM platform_control_leases WHERE lease_name = $1 AND expires_at <= now()",
          [TARGET_LEASE_NAME],
        );
        expect(expired.rowCount).toBe(1);
      },
      { timeout: 20_000, interval: 100 },
    );
    await sleep(RETRY_QUIET_PERIOD_MS);

    expect(plane.seedAttempts()).toBe(attemptsAtRejection);
    expect(plane.trace.filter((entry) => entry.operation === "acquired" && entry.ownerId === SEED_OWNER)).toEqual([]);
    expect(await readTargetLeases(plane.controlPlane)).toEqual([
      { ownerId: HOLDER_OWNER, fencingToken: holder.lease.fencingToken },
    ]);
    expect(await readProjectedItems(pools())).toEqual(["item-1"]);
    expect(await readTargetCheckpoint(pools())).toEqual(before);
  });

  // Another owner takes the expired lease mid-work, then the seed's next renewal tick runs and is refused.
  async function stealLeaseAndRenew(plane: ReturnType<typeof createRecordingControlPlane>) {
    await pools().platform.query(
      "UPDATE platform_control_leases SET expires_at = now() - interval '1 second' WHERE lease_name = $1",
      [TARGET_LEASE_NAME],
    );
    const thief = await holdTargetLease(plane.controlPlane, THIEF_OWNER);
    vi.advanceTimersByTime(30_000);
    await Promise.all(plane.renewals);
    await new Promise((resolve) => setImmediate(resolve));
    return thief;
  }

  async function expectLossLeftNoPartialCommit(
    plane: ReturnType<typeof createRecordingControlPlane>,
    before: Awaited<ReturnType<typeof readTargetCheckpoint>>,
    thief: Awaited<ReturnType<typeof holdTargetLease>> | undefined,
  ) {
    expect(plane.trace).toContainEqual(expect.objectContaining({ ownerId: SEED_OWNER, operation: "renewal-refused" }));
    expect(await readProjectedItems(pools())).toEqual(["item-1"]);
    expect(await readTargetCheckpoint(pools())).toEqual(before);
    // The seed released only its own token; the new owner's lease survives.
    expect(await readTargetLeases(plane.controlPlane)).toEqual([
      { ownerId: THIEF_OWNER, fencingToken: thief!.lease.fencingToken },
    ]);
    const seedTokens = plane.trace
      .filter((entry) => entry.ownerId === SEED_OWNER && entry.operation === "acquired")
      .map((entry) => entry.fencingToken);
    expect(
      plane.trace
        .filter((entry) => entry.ownerId === SEED_OWNER && entry.operation === "released")
        .map((entry) => entry.fencingToken),
    ).toEqual(seedTokens);
  }

  it("aborts a reset whose lease renewal is lost and commits none of the reset", async () => {
    const plane = createRecordingControlPlane(pools().platform);
    const before = await seededOnce(plane);
    let thief: Awaited<ReturnType<typeof holdTargetLease>> | undefined;
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    // Revision 2 makes the seed's required sync rebuild the group through this reset.
    const registry = createTargetRegistry(
      {
        onReset: async (db: PgQueryable) => {
          await db.query("DELETE FROM projected_items");
          thief = await stealLeaseAndRenew(plane);
        },
      },
      2,
    );

    await expect(seedTarget(pools(), registry, plane.recording)).rejects.toThrow(`Lost lease '${TARGET_LEASE_NAME}'.`);
    await expectLossLeftNoPartialCommit(plane, before, thief);
  });

  it("aborts a drain whose lease renewal is lost and commits none of the drained event", async () => {
    const plane = createRecordingControlPlane(pools().platform);
    const before = await seededOnce(plane);
    let thief: Awaited<ReturnType<typeof holdTargetLease>> | undefined;
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const registry = createTargetRegistry({
      beforeProject: async (itemId) => {
        if (itemId === "item-2" && !thief) thief = await stealLeaseAndRenew(plane);
      },
    });

    await expect(seedTarget(pools(), registry, plane.recording)).rejects.toThrow(`Lost lease '${TARGET_LEASE_NAME}'.`);
    await expectLossLeftNoPartialCommit(plane, before, thief);
  });
});
