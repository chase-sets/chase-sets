import { describe, expect, it, vi } from "vitest";
import { runStartupRetry } from "../src/startup-retry";

describe("runStartupRetry", () => {
  it("returns successful startup operation results without logging retries", async () => {
    const logger = { warn: vi.fn(), error: vi.fn() };

    await expect(
      runStartupRetry({
        operationName: "bootstrap",
        run: async () => "ready",
        logger,
      }),
    ).resolves.toBe("ready");
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("retries transient startup failures within the retry budget", async () => {
    let currentTime = 0;
    const logger = { warn: vi.fn(), error: vi.fn() };
    const run = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error("Connection terminated unexpectedly"));

    run.mockResolvedValueOnce("ready");

    await expect(
      runStartupRetry({
        operationName: "heartbeat",
        run,
        logger,
        retryBudgetMs: 5_000,
        retryDelayMs: 1_000,
        now: () => currentTime,
        sleep: async (ms) => {
          currentTime += ms;
        },
      }),
    ).resolves.toBe("ready");

    expect(run).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      "Worker startup operation failed; retrying.",
      expect.objectContaining({
        type: "platform-worker.startup_retry.retrying",
        operationName: "heartbeat",
        attempt: 1,
        delayMs: 1_000,
      }),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("rethrows after the retry budget is exhausted", async () => {
    let currentTime = 0;
    const logger = { warn: vi.fn(), error: vi.fn() };
    const failure = new Error("Connection terminated unexpectedly");

    await expect(
      runStartupRetry({
        operationName: "bootstrap",
        run: async () => {
          throw failure;
        },
        logger,
        retryBudgetMs: 1_000,
        retryDelayMs: 1_000,
        now: () => currentTime,
        sleep: async (ms) => {
          currentTime += ms;
        },
      }),
    ).rejects.toBe(failure);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      "Worker startup operation failed after retry budget.",
      expect.objectContaining({
        type: "platform-worker.startup_retry.exhausted",
        operationName: "bootstrap",
        attempt: 2,
        retryBudgetMs: 1_000,
      }),
    );
  });
});
