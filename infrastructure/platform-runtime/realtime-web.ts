import type {
  RealtimeProjectionPatch,
  RealtimeSyncRequired,
} from "./realtime";

export type RealtimeSubscription = Readonly<{
  close: () => void;
}>;

export function subscribeRealtimePatches(options: Readonly<{
  topics: readonly string[];
  onPatch: (patch: RealtimeProjectionPatch) => void;
  onSyncRequired: (message: RealtimeSyncRequired) => void;
  onError?: (error: Event) => void;
}>): RealtimeSubscription {
  if (typeof window === "undefined" || options.topics.length === 0) {
    return { close: () => undefined };
  }

  const params = new URLSearchParams();
  for (const topic of [...new Set(options.topics)].sort()) {
    params.append("topic", topic);
  }

  const source = new EventSource(`/api/realtime/events?${params.toString()}`, {
    withCredentials: true,
  });

  source.addEventListener("projection.patch", (event) => {
    const message = parseRealtimeMessage<RealtimeProjectionPatch>(event);
    if (message?.kind === "projection.patch") {
      options.onPatch(message);
    }
  });

  source.addEventListener("sync.required", (event) => {
    const message = parseRealtimeMessage<RealtimeSyncRequired>(event);
    if (message?.kind === "sync.required") {
      options.onSyncRequired(message);
    }
  });

  if (options.onError) {
    source.addEventListener("error", options.onError);
  }

  return { close: () => source.close() };
}

function parseRealtimeMessage<T>(event: Event): T | null {
  if (!("data" in event) || typeof event.data !== "string") {
    return null;
  }

  try {
    return JSON.parse(event.data) as T;
  } catch {
    return null;
  }
}
