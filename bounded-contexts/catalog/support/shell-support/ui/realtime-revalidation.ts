import { useEffect, useRef } from "react";
import { useRevalidator } from "react-router";
import {
  subscribeRealtimePatches,
  type RealtimeRouteSubscriptionPreset,
} from "@chase-sets/platform-runtime/realtime-web";

const DEFAULT_REVALIDATION_DEBOUNCE_MS = 150;

export function useCatalogRealtimeRevalidation(
  preset: RealtimeRouteSubscriptionPreset,
  debounceMs = DEFAULT_REVALIDATION_DEBOUNCE_MS,
) {
  const revalidator = useRevalidator();
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const subscriptionKey = preset.topics.join("\n");

  useEffect(() => {
    function scheduleRevalidation() {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }

      timeoutRef.current = setTimeout(() => {
        timeoutRef.current = null;
        revalidator.revalidate();
      }, debounceMs);
    }

    const topics = subscriptionKey.split("\n").filter(Boolean);
    const subscription = subscribeRealtimePatches({
      topics,
      onPatch: scheduleRevalidation,
      onSyncRequired: scheduleRevalidation,
      debounceMs,
    });

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      subscription.close();
    };
  }, [subscriptionKey, debounceMs, revalidator]);
}
