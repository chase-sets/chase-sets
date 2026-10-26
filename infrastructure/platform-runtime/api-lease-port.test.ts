import { describe, expect, it, vi } from "vitest";
import { createProjectionGroupLeasePort } from "./api";

function controlPlane(acquireLease: (input: unknown) => Promise<unknown>) {
  return {
    acquireLease,
    renewLease: vi.fn(async () => true),
    releaseLease: vi.fn(async () => undefined),
  } as never;
}

const group = { targetContextName: "catalog", projectionName: "catalog-items" };

describe("seed projection group lease port", () => {
  it("checks abort before retrying so no lease or work starts after timeout", async () => {
    let attempts = 0;
    const acquireLease = vi.fn(async () => {
      attempts += 1;
      return null;
    });
    const port = createProjectionGroupLeasePort(controlPlane(acquireLease), "platform-api");
    const abort = new AbortController();
    const work = vi.fn(async () => undefined);
    const result = port.runWithLease(group, abort.signal, work);
    setTimeout(() => abort.abort(), 10);

    await expect(result).rejects.toThrow(/cancelled|aborted/);
    expect(attempts).toBe(1);
    expect(work).not.toHaveBeenCalled();
  });

  it("retries a contended lease until the caller signal aborts instead of using a fixed 15-second outcome", async () => {
    const acquireLease = vi.fn(async () => null);
    const port = createProjectionGroupLeasePort(controlPlane(acquireLease), "platform-api");
    const abort = new AbortController();
    const started = Date.now();
    const result = port.runWithLease(group, abort.signal, async () => undefined);
    setTimeout(() => abort.abort(), 40);

    await expect(result).rejects.toThrow(/cancelled|aborted/);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(acquireLease).toHaveBeenCalled();
  });
});
