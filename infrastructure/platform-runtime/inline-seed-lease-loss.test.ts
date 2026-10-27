import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMockPoolState } from "../bounded-context-runtime/index-test-harness";

vi.mock("@chase-sets/event-core", async (original) => ({
  ...(await original<object>()),
  ...(await import("../bounded-context-runtime/index-test-harness")).createEventCoreMock(),
}));
vi.mock("@chase-sets/event-core-postgres", async (original) => ({
  ...(await original<object>()),
  ...(await import("../bounded-context-runtime/index-test-harness")).createEventCorePostgresMock(),
}));
vi.mock("../bounded-context-runtime/index", async (original) => ({
  ...(await original<object>()),
  bootstrapContextDatabase: vi.fn(async () => undefined),
  countEventsWithPrefix: vi.fn(async () => 1),
  seedApiModuleIfEmpty: vi.fn(async (module: { seed?: () => Promise<void> }) => module.seed?.()),
}));

import { createProjectionGroupLeasePort, seedApiHostIfEmpty } from "./api";
import type { PlatformControlPlane, PlatformLease } from "./control-plane";
import { createInlineSeedHarness, heldBootstrapLock } from "./inline-seed-test-support";

const LEASE_NAME = "projection-group:alpha.alpha-items";

// A synthetic control plane behind the real seed lease port. `acquire` decides each attempt; the
// attempt cap turns a retry loop that skips its wait into a rejection instead of a hang.
function syntheticControlPlane(acquire: (attempt: number) => Promise<PlatformLease | null>, maxAttempts = 5_000) {
  const trace: string[] = [];
  let attempts = 0;
  const acquireLease = vi.fn(async () => {
    attempts += 1;
    if (attempts > maxAttempts) throw new Error("lease acquisition retried without waiting");
    trace.push(`acquire#${attempts}`);
    const lease = await acquire(attempts);
    trace.push(lease ? `acquired#${attempts}:${lease.fencingToken}` : `missed#${attempts}`);
    return lease;
  });
  const releaseLease = vi.fn(async (lease: PlatformLease) => {
    trace.push(`release:${lease.fencingToken}`);
  });
  const controlPlane = { acquireLease, renewLease: vi.fn(async () => true), releaseLease };
  return { controlPlane: controlPlane as unknown as PlatformControlPlane, trace, acquireLease, releaseLease };
}

function lease(fencingToken: string): PlatformLease {
  return { leaseName: LEASE_NAME, ownerId: "seed:platform-api", fencingToken, expiresAt: "2026-10-26T00:02:00.000Z" };
}

function startSeed(
  state: ReturnType<typeof createInlineSeedHarness>,
  controlPlane: PlatformControlPlane,
  substepTimeoutMs: number,
  trace: string[],
) {
  let settled = false;
  const result = seedApiHostIfEmpty(state.registry, "platform-api", state.runtime, {
    enabledDataProfiles: ["critical-bootstrap"],
    environmentName: "test",
    fullBootstrapDrain: true,
    substepTimeoutMs,
    schemaBootstrapLockAcquisition: heldBootstrapLock(false),
    projectionGroupLeasePort: createProjectionGroupLeasePort(controlPlane, "platform-api"),
  }).then(
    () => {
      settled = true;
      trace.push("resolved");
    },
    (error: unknown) => {
      settled = true;
      trace.push("rejected");
      throw error;
    },
  );
  return { result, settled: () => settled };
}

const substepTimeout = (label: string, timeoutMs: number) =>
  expect.objectContaining({
    name: "SeedApiHostSubstepTimeoutError",
    code: "BOOTSTRAP_SEED_SUBSTEP_TIMEOUT",
    message: expect.stringContaining(`substep '${label}' exceeded ${timeoutMs}ms`),
  });

describe("inline seed lease loss (unit, real port and seed substeps)", () => {
  beforeEach(() => {
    resetMockPoolState();
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("times out a contended sync with the seed substep error and starts no acquisition after it", async () => {
    const state = createInlineSeedHarness();
    let now = 0;
    const plane = syntheticControlPlane(async () => (now >= 350 ? lease("7") : null));
    const seed = startSeed(state, plane.controlPlane, 150, plane.trace);
    const rejected = expect(seed.result).rejects.toEqual(substepTimeout("projection-sync:alpha", 150));

    // Settled state is asserted before awaiting, so a retry loop that ignores the abort fails here.
    await vi.advanceTimersByTimeAsync(151);
    expect(seed.settled()).toBe(true);
    expect(plane.acquireLease).toHaveBeenCalledTimes(1);
    await rejected;

    // The lease becomes free later; the rejected seed must not take it.
    now = 350;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(plane.acquireLease).toHaveBeenCalledTimes(1);
    expect(plane.trace).toEqual(["acquire#1", "missed#1", "rejected"]);
    expect(state.queries.filter((query) => query.startsWith("alpha:"))).toEqual([]);
    expect(state.writes).toEqual([]);
  });

  it("refuses and releases a lease that an in-flight acquire wins after the timeout abort, before the substep rejects", async () => {
    const state = createInlineSeedHarness();
    const plane = syntheticControlPlane(
      () => new Promise<PlatformLease>((resolve) => setTimeout(() => resolve(lease("9")), 200)),
    );
    const seed = startSeed(state, plane.controlPlane, 150, plane.trace);
    const rejected = expect(seed.result).rejects.toEqual(substepTimeout("projection-sync:alpha", 150));

    await vi.advanceTimersByTimeAsync(150);
    expect(seed.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(60);
    expect(seed.settled()).toBe(true);
    await rejected;

    expect(plane.trace).toEqual(["acquire#1", "acquired#1:9", "release:9", "rejected"]);
    expect(state.queries.filter((query) => query.startsWith("alpha:"))).toEqual([]);
    expect(state.writes).toEqual([]);
  });

  it("keeps waiting past 15 seconds inside a 600-second budget, then fails with the seed substep error", async () => {
    const state = createInlineSeedHarness();
    const plane = syntheticControlPlane(async () => null);
    const seed = startSeed(state, plane.controlPlane, 600_000, plane.trace);
    const rejected = expect(seed.result).rejects.toEqual(substepTimeout("projection-sync:alpha", 600_000));

    await vi.advanceTimersByTimeAsync(16_000);
    expect(seed.settled()).toBe(false);
    expect(plane.acquireLease.mock.calls.length).toBeGreaterThan(31);

    await vi.advanceTimersByTimeAsync(584_001);
    expect(seed.settled()).toBe(true);
    await rejected;
    expect(plane.releaseLease).not.toHaveBeenCalled();
    expect(state.writes).toEqual([]);
  });
});
