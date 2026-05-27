export type ProcessDrainState = Readonly<{
  isDraining: () => boolean;
  signal: AbortSignal;
  activeRequestCount: () => number;
  activeStreamCount: () => number;
  beginDrain: () => boolean;
  waitForIdle: (timeoutMs: number) => Promise<"idle" | "timeout">;
}>;

export type ProcessLifecycleLogger = Readonly<{
  info?: (message: string, fields?: Record<string, unknown>) => void;
  warn?: (message: string, fields?: Record<string, unknown>) => void;
  error?: (message: string, fields?: Record<string, unknown>) => void;
}>;

export type GracefulHttpServerHandle = Readonly<{
  close: (callback?: (error?: Error) => void) => void;
  closeIdleConnections?: () => void;
  closeAllConnections?: () => void;
}>;

export type GracefulFetch<Rest extends readonly unknown[] = readonly unknown[]> = (
  request: Request,
  ...rest: Rest
) => Response | Promise<Response>;

export type GracefulHttpServe<Rest extends readonly unknown[] = readonly unknown[]> = (
  options: Readonly<{
    fetch: GracefulFetch<Rest>;
    port: number;
  }>,
  onListening?: (info: Readonly<{ port: number }>) => void,
) => GracefulHttpServerHandle;

export type GracefulHttpServer = Readonly<{
  drainState: ProcessDrainState;
  shutdown: (reason: string) => Promise<void>;
}>;

export type GracefulHttpServerOptions<Rest extends readonly unknown[] = readonly unknown[]> = Readonly<{
  name: string;
  port: number;
  serve: GracefulHttpServe<Rest>;
  fetch: GracefulFetch<Rest>;
  onListening?: (info: Readonly<{ port: number }>) => void;
  onDrainStart?: readonly (() => void | Promise<void>)[];
  onShutdown?: readonly (() => void | Promise<void>)[];
  logger?: ProcessLifecycleLogger;
  shutdownGraceMs?: number;
  streamDrainGraceMs?: number;
  drainState?: ProcessDrainState;
  signals?: readonly NodeJS.Signals[];
  exit?: (code: number) => never | void;
}>;

const defaultShutdownGraceMs = 30_000;
const defaultStreamDrainGraceMs = 5_000;

export function createProcessDrainState(): ProcessDrainState {
  return createMutableProcessDrainState();
}

export function createGracefulFetch<Rest extends readonly unknown[]>(
  fetch: GracefulFetch<Rest>,
  drainState: ProcessDrainState,
): GracefulFetch<Rest> {
  const mutableState = drainState as ProcessDrainState & {
    trackRequestStarted?: () => void;
    trackRequestFinished?: () => void;
    trackStreamStarted?: () => void;
    trackStreamFinished?: () => void;
  };

  return async (request, ...rest) => {
    mutableState.trackRequestStarted?.();
    try {
      const response = await fetch(request, ...rest);

      return trackResponseStream(response, drainState, mutableState);
    } finally {
      mutableState.trackRequestFinished?.();
    }
  };
}

export function startGracefulHttpServer<Rest extends readonly unknown[]>(
  options: GracefulHttpServerOptions<Rest>,
): GracefulHttpServer {
  const drainState = options.drainState ?? createMutableProcessDrainState();
  const shutdownGraceMs = resolvePositiveMs(options.shutdownGraceMs, "SHUTDOWN_GRACE_MS", defaultShutdownGraceMs);
  const streamDrainGraceMs = resolvePositiveMs(
    options.streamDrainGraceMs,
    "STREAM_DRAIN_GRACE_MS",
    Math.min(defaultStreamDrainGraceMs, shutdownGraceMs),
  );
  const server = options.serve(
    {
      fetch: createGracefulFetch(options.fetch, drainState),
      port: options.port,
    },
    options.onListening,
  );
  let shutdownPromise: Promise<void> | undefined;

  const shutdown = async (reason: string) => {
    shutdownPromise ??= shutdownGracefully({
      name: options.name,
      reason,
      server,
      drainState,
      logger: options.logger,
      shutdownGraceMs,
      streamDrainGraceMs,
      onDrainStart: options.onDrainStart,
      onShutdown: options.onShutdown,
    });

    return shutdownPromise;
  };

  for (const signal of options.signals ?? ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      void shutdown(signal)
        .catch((error) => {
          options.logger?.error?.("Process graceful shutdown failed.", {
            type: "process.shutdown.failed",
            processName: options.name,
            signal,
            error,
          });
        })
        .finally(() => {
          (options.exit ?? process.exit)(0);
        });
    });
  }

  return {
    drainState,
    shutdown,
  };
}

