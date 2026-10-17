import { describe, expect, it, vi } from "vitest";
import { createEbayReceiptExpiryRunner } from "../api/expiry-runner";

describe("eBay receipt expiry lifecycle", () => {
  it("continues 500-row batches, yields at one second, completes only empty, and uses fixed-start cadence", async () => {
    let now = 0;
    let remaining = 1001;
    const store = {
      cutoff: vi.fn(async () => "2026-10-11T00:00:00Z"),
      batch: vi.fn(async () => {
        now += 600;
        const deleted = Math.min(remaining, 500);
        remaining -= deleted;
        return { deleted, remaining: remaining > 0 };
      }),
    };
    const logger = { info: vi.fn(), warn: vi.fn() };
    const runner = createEbayReceiptExpiryRunner(store, logger, () => now);
    const first = await runner.runOnce();
    expect(first.processed).toBe(1000);
    expect(runner.rescheduleOnCompletion?.(first)).toBe(true);
    expect(logger.info).not.toHaveBeenCalled();
    await runner.runOnce();
    expect(logger.info).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 3; i++) await runner.runOnce();
    expect(store.batch).toHaveBeenCalledTimes(3);
    now = 1800000;
    await runner.runOnce();
    expect(store.cutoff).toHaveBeenCalledTimes(2);
  });
  it("never completes a locked short batch and reports deadline then immediately resumes", async () => {
    let now = 0;
    const store = {
      cutoff: vi.fn(async () => "2026-10-11T00:00:00Z"),
      batch: vi.fn(async () => ({ deleted: 0, remaining: true })),
    };
    const logger = { info: vi.fn(), warn: vi.fn() };
    const runner = createEbayReceiptExpiryRunner(store, logger, () => now);
    await runner.runOnce();
    expect(logger.info).not.toHaveBeenCalled();
    now = 1800000;
    await expect(runner.runOnce()).rejects.toThrow("incomplete:deadline");
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ reason: "deadline" }));
    store.batch.mockResolvedValue({ deleted: 0, remaining: false });
    await runner.runOnce();
    expect(store.cutoff).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledTimes(1);
  });
  it("redacts database failures and reports interruption without success", async () => {
    const marker = "synthetic-subject-error-marker";
    const store = {
      cutoff: vi.fn(async () => "2026-10-11T00:00:00Z"),
      batch: vi.fn(async (): Promise<{ deleted: number; remaining: boolean }> => {
        throw new Error(marker);
      }),
    };
    const logger = { info: vi.fn(), warn: vi.fn() };
    const runner = createEbayReceiptExpiryRunner(store, logger);
    await expect(runner.runOnce()).rejects.toThrow("incomplete:database");
    await expect(runner.runOnce({ signal: AbortSignal.abort() })).rejects.toThrow("incomplete:interrupted");
    expect(logger.info).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(marker);
  });
});
