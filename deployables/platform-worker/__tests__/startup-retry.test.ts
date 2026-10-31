import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runStartupRetry } from "../src/startup-retry";

const startupRetryModuleUrl = pathToFileURL(fileURLToPath(new URL("../src/startup-retry.ts", import.meta.url))).href;
const startupRetryWorkingDirectory = fileURLToPath(new URL("..", import.meta.url));

function runStartupRetryChild(source: string) {
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
    cwd: startupRetryWorkingDirectory,
    encoding: "utf8",
    timeout: 60_000,
  });
}

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

  it("keeps the real retry sleep alive for a transient failure in a child process", () => {
    const result = runStartupRetryChild(`
      import { runStartupRetry } from ${JSON.stringify(startupRetryModuleUrl)};
      let attempts = 0;
      const value = await runStartupRetry({
        operationName: "child-transient",
        retryBudgetMs: 5_000,
        retryDelayMs: 250,
        run: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("transient");
          return "ready";
        },
      });
      process.stdout.write(JSON.stringify({ attempts, value }));
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('{"attempts":2,"value":"ready"}');
  });

  it("logs exhaustion and exits non-zero in a child process using the real retry sleep", () => {
    const result = runStartupRetryChild(`
      import { runStartupRetry } from ${JSON.stringify(startupRetryModuleUrl)};
      await runStartupRetry({
        operationName: "child-exhausted",
        retryBudgetMs: 1_000,
        retryDelayMs: 250,
        logger: {
          error: (message, fields) => process.stdout.write(JSON.stringify({ message, fields }) + "\\n"),
        },
        run: async () => { throw new Error("persistent"); },
      });
    `);

    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('"type":"platform-worker.startup_retry.exhausted"');
  });
});
