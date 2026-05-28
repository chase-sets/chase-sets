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
  loadEvents: (afterSequence: number) => Promise<readonly DurableJobStreamEvent<T>[]>;
  isTerminal: (event: DurableJobStreamEvent<T>) => boolean;
}>;

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_KEEPALIVE_INTERVAL_MS = 15_000;

export function createDurableJobEventStream<T>(options: DurableJobEventStreamOptions<T>): Response {
  const encoder = new TextEncoder();
  const pollIntervalMs = Math.max(100, Math.floor(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS));
  const keepaliveIntervalMs = Math.max(
    pollIntervalMs,
    Math.floor(options.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS),
  );
  let closed = false;

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

          await waitForDurableJobEventPoll(pollIntervalMs, options.signal);
        }
      } finally {
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
