import { describe, expect, it, vi } from "vitest";
import type { FreshWriteReceipt } from "@chase-sets/http/responses";
import { createInvitationProjectionFreshnessWaiter } from "./invitation-projection-freshness";

function invitationReceipt(maxGlobalPosition: string): FreshWriteReceipt {
  return {
    observedAtMs: 1,
    sources: [{ sourceContextName: "identity", maxGlobalPosition, eventIds: [`evt_${maxGlobalPosition}`] }],
  };
}

describe("invitation projection freshness waiter", () => {
  it("proceeds immediately when the projection already reached the forwarded target version", async () => {
    const readInvitationProjectionPosition = vi.fn(async () => "9");
    const wait = createInvitationProjectionFreshnessWaiter({
      readInvitationProjectionPosition,
      timeoutMs: 100,
      pollIntervalMs: 1,
    });

    await wait(invitationReceipt("5"));

    expect(readInvitationProjectionPosition).toHaveBeenCalledTimes(1);
  });

  it("waits until the projection catches up to the forwarded target version, then proceeds", async () => {
    let position = "1";
    let reads = 0;
    const readInvitationProjectionPosition = vi.fn(async () => {
      reads += 1;
      if (reads >= 3) {
        position = "5";
      }
      return position;
    });
    const wait = createInvitationProjectionFreshnessWaiter({
      readInvitationProjectionPosition,
      timeoutMs: 1_000,
      pollIntervalMs: 1,
    });

    const startedAt = performance.now();
    await wait(invitationReceipt("5"));

    // It kept polling while behind and only settled once the checkpoint reached
    // exactly the forwarded target version (5), well inside the bound.
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(performance.now() - startedAt).toBeLessThan(900);
  });

  it("does not treat a position one short of the target version as fresh", async () => {
    const readInvitationProjectionPosition = vi.fn(async () => "4");
    const wait = createInvitationProjectionFreshnessWaiter({
      readInvitationProjectionPosition,
      timeoutMs: 60,
      pollIntervalMs: 1,
    });

    const startedAt = performance.now();
    await wait(invitationReceipt("5"));
    const elapsed = performance.now() - startedAt;

    // Never reaches 5, so it must poll to the bound rather than settling early.
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(readInvitationProjectionPosition.mock.calls.length).toBeGreaterThan(1);
  });

  it("falls back gracefully and bounded when the projection never catches up", async () => {
    const readInvitationProjectionPosition = vi.fn(async () => "1");
    const wait = createInvitationProjectionFreshnessWaiter({
      readInvitationProjectionPosition,
      timeoutMs: 50,
      pollIntervalMs: 1,
    });

    const startedAt = performance.now();
    // Must resolve (no throw) so the caller can read the projection as-is.
    await expect(wait(invitationReceipt("5"))).resolves.toBeUndefined();
    const elapsed = performance.now() - startedAt;

    // Bounded: waited to roughly the timeout, and nowhere near an unbounded hang.
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(2_000);
  });

  it("never throws when the checkpoint read fails", async () => {
    const readInvitationProjectionPosition = vi.fn(async () => {
      throw new Error("checkpoint database unavailable");
    });
    const wait = createInvitationProjectionFreshnessWaiter({
      readInvitationProjectionPosition,
      timeoutMs: 50,
      pollIntervalMs: 1,
    });

    await expect(wait(invitationReceipt("5"))).resolves.toBeUndefined();
  });
});
