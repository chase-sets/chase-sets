import {
  isRealtimeProjectionPatch,
  isRealtimeSyncRequired,
  type RealtimeProjectionPatch,
  type RealtimeSyncRequired,
} from "@chase-sets/realtime";

export type RealtimeSubscription = Readonly<{
  close: () => void;
}>;

type RealtimeSubscriptionHandlers = Readonly<{
  onPatch: (patch: RealtimeProjectionPatch) => void;
  onSyncRequired: (message: RealtimeSyncRequired) => void;
  onError?: (error: Event) => void;
}>;

type SharedRealtimeSource = {
  source: EventSource | null;
  openTimer: ReturnType<typeof setTimeout> | null;
  open: () => void;
  handlers: Set<RealtimeSubscriptionHandlers>;
  diagnostics: RealtimeSubscriptionDiagnosticEntry;
};

const sharedSources = new Map<string, SharedRealtimeSource>();
const DEFAULT_SUBSCRIPTION_DEBOUNCE_MS = 75;

export type RealtimeSubscriptionDiagnosticEntry = {
  topics: readonly string[];
  subscriberCount: number;
  reconnectCount: number;
  errorCount: number;
  lastEventId: string | null;
  lastPatchAt: string | null;
  lastSyncReason: RealtimeSyncRequired["reason"] | null;
};

export type RealtimeSubscriptionDiagnostics = Readonly<{
  activeSourceCount: number;
  sources: readonly Readonly<RealtimeSubscriptionDiagnosticEntry>[];
}>;

export function subscribeRealtimePatches(options: Readonly<{
  topics: readonly string[];
  onPatch: (patch: RealtimeProjectionPatch) => void;
  onSyncRequired: (message: RealtimeSyncRequired) => void;
  onError?: (error: Event) => void;
  debounceMs?: number;
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
  const sharedSource = getOrCreateSharedRealtimeSource(
    sourceKey,
    normalizedTopics,
  );

  sharedSource.handlers.add(handlers);
  sharedSource.diagnostics.subscriberCount = sharedSource.handlers.size;
  if (!sharedSource.source && !sharedSource.openTimer) {
    const debounceMs = options.debounceMs ?? DEFAULT_SUBSCRIPTION_DEBOUNCE_MS;
    if (debounceMs <= 0) {
      sharedSource.open();
    } else {
      sharedSource.openTimer = setTimeout(sharedSource.open, debounceMs);
    }
  }

  let closed = false;
  return {
    close: () => {
      if (closed) {
        return;
      }

      closed = true;
      sharedSource.handlers.delete(handlers);
      sharedSource.diagnostics.subscriberCount = sharedSource.handlers.size;
      if (sharedSource.handlers.size === 0) {
        if (sharedSource.openTimer) {
          clearTimeout(sharedSource.openTimer);
        }
        sharedSource.source?.close();
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
  const diagnostics: RealtimeSubscriptionDiagnosticEntry = {
    topics,
    subscriberCount: 0,
    reconnectCount: 0,
    errorCount: 0,
    lastEventId: null,
    lastPatchAt: null,
    lastSyncReason: null,
  };
  const openSource = () => {
    if (!sharedSources.has(sourceKey) || sharedSource.handlers.size === 0) {
      return;
    }

    const source = new EventSource(`/api/realtime/events?${params.toString()}`, {
      withCredentials: true,
    });
    sharedSource.source = source;
    sharedSource.openTimer = null;

    source.addEventListener("projection.patch", (event) => {
      const message = parseRealtimeMessage(event);
      if (isRealtimeProjectionPatch(message)) {
        diagnostics.lastEventId = readLastEventId(event);
        diagnostics.lastPatchAt = new Date().toISOString();
        for (const handler of handlers) {
          handler.onPatch(message);
        }
      }
    });

    source.addEventListener("sync.required", (event) => {
      const message = parseRealtimeMessage(event);
      if (isRealtimeSyncRequired(message)) {
        diagnostics.lastEventId = readLastEventId(event);
        diagnostics.lastSyncReason = message.reason;
        for (const handler of handlers) {
          handler.onSyncRequired(message);
        }
      }
    });

    source.addEventListener("error", (event) => {
      diagnostics.errorCount += 1;
      for (const handler of handlers) {
        handler.onError?.(event);
      }
    });
    source.addEventListener("open", () => {
      diagnostics.reconnectCount += 1;
    });
  };

  const sharedSource: SharedRealtimeSource = {
    source: null,
    openTimer: null,
    open: openSource,
    handlers,
    diagnostics,
  };

  sharedSources.set(sourceKey, sharedSource);
  return sharedSource;
}

export function getRealtimeSubscriptionDiagnostics(): RealtimeSubscriptionDiagnostics {
  return {
    activeSourceCount: sharedSources.size,
    sources: [...sharedSources.values()].map((source) => ({
      ...source.diagnostics,
      topics: [...source.diagnostics.topics],
    })),
  };
}

function parseRealtimeMessage(event: Event): unknown {
  if (!("data" in event) || typeof event.data !== "string") {
    return null;
  }

  try {
    return JSON.parse(event.data) as unknown;
  } catch {
    return null;
  }
}

function readLastEventId(event: Event): string | null {
  return "lastEventId" in event && typeof event.lastEventId === "string"
    ? event.lastEventId
    : null;
}
