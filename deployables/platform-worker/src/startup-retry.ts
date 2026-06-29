export type StartupRetryLogger = Readonly<{
  warn?: (message: string, fields?: Record<string, unknown>) => void;
  error?: (message: string, fields?: Record<string, unknown>) => void;
}>;

export type StartupRetryOptions<T> = Readonly<{
  operationName: string;
  run: () => Promise<T>;
  logger?: StartupRetryLogger;
  retryBudgetMs?: number;
  retryDelayMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}>;

const defaultRetryBudgetMs = 60_000;
const defaultRetryDelayMs = 1_000;

export async function runStartupRetry<T>(options: StartupRetryOptions<T>): Promise<T> {
  const retryBudgetMs = positiveInteger(options.retryBudgetMs, defaultRetryBudgetMs);
  const retryDelayMs = positiveInteger(options.retryDelayMs, defaultRetryDelayMs);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const startedAtMs = now();
  let attempt = 0;

  for (;;) {
    attempt += 1;
    try {
      return await options.run();
    } catch (error) {
      const elapsedMs = Math.max(0, now() - startedAtMs);
      const remainingMs = retryBudgetMs - elapsedMs;

      if (remainingMs <= 0) {
        options.logger?.error?.("Worker startup operation failed after retry budget.", {
          type: "platform-worker.startup_retry.exhausted",
          operationName: options.operationName,
          attempt,
          retryBudgetMs,
          elapsedMs,
          error,
        });
        throw error;
      }

      const delayMs = Math.min(retryDelayMs, remainingMs);
      options.logger?.warn?.("Worker startup operation failed; retrying.", {
        type: "platform-worker.startup_retry.retrying",
        operationName: options.operationName,
        attempt,
        retryBudgetMs,
        elapsedMs,
        delayMs,
        error,
      });
      await sleep(delayMs);
    }
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.floor(value) : fallback;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, Math.max(0, ms));
    timeout.unref?.();
  });
}
