import { describe, expect, it, vi } from "vitest";
import { drainOwnedProjector } from "../support/runtime-support/projectors";

describe("checkout owned projector drain", () => {
  it("runs the projector until it catches up", async () => {
    const runOnce = vi
      .fn()
      .mockResolvedValueOnce({ processed: 2, lastGlobalPosition: "2" })
      .mockResolvedValueOnce({ processed: 1, lastGlobalPosition: "3" })
      .mockResolvedValueOnce({ processed: 0, lastGlobalPosition: "3" });

    await drainOwnedProjector({ projectorName: "checkout.test", runOnce });

    expect(runOnce).toHaveBeenCalledTimes(3);
  });

  it("fails when a projector never catches up", async () => {
    const runOnce = vi.fn(async () => ({
      processed: 1,
      lastGlobalPosition: "1" as const,
    }));

    await expect(
      drainOwnedProjector({ projectorName: "checkout.test", runOnce }),
    ).rejects.toThrow("Checkout projector checkout.test did not catch up");
  });
});
