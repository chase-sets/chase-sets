import { useCallback, useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import {
  subscribeRealtimePatches,
  type RealtimeRouteSubscriptionPreset,
} from "@chase-sets/platform-runtime/realtime-web";
import type { RealtimeProjectionPatch } from "@chase-sets/platform-runtime/realtime";
import {
  useLiveConnectionStatus,
  type LiveConnectionStatus,
} from "@chase-sets/platform-runtime/live-connection-status";

const DEFAULT_REVALIDATION_DEBOUNCE_MS = 150;

type CatalogRealtimeRevalidationMode = "auto" | "manual";

type CatalogRealtimeRevalidationOptions = Readonly<{
  debounceMs?: number;
  mode?: CatalogRealtimeRevalidationMode;
  connectionStaleAfterMs?: number;
}>;

export type CatalogRealtimeRevalidationState = Readonly<{
  pendingChangeCount: number;
  syncRequired: boolean;
  hasPendingChanges: boolean;
  reload: () => void;
  reset: () => void;
  // Health of the shared SSE connection the route's realtime topics ride on —
  // distinct from `pendingChangeCount`, which only reflects patches actually
  // received. A killed connection with nothing to patch still flips this to
  // "stale" so the surface never reads as fresh when it silently isn't.
  connectionStatus: LiveConnectionStatus;
  connectionStaleSince: Date | null;
}>;

export function useCatalogRealtimeRevalidation(
  preset: RealtimeRouteSubscriptionPreset,
  options: number | CatalogRealtimeRevalidationOptions = {},
): CatalogRealtimeRevalidationState {
  const resolvedOptions = typeof options === "number" ? { debounceMs: options } : options;
  const debounceMs = resolvedOptions.debounceMs ?? DEFAULT_REVALIDATION_DEBOUNCE_MS;
  const mode = resolvedOptions.mode ?? "auto";
  const revalidator = useRevalidator();
  const revalidateRef = useRef(revalidator.revalidate);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingIdsRef = useRef<Set<string>>(new Set());
  const [pendingChangeCount, setPendingChangeCount] = useState(0);
  const [syncRequired, setSyncRequired] = useState(false);
  const [connected, setConnected] = useState(false);
  const subscriptionKey = preset.topics.join("\n");
  const liveConnection = useLiveConnectionStatus(connected, {
    staleAfterMs: resolvedOptions.connectionStaleAfterMs,
  });

  revalidateRef.current = revalidator.revalidate;

  const reset = useCallback(() => {
    pendingIdsRef.current = new Set();
    setPendingChangeCount(0);
    setSyncRequired(false);
  }, []);

  const reload = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    reset();
    revalidateRef.current();
  }, [reset]);

  useEffect(() => {
    function scheduleRevalidation() {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }

      timeoutRef.current = setTimeout(() => {
        timeoutRef.current = null;
        revalidateRef.current();
      }, debounceMs);
    }

    function recordPatch(patch: RealtimeProjectionPatch) {
      const nextIds = new Set(pendingIdsRef.current);

      for (const change of patch.changes) {
        nextIds.add(change.id);
      }

      pendingIdsRef.current = nextIds;
      setPendingChangeCount(nextIds.size);
    }

    const topics = subscriptionKey.split("\n").filter(Boolean);
    const subscription = subscribeRealtimePatches({
      topics,
      onPatch: mode === "manual" ? recordPatch : scheduleRevalidation,
      onSyncRequired:
        mode === "manual"
          ? () => {
              setSyncRequired(true);
            }
          : scheduleRevalidation,
      onConnectionStateChange: setConnected,
      debounceMs,
    });

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      subscription.close();
    };
  }, [subscriptionKey, debounceMs, mode]);

  return {
    pendingChangeCount,
    syncRequired,
    hasPendingChanges: pendingChangeCount > 0 || syncRequired,
    reload,
    reset,
    connectionStatus: liveConnection.status,
    connectionStaleSince: liveConnection.staleSince,
  };
}
