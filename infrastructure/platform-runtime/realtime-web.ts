import type {
  RealtimeProjectionPatch,
  RealtimeSyncRequired,
} from "./realtime";

export type RealtimeSubscription = Readonly<{
  close: () => void;
}>;

type RealtimeSubscriptionHandlers = Readonly<{
  onPatch: (patch: RealtimeProjectionPatch) => void;
  onSyncRequired: (message: RealtimeSyncRequired) => void;
  onError?: (error: Event) => void;
}>;

type SharedRealtimeSource = Readonly<{
  source: EventSource;
  handlers: Set<RealtimeSubscriptionHandlers>;
}>;

const sharedSources = new Map<string, SharedRealtimeSource>();

export function subscribeRealtimePatches(options: Readonly<{
  topics: readonly string[];
  onPatch: (patch: RealtimeProjectionPatch) => void;
  onSyncRequired: (message: RealtimeSyncRequired) => void;
  onError?: (error: Event) => void;
}>): RealtimeSubscription {
  if (typeof window === "undefined" || options.topics.length === 0) {
    return { close: () => undefined };
  }

  const normalizedTopics = [...new Set(options.topics)].sort();
  const sourceKey = normalizedTopics.join("\n");
  const handlers: RealtimeSubscriptionHandlers = {
    onPatch: options.onPatch,
    onSyncRequired: options.onSyncRequired,
    onError: options.onError,
  };
  const sharedSource = getOrCreateSharedRealtimeSource(sourceKey, normalizedTopics);

  sharedSource.handlers.add(handlers);

  let closed = false;
  return {
    close: () => {
      if (closed) {
        return;
      }

      closed = true;
      sharedSource.handlers.delete(handlers);
      if (sharedSource.handlers.size === 0) {
        sharedSource.source.close();
        sharedSources.delete(sourceKey);
      }
    },
  };
}

function getOrCreateSharedRealtimeSource(
  sourceKey: string,
  topics: readonly string[],
): SharedRealtimeSource {
  const existing = sharedSources.get(sourceKey);
  if (existing) {
    return existing;
  }

  const params = new URLSearchParams();
  for (const topic of topics) {
    params.append("topic", topic);
  }

  const handlers = new Set<RealtimeSubscriptionHandlers>();
  const source = new EventSource(`/api/realtime/events?${params.toString()}`, {
    withCredentials: true,
  });
  const sharedSource = { source, handlers };

  source.addEventListener("projection.patch", (event) => {
    const message = parseRealtimeMessage<RealtimeProjectionPatch>(event);
    if (message?.kind === "projection.patch") {
      for (const handler of handlers) {
        handler.onPatch(message);
      }
    }
  });

  source.addEventListener("sync.required", (event) => {
    const message = parseRealtimeMessage<RealtimeSyncRequired>(event);
    if (message?.kind === "sync.required") {
      for (const handler of handlers) {
        handler.onSyncRequired(message);
      }
    }
  });

  source.addEventListener("error", (event) => {
    for (const handler of handlers) {
      handler.onError?.(event);
    }
  });

  sharedSources.set(sourceKey, sharedSource);
  return sharedSource;
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
