import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useNavigation } from "react-router";
import { readFreshWriteTokenState } from "@chase-sets/http/responses";

const DEFAULT_REVALIDATE_INTERVAL_MS = 2_000;
const DEFAULT_MAX_REVALIDATIONS = 15;

export type PendingFreshWriteTiming = Readonly<{ observedAtMs: number; expiresAtMs: number }>;

export function usePendingFreshWriteRevalidation(
  enabled: boolean,
  options: Readonly<{
    intervalMs?: number;
    maxRevalidations?: number;
    freshWrite?: PendingFreshWriteTiming | null;
  }> = {},
) {
  const location = useLocation();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const currentPath = `${location.pathname}${location.search}${location.hash}`;
  const navigateRef = useRef(navigate);
  const navigationStateRef = useRef(navigation.state);
  const attemptCountRef = useRef(0);
  const finalAttemptDoneRef = useRef(false);
  const recoveryKeyRef = useRef<string | null>(null);
  const [isAutoRevalidating, setIsAutoRevalidating] = useState(false);
  const intervalMs = options.intervalMs ?? DEFAULT_REVALIDATE_INTERVAL_MS;
  const maxRevalidations = options.maxRevalidations ?? DEFAULT_MAX_REVALIDATIONS;
  const hasServerTiming = options.freshWrite !== undefined;
  const observedAtMs = options.freshWrite?.observedAtMs;
  const expiresAtMs = options.freshWrite?.expiresAtMs;

  useEffect(() => {
    navigateRef.current = navigate;
    navigationStateRef.current = navigation.state;
  });

  useEffect(() => {
    const recoveryKey = `${currentPath}:${hasServerTiming}:${observedAtMs}:${expiresAtMs}`;
    if (recoveryKeyRef.current !== recoveryKey) {
      recoveryKeyRef.current = recoveryKey;
      attemptCountRef.current = 0;
      finalAttemptDoneRef.current = false;
    }
    if (!enabled) {
      setIsAutoRevalidating(false);
      return;
    }

    let timeout: ReturnType<typeof setTimeout> | null = null;

    function readTimingState() {
      if (!hasServerTiming) return readFreshWriteTokenState(currentPath).kind;
      if (observedAtMs === undefined || expiresAtMs === undefined) return "missing";
      return Date.now() > expiresAtMs ? "expired" : "valid";
    }

    function hasAttemptBudget() {
      return attemptCountRef.current < maxRevalidations;
    }

    function revalidateCurrentPath() {
      if (!hasAttemptBudget()) {
        return;
      }
      attemptCountRef.current += 1;
      void navigateRef.current(currentPath, { replace: true, preventScrollReset: true });
    }

    function runFinalRevalidation() {
      if (finalAttemptDoneRef.current || !hasAttemptBudget() || navigationStateRef.current !== "idle") {
        return;
      }

      finalAttemptDoneRef.current = true;
      revalidateCurrentPath();
    }

    function tick() {
      timeout = null;
      const timingState = readTimingState();

      if (timingState === "valid" && hasAttemptBudget()) {
        if (navigationStateRef.current === "idle") {
          revalidateCurrentPath();
        }

        timeout = setTimeout(tick, intervalMs);
        return;
      }

      if (timingState === "expired" && !finalAttemptDoneRef.current && hasAttemptBudget()) {
        if (navigationStateRef.current !== "idle") {
          timeout = setTimeout(tick, intervalMs);
          return;
        }
        runFinalRevalidation();
      }

      setIsAutoRevalidating(false);
    }

    const initialTimingState = readTimingState();
    if (initialTimingState === "expired" && navigationStateRef.current === "idle") {
      runFinalRevalidation();
      setIsAutoRevalidating(false);
      return;
    }

    if (
      (initialTimingState !== "valid" && initialTimingState !== "expired") ||
      !hasAttemptBudget() ||
      finalAttemptDoneRef.current
    ) {
      setIsAutoRevalidating(false);
      return;
    }

    setIsAutoRevalidating(true);
    timeout = setTimeout(tick, intervalMs);

    return () => {
      if (timeout) {
        clearTimeout(timeout);
      }
    };
  }, [currentPath, enabled, intervalMs, maxRevalidations, hasServerTiming, observedAtMs, expiresAtMs]);

  return { currentPath, isAutoRevalidating };
}
