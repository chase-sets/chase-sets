export type DurableJobStreamEvent<T> = Readonly<{
  sequence: number;
  eventName: string;
  data: T;
}>;

export type DurableJobEventStreamOptions<T> = Readonly<{
  request?: Request;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  keepaliveIntervalMs?: number;
  streamLimiter?: DurableJobStreamLimiter;
  streamLimitKey?: string;
  loadEvents: (afterSequence: number) => Promise<readonly DurableJobStreamEvent<T>[]>;
  waitForEvents?: (afterSequence: number, signal?: AbortSignal) => Promise<void>;
  isTerminal: (event: DurableJobStreamEvent<T>) => boolean;
}>;

export type DurableJobStreamLease = Readonly<{
  release: () => void | Promise<void>;
}>;

export type DurableJobStreamLimiter = Readonly<{
  acquire: (input: Readonly<{ connectionKey: string }>) => DurableJobStreamLease | null;
}>;

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_KEEPALIVE_INTERVAL_MS = 15_000;
const DEFAULT_MAX_ACTIVE_STREAMS = 500;
const defaultStreamLimiter = createInMemoryDurableJobStreamLimiter({ maxActiveStreams: DEFAULT_MAX_ACTIVE_STREAMS });

export function createDurableJobEventStream<T>(options: DurableJobEventStreamOptions<T>): Response {
  const encoder = new TextEncoder();
  const pollIntervalMs = Math.max(100, Math.floor(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS));
  const keepaliveIntervalMs = Math.max(
    pollIntervalMs,
    Math.floor(options.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS),
  );
  let closed = false;
  const streamLimiter = options.streamLimiter ?? defaultStreamLimiter;
  const streamLimitKey = options.streamLimitKey ?? durableJobStreamLimitKey(options.request);
  const lease = streamLimiter.acquire({ connectionKey: streamLimitKey });
  if (!lease) {
    return Response.json(
      { error: { code: "too_many_durable_job_streams", message: "Too many durable job status streams." } },
      { status: 429 },
    );
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let afterSequence = readDurableJobEventCursor(options.request);
      let lastWriteAt = Date.now();

      const write = (chunk: string) => {
        controller.enqueue(encoder.encode(chunk));
        lastWriteAt = Date.now();
      };

      try {
        for (;;) {
          if (closed || options.signal?.aborted) {
            break;
          }

          const events = await options.loadEvents(afterSequence);
          for (const event of events) {
            if (event.sequence <= afterSequence) {
              continue;
            }

            write(formatDurableJobSseEvent(event));
            afterSequence = event.sequence;

            if (options.isTerminal(event)) {
              return;
            }
          }

          if (Date.now() - lastWriteAt >= keepaliveIntervalMs) {
            write(": keepalive\n\n");
          }

          await (options.waitForEvents?.(afterSequence, options.signal) ??
            waitForDurableJobEventPoll(pollIntervalMs, options.signal));
        }
      } finally {
        await lease.release();
        controller.close();
      }
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    },
  });
}

export function createInMemoryDurableJobStreamLimiter(
  options: Readonly<{ maxActiveStreams?: number; maxActiveStreamsPerConnectionKey?: number }> = {},
): DurableJobStreamLimiter & Readonly<{ activeConnectionCount: () => number }> {
  const maxActiveStreams = Math.max(1, Math.floor(options.maxActiveStreams ?? DEFAULT_MAX_ACTIVE_STREAMS));
  const maxActiveStreamsPerConnectionKey = Math.max(
    1,
    Math.floor(options.maxActiveStreamsPerConnectionKey ?? Math.min(20, maxActiveStreams)),
  );
  let active = 0;
  const perKey = new Map<string, number>();

  return {
    activeConnectionCount: () => active,
    acquire: (input) => {
      const keyCount = perKey.get(input.connectionKey) ?? 0;
      if (active >= maxActiveStreams || keyCount >= maxActiveStreamsPerConnectionKey) {
        return null;
      }

      active += 1;
      perKey.set(input.connectionKey, keyCount + 1);
      let released = false;
      return {
        release: () => {
          if (released) {
            return;
          }
          released = true;
          active = Math.max(0, active - 1);
          const nextKeyCount = Math.max(0, (perKey.get(input.connectionKey) ?? 1) - 1);
          if (nextKeyCount === 0) {
            perKey.delete(input.connectionKey);
          } else {
            perKey.set(input.connectionKey, nextKeyCount);
          }
        },
      };
    },
  };
}

export function readDurableJobEventCursor(request?: Request): number {
  const headerCursor = request?.headers.get("last-event-id");
  if (headerCursor) {
    return parseDurableJobEventCursor(headerCursor);
  }

  const url = request ? new URL(request.url) : null;
  return parseDurableJobEventCursor(url?.searchParams.get("cursor"));
}

export function parseDurableJobEventCursor(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }

  const direct = Number(value);
  if (Number.isSafeInteger(direct) && direct > 0) {
    return direct;
  }

  const suffix = value.match(/(\d+)$/);
  if (!suffix) {
    return 0;
  }

  const parsed = Number(suffix[1]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

export function formatDurableJobSseEvent<T>(event: DurableJobStreamEvent<T>): string {
  return `id: ${event.sequence}\nevent: ${event.eventName}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

function durableJobStreamLimitKey(request?: Request): string {
  if (!request) {
    return "unknown";
  }

  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip") || "unknown";
}

function waitForDurableJobEventPoll(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
