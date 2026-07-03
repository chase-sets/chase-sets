export type RuntimeLifecycleStopHandle = Readonly<{
  name: string;
  stop: () => Promise<void> | void;
}>;

export type RuntimeLifecycleLogger = Readonly<{
  warn?: (message: string, fields?: Record<string, unknown>) => void;
  error?: (message: string, fields?: Record<string, unknown>) => void;
}>;

export type RuntimeLifecycleRegistry = Readonly<{
  register: (handle: RuntimeLifecycleStopHandle) => () => void;
  stopAll: (options?: RuntimeLifecycleStopOptions) => Promise<readonly RuntimeLifecycleStopResult[]>;
  size: () => number;
}>;

export type RuntimeLifecycleStopOptions = Readonly<{
  timeoutMs?: number;
  logger?: RuntimeLifecycleLogger;
}>;

export type RuntimeLifecycleStopResult = Readonly<
  | {
      name: string;
      status: "stopped";
    }
  | {
      name: string;
      status: "failed";
      error: unknown;
    }
  | {
      name: string;
      status: "timeout";
    }
>;

const DEFAULT_RUNTIME_LIFECYCLE_STOP_TIMEOUT_MS = 30_000;
const runtimeLifecycleRegistries = new WeakMap<object, RuntimeLifecycleRegistry>();

export function createRuntimeLifecycleRegistry(): RuntimeLifecycleRegistry {
  const handles = new Set<RuntimeLifecycleStopHandle>();

  return {
    register: (handle) => {
      handles.add(handle);
      return () => {
        handles.delete(handle);
      };
    },
    stopAll: async (options = {}) => {
      const timeoutMs = normalizeTimeoutMs(options.timeoutMs, DEFAULT_RUNTIME_LIFECYCLE_STOP_TIMEOUT_MS);
      const pending = [...handles];
      const results = await Promise.all(pending.map((handle) => stopHandle(handle, timeoutMs)));

      for (const result of results) {
        if (result.status === "failed") {
          options.logger?.error?.("Runtime lifecycle stop handle failed.", {
            type: "runtime.lifecycle.stop.failed",
            handleName: result.name,
            error: result.error,
          });
        }
        if (result.status === "timeout") {
          options.logger?.warn?.("Runtime lifecycle stop handle timed out.", {
            type: "runtime.lifecycle.stop.timeout",
            handleName: result.name,
            timeoutMs,
          });
        }
      }

      return results;
    },
    size: () => handles.size,
  };
}

export function attachRuntimeLifecycleRegistry<TValue>(
  value: TValue,
  registry: RuntimeLifecycleRegistry | undefined,
): TValue {
  if (registry && typeof value === "object" && value !== null) {
    runtimeLifecycleRegistries.set(value, registry);
  }

  return value;
}

export function getRuntimeLifecycleRegistry(value: unknown): RuntimeLifecycleRegistry | undefined {
  return typeof value === "object" && value !== null ? runtimeLifecycleRegistries.get(value) : undefined;
}

export async function runWithRuntimeLifecycleTimeout<T>(
  name: string,
  operation: () => Promise<T> | T,
  options: RuntimeLifecycleStopOptions = {},
): Promise<RuntimeLifecycleStopResult & Readonly<{ value?: T }>> {
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs, DEFAULT_RUNTIME_LIFECYCLE_STOP_TIMEOUT_MS);
  let timeout: ReturnType<typeof setTimeout> | null = null;

  try {
    const value = await Promise.race([
      Promise.resolve().then(operation),
      new Promise<"timeout">((resolve) => {
        timeout = setTimeout(() => resolve("timeout"), timeoutMs);
        timeout.unref?.();
      }),
    ]);

    if (value === "timeout") {
      options.logger?.warn?.("Runtime lifecycle operation timed out.", {
        type: "runtime.lifecycle.operation.timeout",
        operationName: name,
        timeoutMs,
      });
      return { name, status: "timeout" };
    }

    return { name, status: "stopped", value };
  } catch (error) {
    options.logger?.error?.("Runtime lifecycle operation failed.", {
      type: "runtime.lifecycle.operation.failed",
      operationName: name,
      error,
    });
    return { name, status: "failed", error };
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function stopHandle(handle: RuntimeLifecycleStopHandle, timeoutMs: number): Promise<RuntimeLifecycleStopResult> {
  const result = await runWithRuntimeLifecycleTimeout(handle.name, handle.stop, { timeoutMs });
  if (result.status === "stopped") {
    return { name: result.name, status: "stopped" };
  }
  if (result.status === "timeout") {
    return { name: result.name, status: "timeout" };
  }
  return { name: result.name, status: "failed", error: result.error };
}

function normalizeTimeoutMs(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.floor(value) : fallback;
}
