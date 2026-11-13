import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectionGroupLeasePort } from "./api";
import type { PlatformControlPlane } from "./control-plane";

const group = { targetContextName: "catalog", projectionName: "catalog-items" };

// Always contended. The attempt cap turns a retry loop that skips its wait into a rejection
// instead of an unbounded microtask loop.
function contendedControlPlane(maxAttempts: number) {
  let attempts = 0;
  const acquireLease = vi.fn(async () => {
    attempts += 1;
    if (attempts > maxAttempts) throw new Error("lease acquisition retried without waiting");
    return null;
  });
  const controlPlane = {
    acquireLease,
    renewLease: vi.fn(async () => true),
    releaseLease: vi.fn(async () => undefined),
  } as unknown as PlatformControlPlane;
  return { controlPlane, acquireLease };
}

describe("seed projection group lease port", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("checks abort before retrying so no lease or work starts after timeout", async () => {
    const { controlPlane, acquireLease } = contendedControlPlane(20);
    const port = createProjectionGroupLeasePort(controlPlane, "platform-api");
    const abort = new AbortController();
    const work = vi.fn(async () => undefined);
    let settled = false;
    const result = port.runWithLease(group, abort.signal, work).finally(() => {
      settled = true;
    });
    const rejected = expect(result).rejects.toThrow(/cancelled/);

    await vi.advanceTimersByTimeAsync(10);
    abort.abort();
    // Settled state is asserted before awaiting, so a retry loop that ignores the abort fails here.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(true);
    expect(acquireLease).toHaveBeenCalledTimes(1);
    expect(work).not.toHaveBeenCalled();
    await rejected;
  });

  it("retries a contended lease until the caller signal aborts instead of using a fixed 15-second outcome", async () => {
    const { controlPlane, acquireLease } = contendedControlPlane(1_000);
    const port = createProjectionGroupLeasePort(controlPlane, "platform-api");
    const abort = new AbortController();
    const work = vi.fn(async () => undefined);
    let settled = false;
    const result = port.runWithLease(group, abort.signal, work).finally(() => {
      settled = true;
    });
    const rejected = expect(result).rejects.toThrow(/cancelled/);

    await vi.advanceTimersByTimeAsync(16_000);
    expect(settled).toBe(false);
    expect(acquireLease.mock.calls.length).toBeGreaterThan(31);

    abort.abort();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(true);
    expect(work).not.toHaveBeenCalled();
    await rejected;
  });
});
