export type DurableJobBrowserStatus = Readonly<{
  status?: "queued" | "running" | "completed" | "failed";
}>;

export type DurableJobStatusSubscription<TJob extends object> = Readonly<{
  close: () => void;
  current: () => TJob | null;
}>;

type DurableJobSyncRequiredMessage<TJob extends DurableJobBrowserStatus> = Readonly<{
  kind: "sync.required";
  snapshot: TJob;
}>;

export function subscribeDurableJobStatus<TJob extends object>(
  options: Readonly<{
    url: string;
    onStatus: (job: TJob) => void;
    onTerminal?: (job: TJob) => void;
    onError?: (error: Event) => void;
    // Reports the EventSource's actual open/closed state — distinct from
    // `onStatus` activity, since a healthy connection can sit open indefinitely
    // between snapshots. Does NOT fire `false` on a terminal job's intentional
    // close (that is a clean finish, not a dropped connection).
    onConnectionStateChange?: (connected: boolean) => void;
    isTerminal?: (job: TJob) => boolean;
    reconnectDelayMs?: number;
  }>,
): DurableJobStatusSubscription<TJob> {
  if (typeof window === "undefined" || typeof EventSource === "undefined") {
    return {
      close: () => undefined,
      current: () => null,
    };
  }

  const reconnectDelayMs = Math.max(250, Math.floor(options.reconnectDelayMs ?? 1_000));
  let source: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let currentJob: TJob | null = null;
  let lastEventId: string | null = null;

  const closeSource = () => {
    source?.close();
    source = null;
  };
  const sourceUrl = () => {
    if (!lastEventId) {
      return options.url;
    }

    const base = new URL(options.url, window.location.href);
    base.searchParams.set("cursor", lastEventId);
    return base.href;
  };
  const open = () => {
    if (closed || source) {
      return;
    }

    const applyJob = (job: TJob) => {
      currentJob = job;
      options.onStatus(job);
      if (isTerminalJob(job, options.isTerminal)) {
        closeSource();
        options.onTerminal?.(job);
      }
    };
    source = new EventSource(sourceUrl());
    source.addEventListener("open", () => {
      options.onConnectionStateChange?.(true);
    });
    source.addEventListener("status", (event) => {
      lastEventId = (event as MessageEvent).lastEventId || lastEventId;
      applyJob(JSON.parse((event as MessageEvent).data) as TJob);
    });
    source.addEventListener("sync.required", (event) => {
      lastEventId = (event as MessageEvent).lastEventId || lastEventId;
      const message = JSON.parse((event as MessageEvent).data) as DurableJobSyncRequiredMessage<TJob>;
      applyJob(message.snapshot);
      if (!closed && !isTerminalJob(message.snapshot, options.isTerminal)) {
        options.onConnectionStateChange?.(false);
        closeSource();
        if (!reconnectTimer) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            open();
          }, reconnectDelayMs);
        }
      }
    });
    source.addEventListener("error", (event) => {
      options.onError?.(event);
      if (currentJob && isTerminalJob(currentJob, options.isTerminal)) {
        closeSource();
        return;
      }
      options.onConnectionStateChange?.(false);
      closeSource();
      if (!closed && !reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          open();
        }, reconnectDelayMs);
      }
    });
  };

  open();

  return {
    close: () => {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      closeSource();
    },
    current: () => currentJob,
  };
}

function isTerminalJob<TJob extends object>(job: TJob, isTerminal?: (job: TJob) => boolean) {
  if (isTerminal) {
    return isTerminal(job);
  }

  const status = "status" in job ? (job as DurableJobBrowserStatus).status : undefined;
  return status === "completed" || status === "failed";
}
