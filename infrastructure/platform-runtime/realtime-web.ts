import {
  isRealtimeProjectionPatch,
  isRealtimeSyncRequired,
  type RealtimeProjectionPatch,
  type RealtimeSyncRequired,
} from "@chase-sets/realtime";
import type { RealtimeRouteSubscriptionPreset } from "./realtime-route-subscriptions";

export type RealtimeSubscription = Readonly<{
  close: () => void;
}>;

export type { RealtimeRouteSubscriptionPreset } from "./realtime-route-subscriptions";
export { createRealtimeRouteSubscriptionPreset } from "./realtime-route-subscriptions";

type RealtimeSubscriptionHandlers = Readonly<{
  onPatch: (patch: RealtimeProjectionPatch) => void;
  onSyncRequired: (message: RealtimeSyncRequired) => void;
  onError?: (error: Event) => void;
  // Reports the transport's actual open/closed state — distinct from `onPatch`
  // activity, since a healthy SSE connection can sit quiet indefinitely with no
  // patches to deliver. Consumers that need to flip a "live"/"stale" affordance
  // (rather than "recently changed") should watch this instead of patch timing.
  onConnectionStateChange?: (connected: boolean) => void;
}>;

type SharedRealtimeSource = {
  source: EventSource | null;
  openTimer: ReturnType<typeof setTimeout> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  open: () => void;
  backoff: (reason: "error" | "sync.required") => void;
  reconnectPolicy: RealtimeReconnectPolicy;
  handlers: Set<RealtimeSubscriptionHandlers>;
  diagnostics: RealtimeSubscriptionDiagnosticEntry;
  connected: boolean;
};

const sharedSources = new Map<string, SharedRealtimeSource>();
const DEFAULT_SUBSCRIPTION_DEBOUNCE_MS = 75;
const DEFAULT_RECONNECT_POLICY = {
  backoffMs: 1_000,
  maxErrorCountBeforeBackoff: 3,
  maxSyncRequiredBeforeBackoff: 3,
} satisfies Required<RealtimeReconnectPolicy>;

export type RealtimeReconnectPolicy = Readonly<{
  backoffMs?: number;
  maxErrorCountBeforeBackoff?: number;
  maxSyncRequiredBeforeBackoff?: number;
}>;

export type RealtimeSubscriptionDiagnosticEntry = {
  topics: readonly string[];
  subscriberCount: number;
  reconnectCount: number;
  errorCount: number;
  syncRequiredCount: number;
  lastEventId: string | null;
  lastPatchAt: string | null;
  lastSyncReason: RealtimeSyncRequired["reason"] | null;
};

export type RealtimeSubscriptionDiagnostics = Readonly<{
  activeSourceCount: number;
  sources: readonly Readonly<RealtimeSubscriptionDiagnosticEntry>[];
}>;

export function subscribeRealtimePatches(
  options: Readonly<{
    topics?: readonly string[];
    preset?: RealtimeRouteSubscriptionPreset;
    onPatch: (patch: RealtimeProjectionPatch) => void;
    onSyncRequired: (message: RealtimeSyncRequired) => void;
    onError?: (error: Event) => void;
    onConnectionStateChange?: (connected: boolean) => void;
    debounceMs?: number;
    reconnectPolicy?: RealtimeReconnectPolicy;
  }>,
): RealtimeSubscription {
  const requestedTopics = options.preset?.topics ?? options.topics ?? [];
  if (typeof window === "undefined" || requestedTopics.length === 0) {
    return { close: () => undefined };
  }

  const normalizedTopics = [...new Set(requestedTopics)].sort();
  const sourceKey = normalizedTopics.join("\n");
  const handlers: RealtimeSubscriptionHandlers = {
    onPatch: options.onPatch,
    onSyncRequired: options.onSyncRequired,
    onError: options.onError,
    onConnectionStateChange: options.onConnectionStateChange,
  };
  const sharedSource = getOrCreateSharedRealtimeSource(
    sourceKey,
    normalizedTopics,
    resolveRealtimeReconnectPolicy(options.reconnectPolicy),
  );

  sharedSource.handlers.add(handlers);
  sharedSource.diagnostics.subscriberCount = sharedSource.handlers.size;
  // A handler that joins an already-connected shared source has missed the
  // `open` event that produced that state — hand it the current value directly
  // so a late subscriber's live/stale derivation starts correct instead of
  // defaulting to "connecting" forever.
  handlers.onConnectionStateChange?.(sharedSource.connected);
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
        if (sharedSource.reconnectTimer) {
          clearTimeout(sharedSource.reconnectTimer);
        }
        sharedSource.source?.close();
        sharedSources.delete(sourceKey);
      }
    },
  };
}

