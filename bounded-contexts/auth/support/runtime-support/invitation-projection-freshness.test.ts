import { afterEach, describe, expect, it, vi } from "vitest";
import type { FreshWriteReceipt } from "@chase-sets/http/responses";
import { createInvitationProjectionFreshnessWaiter } from "./invitation-projection-freshness";

function invitationReceipt(maxGlobalPosition: string): FreshWriteReceipt {
  return {
    observedAtMs: 1,
    sources: [{ sourceContextName: "identity", maxGlobalPosition, eventIds: [`evt_${maxGlobalPosition}`] }],
  };
}

function trackSettlement(wait: Promise<void>) {
  const settlement = { settled: false, wait };
  const markSettled = () => {
    settlement.settled = true;
  };
  void wait.then(markSettled, markSettled);
  return settlement;
}

describe("invitation projection freshness waiter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
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
      nowMs: () => Date.now(),
    });

    const settlement = trackSettlement(wait(invitationReceipt("5")));

    // It keeps polling while behind and settles on the third read, once the
    // checkpoint reached exactly the forwarded target version (5), two fake
    // milliseconds into a 1s timeout.
    await vi.advanceTimersByTimeAsync(1);
    expect(settlement.settled, "settled before the checkpoint caught up").toBe(false);
    expect(reads).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(settlement.settled, "did not settle after the catch-up read").toBe(true);
    expect(reads).toBe(3);
    await expect(settlement.wait).resolves.toBeUndefined();
  });

  it("does not treat a position one short of the target version as fresh", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const readInvitationProjectionPosition = vi.fn(async () => "4");
    const timeoutMs = 60;
    const wait = createInvitationProjectionFreshnessWaiter({
      readInvitationProjectionPosition,
      timeoutMs,
      pollIntervalMs: 1,
      nowMs: () => Date.now(),
    });

    const settlement = trackSettlement(wait(invitationReceipt("5")));

    // Never reaches 5, so it must poll to the bound rather than settling early.
    await vi.advanceTimersByTimeAsync(timeoutMs - 1);
    expect(settlement.settled, "one-short position was treated as fresh").toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settlement.settled, "did not settle at the timeout").toBe(true);
    expect(readInvitationProjectionPosition.mock.calls.length).toBeGreaterThan(1);
    await expect(settlement.wait).resolves.toBeUndefined();
  });

  it("falls back gracefully and bounded when the projection never catches up", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const readInvitationProjectionPosition = vi.fn(async () => "1");
    const timeoutMs = 50;
    const wait = createInvitationProjectionFreshnessWaiter({
      readInvitationProjectionPosition,
      timeoutMs,
      pollIntervalMs: 1,
      nowMs: () => Date.now(),
    });

    const settlement = trackSettlement(wait(invitationReceipt("5")));

    // Bounded: still waiting just before the timeout, then settled at it.
    await vi.advanceTimersByTimeAsync(timeoutMs - 1);
    expect(settlement.settled, "settled before the timeout").toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settlement.settled, "did not settle at the timeout").toBe(true);
    // Must resolve (no throw) so the caller can read the projection as-is.
    await expect(settlement.wait).resolves.toBeUndefined();
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
