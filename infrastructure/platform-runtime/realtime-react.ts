import { useEffect, useRef, useState } from "react";
import type { RealtimeProjectionPatch, RealtimeSyncRequired } from "@chase-sets/realtime";
import {
  subscribeRealtimePatches,
  type RealtimeReconnectPolicy,
  type RealtimeRouteSubscriptionPreset,
} from "./realtime-web";

export type RealtimePatchedSnapshotOptions<T> = Readonly<{
  initialSnapshot: T;
  snapshotKey?: string;
  topics?: readonly string[];
  preset?: RealtimeRouteSubscriptionPreset;
  applyPatch: (snapshot: T, patch: RealtimeProjectionPatch) => T;
  onSyncRequired: (message: RealtimeSyncRequired) => void;
  onError?: (error: Event) => void;
  debounceMs?: number;
  reconnectPolicy?: RealtimeReconnectPolicy;
}>;

export function useRealtimePatchedSnapshot<T>(
  options: RealtimePatchedSnapshotOptions<T>,
): T {
  const resolvedSnapshotKey = options.snapshotKey ?? "";
  const [snapshotState, setSnapshotState] = useState(() => ({
    key: resolvedSnapshotKey,
    value: options.initialSnapshot,
  }));
  const applyPatchRef = useRef(options.applyPatch);
  const onSyncRequiredRef = useRef(options.onSyncRequired);
  const onErrorRef = useRef(options.onError);
  const topics = options.preset?.topics ?? options.topics ?? [];
  const subscriptionKey = topics.join("\n");

  applyPatchRef.current = options.applyPatch;
  onSyncRequiredRef.current = options.onSyncRequired;
  onErrorRef.current = options.onError;

  let snapshot = snapshotState.value;

  if (snapshotState.key !== resolvedSnapshotKey) {
    snapshot = options.initialSnapshot;
    setSnapshotState({
      key: resolvedSnapshotKey,
      value: options.initialSnapshot,
    });
  }

  useEffect(() => {
    const subscription = subscribeRealtimePatches({
      topics,
      onPatch: (patch) => {
        setSnapshotState((current) => ({
          key: current.key,
          value: applyPatchRef.current(current.value, patch),
        }));
      },
      onSyncRequired: (message) => onSyncRequiredRef.current(message),
      onError: (error) => onErrorRef.current?.(error),
      debounceMs: options.debounceMs,
      reconnectPolicy: options.reconnectPolicy,
    });

    return () => subscription.close();
  }, [subscriptionKey, options.debounceMs, options.reconnectPolicy]);

  return snapshot;
}
