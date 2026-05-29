export type DurableJobBrowserStatus = Readonly<{
  status: "queued" | "running" | "completed" | "failed";
}>;

export type DurableJobStatusSubscription<TJob extends DurableJobBrowserStatus> = Readonly<{
  close: () => void;
  current: () => TJob | null;
}>;

type DurableJobSyncRequiredMessage<TJob extends DurableJobBrowserStatus> = Readonly<{
  kind: "sync.required";
  snapshot: TJob;
}>;

export function subscribeDurableJobStatus<TJob extends DurableJobBrowserStatus>(
  options: Readonly<{
    url: string;
    onStatus: (job: TJob) => void;
    onTerminal?: (job: TJob) => void;
    onError?: (error: Event) => void;
    reconnectDelayMs?: number;
  }>,
): DurableJobStatusSubscription<TJob> {
  if (typeof window === "undefined") {
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
      if (job.status === "completed" || job.status === "failed") {
        closeSource();
        options.onTerminal?.(job);
      }
    };
    source = new EventSource(sourceUrl());
    source.addEventListener("status", (event) => {
      lastEventId = (event as MessageEvent).lastEventId || lastEventId;
      applyJob(JSON.parse((event as MessageEvent).data) as TJob);
    });
    source.addEventListener("sync.required", (event) => {
      lastEventId = (event as MessageEvent).lastEventId || lastEventId;
      const message = JSON.parse((event as MessageEvent).data) as DurableJobSyncRequiredMessage<TJob>;
      applyJob(message.snapshot);
      if (!closed && message.snapshot.status !== "completed" && message.snapshot.status !== "failed") {
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
      if (currentJob?.status === "completed" || currentJob?.status === "failed") {
        closeSource();
        return;
      }
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
