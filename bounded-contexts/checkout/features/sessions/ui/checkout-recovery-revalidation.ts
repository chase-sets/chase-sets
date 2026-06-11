import { useEffect, useRef, useState } from "react";
import { useNavigate, useNavigation } from "react-router";
import { readFreshWriteTokenState } from "@chase-sets/http/responses";

const DEFAULT_REVALIDATE_INTERVAL_MS = 2_000;
const DEFAULT_MAX_REVALIDATIONS = 15;

export type CheckoutPreparingRevalidationOptions = Readonly<{
  /** Only the temporary `checkout-preparing` recovery state revalidates automatically. */
  enabled: boolean;
  /** Current route path plus search, carrying the fresh-write `afterWrite` receipt. */
  currentPath: string;
  intervalMs?: number;
  maxRevalidations?: number;
  nowMs?: () => number;
}>;

export type CheckoutPreparingRevalidation = Readonly<{
  /** True while the recovery state is actively revalidating on the bounded schedule. */
  isAutoRevalidating: boolean;
}>;

/**
 * Actively revalidates the checkout-session route while the temporary
 * "Preparing checkout" recovery state is shown and the fresh-write receipt in
 * the current URL is still valid. Each attempt replays the current location
 * (a replace navigation to the same path), which re-runs the loader so the
 * receipt is forwarded again and the API freshness gate can wake and wait on
 * the exact checkout-session projection dependency. The same-location
 * navigation also clears the route error state once the session read
 * succeeds, so the page transitions to pay-ready checkout automatically.
 *
 * Termination is bounded twice: by the receipt age budget and by a hard
 * attempt cap. When the receipt expires, exactly one final revalidation runs
 * so the server resolves the terminal state (pay-ready checkout when the
 * projection caught up, otherwise the existing manual recovery). After that
 * the hook stops permanently; there is no infinite retry.
 */
export function useCheckoutPreparingRevalidation(
  options: CheckoutPreparingRevalidationOptions,
): CheckoutPreparingRevalidation {
  const { enabled, currentPath } = options;
  const intervalMs = options.intervalMs ?? DEFAULT_REVALIDATE_INTERVAL_MS;
  const maxRevalidations = options.maxRevalidations ?? DEFAULT_MAX_REVALIDATIONS;
  const navigate = useNavigate();
  const navigation = useNavigation();
  const navigateRef = useRef(navigate);
  const navigationStateRef = useRef(navigation.state);
  const nowMsRef = useRef(options.nowMs);
  useEffect(() => {
    navigateRef.current = navigate;
    navigationStateRef.current = navigation.state;
    nowMsRef.current = options.nowMs;
  });
  const attemptCountRef = useRef(0);
  const finalAttemptDoneRef = useRef(false);
  const [isAutoRevalidating, setIsAutoRevalidating] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setIsAutoRevalidating(false);
      return;
    }

    let timeout: ReturnType<typeof setTimeout> | null = null;

    function readTokenState() {
      return readFreshWriteTokenState(currentPath, nowMsRef.current?.() ?? Date.now());
    }

    function hasAttemptBudget() {
      return attemptCountRef.current < maxRevalidations;
    }

    function revalidateCurrentPath() {
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
      const tokenState = readTokenState();

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

    const initialTokenState = readTokenState();
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
  }, [enabled, currentPath, intervalMs, maxRevalidations]);

  return { isAutoRevalidating };
}