function setSharedRealtimeSourceConnected(sharedSource: SharedRealtimeSource, connected: boolean) {
  if (sharedSource.connected === connected) {
    return;
  }

  sharedSource.connected = connected;
  for (const handler of sharedSource.handlers) {
    handler.onConnectionStateChange?.(connected);
  }
}

function getOrCreateSharedRealtimeSource(
  sourceKey: string,
  topics: readonly string[],
  reconnectPolicy: Required<RealtimeReconnectPolicy>,
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
    syncRequiredCount: 0,
    lastEventId: null,
    lastPatchAt: null,
    lastSyncReason: null,
  };
  const openSource = () => {
    if (!sharedSources.has(sourceKey) || sharedSource.handlers.size === 0) {
      return;
    }
    if (sharedSource.source) {
      return;
    }

    const endpoint = resolveRealtimeEndpointPath(topics);
    if (diagnostics.lastEventId) {
      params.set("cursor", diagnostics.lastEventId);
    } else {
      params.delete("cursor");
    }
    const source = new EventSource(`${endpoint}?${params.toString()}`, {
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
        diagnostics.syncRequiredCount += 1;
        for (const handler of handlers) {
          handler.onSyncRequired(message);
        }
        if (diagnostics.syncRequiredCount >= reconnectPolicy.maxSyncRequiredBeforeBackoff) {
          sharedSource.backoff("sync.required");
        }
      }
    });

    source.addEventListener("error", (event) => {
      diagnostics.errorCount += 1;
      setSharedRealtimeSourceConnected(sharedSource, false);
      for (const handler of handlers) {
        handler.onError?.(event);
      }
      if (diagnostics.errorCount >= reconnectPolicy.maxErrorCountBeforeBackoff) {
        sharedSource.backoff("error");
      }
    });
    source.addEventListener("open", () => {
      diagnostics.reconnectCount += 1;
      diagnostics.errorCount = 0;
      diagnostics.syncRequiredCount = 0;
      setSharedRealtimeSourceConnected(sharedSource, true);
    });
  };
  const backoff = (_reason: "error" | "sync.required") => {
    setSharedRealtimeSourceConnected(sharedSource, false);
    if (sharedSource.reconnectTimer || sharedSource.handlers.size === 0) {
      return;
    }

    sharedSource.source?.close();
    sharedSource.source = null;
    sharedSource.reconnectTimer = setTimeout(() => {
      sharedSource.reconnectTimer = null;
      sharedSource.open();
    }, reconnectPolicy.backoffMs);
  };

  const sharedSource: SharedRealtimeSource = {
    source: null,
    openTimer: null,
    reconnectTimer: null,
    open: openSource,
    backoff,
    reconnectPolicy,
    handlers,
    diagnostics,
    connected: false,
  };

  sharedSources.set(sourceKey, sharedSource);
  return sharedSource;
}

function resolveRealtimeEndpointPath(topics: readonly string[]): string {
  return topics.every((topic) => topic.startsWith("account:"))
    ? "/api/realtime/account/events"
    : "/api/realtime/public/events";
}

function resolveRealtimeReconnectPolicy(
  policy: RealtimeReconnectPolicy | undefined,
): Required<RealtimeReconnectPolicy> {
  return {
    backoffMs: policy?.backoffMs ?? DEFAULT_RECONNECT_POLICY.backoffMs,
    maxErrorCountBeforeBackoff:
      policy?.maxErrorCountBeforeBackoff ?? DEFAULT_RECONNECT_POLICY.maxErrorCountBeforeBackoff,
    maxSyncRequiredBeforeBackoff:
      policy?.maxSyncRequiredBeforeBackoff ?? DEFAULT_RECONNECT_POLICY.maxSyncRequiredBeforeBackoff,
  };
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
  return "lastEventId" in event && typeof event.lastEventId === "string" ? event.lastEventId : null;
}