export async function shutdownGracefully(
  input: Readonly<{
    name: string;
    reason: string;
    server: GracefulHttpServerHandle;
    drainState: ProcessDrainState;
    logger?: ProcessLifecycleLogger;
    shutdownGraceMs: number;
    streamDrainGraceMs: number;
    onDrainStart?: readonly (() => void | Promise<void>)[];
    onShutdown?: readonly (() => void | Promise<void>)[];
  }>,
): Promise<void> {
  const drainStarted = input.drainState.beginDrain();
  const startedAt = Date.now();

  if (drainStarted) {
    input.logger?.info?.("Process graceful shutdown started.", {
      type: "process.draining_started",
      processName: input.name,
      reason: input.reason,
      activeRequestCount: input.drainState.activeRequestCount(),
      activeStreamCount: input.drainState.activeStreamCount(),
      shutdownGraceMs: input.shutdownGraceMs,
      streamDrainGraceMs: input.streamDrainGraceMs,
    });
  }

  await runLifecycleCallbacks(input.onDrainStart, input.logger, input.name, "drain-start");
  input.server.closeIdleConnections?.();

  const closePromise = closeServer(input.server);
  const abortStreamsAfterGrace = setTimeout(
    () => {
      if (!input.drainState.signal.aborted) {
        (input.drainState as { abortStreams?: () => void }).abortStreams?.();
      }
    },
    Math.min(input.streamDrainGraceMs, input.shutdownGraceMs),
  );
  abortStreamsAfterGrace.unref?.();

  const drainResult = await Promise.race([
    Promise.all([closePromise, input.drainState.waitForIdle(input.shutdownGraceMs)]).then(() => "idle" as const),
    sleep(input.shutdownGraceMs).then(() => "timeout" as const),
  ]);
  clearTimeout(abortStreamsAfterGrace);

  if (drainResult === "timeout") {
    input.logger?.warn?.("Process graceful shutdown timed out.", {
      type: "process.shutdown.timeout",
      processName: input.name,
      activeRequestCount: input.drainState.activeRequestCount(),
      activeStreamCount: input.drainState.activeStreamCount(),
    });
    input.server.closeAllConnections?.();
  }

  await runLifecycleCallbacks(input.onShutdown, input.logger, input.name, "shutdown");
  input.logger?.info?.("Process graceful shutdown completed.", {
    type: "process.shutdown.completed",
    processName: input.name,
    durationMs: Date.now() - startedAt,
    activeRequestCount: input.drainState.activeRequestCount(),
    activeStreamCount: input.drainState.activeStreamCount(),
  });
}

function createMutableProcessDrainState(): ProcessDrainState {
  let draining = false;
  let activeRequests = 0;
  let activeStreams = 0;
  const drainController = new AbortController();
  const idleWaiters = new Set<() => void>();

  const notifyIfIdle = () => {
    if (activeRequests + activeStreams > 0) {
      return;
    }

    for (const waiter of idleWaiters) {
      waiter();
    }
    idleWaiters.clear();
  };

  return {
    isDraining: () => draining,
    signal: drainController.signal,
    activeRequestCount: () => activeRequests,
    activeStreamCount: () => activeStreams,
    beginDrain: () => {
      if (draining) {
        return false;
      }

      draining = true;
      notifyIfIdle();
      return true;
    },
    waitForIdle: async (timeoutMs) => {
      if (activeRequests + activeStreams === 0) {
        return "idle";
      }

      return new Promise((resolve) => {
        const timeout = setTimeout(
          () => {
            idleWaiters.delete(resolveIdle);
            resolve("timeout");
          },
          Math.max(0, timeoutMs),
        );
        timeout.unref?.();
        const resolveIdle = () => {
          clearTimeout(timeout);
          resolve("idle");
        };
        idleWaiters.add(resolveIdle);
      });
    },
    trackRequestStarted: () => {
      activeRequests += 1;
    },
    trackRequestFinished: () => {
      activeRequests = Math.max(0, activeRequests - 1);
      notifyIfIdle();
    },
    trackStreamStarted: () => {
      activeStreams += 1;
    },
    trackStreamFinished: () => {
      activeStreams = Math.max(0, activeStreams - 1);
      notifyIfIdle();
    },
    abortStreams: () => {
      drainController.abort("process-draining");
    },
  } as ProcessDrainState;
}

function trackResponseStream(
  response: Response,
  drainState: ProcessDrainState,
  mutableState: ProcessDrainState & {
    trackStreamStarted?: () => void;
    trackStreamFinished?: () => void;
  },
): Response {
  if (!response.body) {
    return response;
  }

  mutableState.trackStreamStarted?.();
  const reader = response.body.getReader();
  let finished = false;
  const cancelOnDrain = () => {
    void reader.cancel("process-draining").finally(finish);
  };
  const finish = () => {
    if (finished) {
      return;
    }

    finished = true;
    drainState.signal.removeEventListener("abort", cancelOnDrain);
    mutableState.trackStreamFinished?.();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          finish();
          return;
        }

        controller.enqueue(result.value);
      } catch (error) {
        controller.error(error);
        finish();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        finish();
      }
    },
  });
  drainState.signal.addEventListener("abort", cancelOnDrain, { once: true });

  return new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}

async function closeServer(server: GracefulHttpServerHandle): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function runLifecycleCallbacks(
  callbacks: readonly (() => void | Promise<void>)[] | undefined,
  logger: ProcessLifecycleLogger | undefined,
  processName: string,
  phase: string,
) {
  for (const callback of callbacks ?? []) {
    try {
      await callback();
    } catch (error) {
      logger?.error?.("Process lifecycle callback failed.", {
        type: "process.lifecycle_callback.failed",
        processName,
        phase,
        error,
      });
    }
  }
}

function resolvePositiveMs(value: number | undefined, envName: string, fallback: number): number {
  const raw = value ?? Number(process.env[envName] ?? fallback);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, Math.max(0, ms));
    timeout.unref?.();
  });
}
