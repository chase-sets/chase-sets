import { describe, expect, it, vi } from "vitest";
import { createEbayAccountDeletionConsumerRunner } from "../api/consumer-runner";
import { ebayReceiptRetention } from "../domain/policy";

describe("eBay deletion consumer runner", () => {
  it("continues bounded pages past unmatched rows, starts fixed sweeps and starts immediately after restart", async () => {
    let now = 0;
    const page = Array.from({ length: ebayReceiptRetention.batchSize }, (_, i) => `synthetic-${i}`);
    const consumer = {
      batch: vi.fn(async (after: string | null) => (after === null ? page : ["synthetic-later"])),
      consume: vi.fn(async (id: string) => (id === "synthetic-later" ? 1 : 0)),
    };
    const logger = { info: vi.fn(), warn: vi.fn() };
    const control = {
      claimScheduledRunner: vi.fn(async () => false),
      recordScheduledRunnerCompleted: vi.fn(async () => {}),
    };
    const runner = createEbayAccountDeletionConsumerRunner(consumer, logger, control, () => now);
    const first = await runner.runOnce();
    expect(first.processed).toBe(0);
    expect(runner.rescheduleOnCompletion?.(first)).toBe(true);
    expect(control.recordScheduledRunnerCompleted).not.toHaveBeenCalled();
    const second = await runner.runOnce();
    expect(second.processed).toBe(1);
    expect(consumer.batch).toHaveBeenNthCalledWith(2, page.at(-1));
    expect(runner.rescheduleOnCompletion?.(second)).toBe(false);
    await runner.runOnce();
    expect(consumer.batch).toHaveBeenCalledTimes(2);
    now = ebayReceiptRetention.sweepSeconds * 1000;
    await runner.runOnce();
    expect(consumer.batch).toHaveBeenLastCalledWith(null);
    await createEbayAccountDeletionConsumerRunner(consumer, logger, control, () => now).runOnce();
    expect(consumer.batch).toHaveBeenCalledTimes(4);
  });
  it("never consumes after interruption or lease loss, and retries incomplete work", async () => {
    const consumer = { batch: vi.fn(async () => ["synthetic-notice"]), consume: vi.fn(async () => 1) };
    const logger = { info: vi.fn(), warn: vi.fn() };
    const runner = createEbayAccountDeletionConsumerRunner(consumer, logger);
    await expect(runner.runOnce({ signal: AbortSignal.abort() })).rejects.toThrow("incomplete");
    await expect(
      runner.runOnce({
        throwIfLeaseLost: () => {
          throw new Error("private-lease-error");
        },
      }),
    ).rejects.toThrow("incomplete");
    expect(consumer.consume).not.toHaveBeenCalled();
    expect((await runner.runOnce()).processed).toBe(1);
  });
});
