import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useNavigation } from "react-router";
import { readFreshWriteTokenState } from "@chase-sets/http/responses";

const DEFAULT_REVALIDATE_INTERVAL_MS = 2_000;
const DEFAULT_MAX_REVALIDATIONS = 15;

export function usePendingFreshWriteRevalidation(
  enabled: boolean,
  options: Readonly<{
    intervalMs?: number;
    maxRevalidations?: number;
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
  const [isAutoRevalidating, setIsAutoRevalidating] = useState(false);
  const intervalMs = options.intervalMs ?? DEFAULT_REVALIDATE_INTERVAL_MS;
  const maxRevalidations = options.maxRevalidations ?? DEFAULT_MAX_REVALIDATIONS;

  useEffect(() => {
    navigateRef.current = navigate;
    navigationStateRef.current = navigation.state;
  });

  useEffect(() => {
    if (!enabled) {
      attemptCountRef.current = 0;
      finalAttemptDoneRef.current = false;
      setIsAutoRevalidating(false);
      return;
    }

    let timeout: ReturnType<typeof setTimeout> | null = null;
    attemptCountRef.current = 0;
    finalAttemptDoneRef.current = false;

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
      if (finalAttemptDoneRef.current || !hasAttemptBudget()) {
        return;
      }

      finalAttemptDoneRef.current = true;
      revalidateCurrentPath();
    }

    function tick() {
      timeout = null;
      const tokenState = readFreshWriteTokenState(currentPath);

      if (tokenState.kind === "valid" && hasAttemptBudget()) {
        if (navigationStateRef.current === "idle") {
          revalidateCurrentPath();
        }

        timeout = setTimeout(tick, intervalMs);
        return;
      }

      if (tokenState.kind === "expired") {
        runFinalRevalidation();
      }

      setIsAutoRevalidating(false);
    }

    const initialTokenState = readFreshWriteTokenState(currentPath);
    if (initialTokenState.kind === "expired") {
      runFinalRevalidation();
      setIsAutoRevalidating(false);
      return;
    }

    if (initialTokenState.kind !== "valid" || !hasAttemptBudget()) {
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
  }, [currentPath, enabled, intervalMs, maxRevalidations]);

  return { currentPath, isAutoRevalidating };
}
