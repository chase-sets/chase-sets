import { useEffect, useState } from "react";

export type LiveConnectionStatus = "live" | "connecting" | "stale";

export type LiveConnectionStatusState = Readonly<{
  status: LiveConnectionStatus;
  staleSince: Date | null;
}>;

// Grace window a disconnected transport gets before the surface escalates to
// "stale": long enough that a routine EventSource reconnect (network blip,
// server rolling deploy) never flaps the indicator, short enough that an
// operator watching a realtime admin surface notices a genuinely dead
// connection quickly.
export const DEFAULT_LIVE_CONNECTION_STALE_AFTER_MS = 10_000;

type LiveConnectionEvent =
  | Readonly<{ type: "connected" }>
  | Readonly<{ type: "disconnected" }>
  | Readonly<{ type: "stale-timeout"; at: Date }>;

/**
 * Pure state transition for the live/connecting/stale machine, split out from
 * {@link useLiveConnectionStatus} so the escalation logic is unit-testable
 * without rendering React or faking timers. "live" only ever comes from an
 * explicit `connected` event (never inferred from data activity — a quiet-but-
 * open SSE connection stays live). "stale" only ever comes from the timeout
 * firing after a sustained disconnect.
 */
export function deriveLiveConnectionStatus(
  current: LiveConnectionStatusState,
  event: LiveConnectionEvent,
): LiveConnectionStatusState {
  switch (event.type) {
    case "connected":
      return { status: "live", staleSince: null };
    case "disconnected":
      return current.status === "live" ? { status: "connecting", staleSince: null } : current;
    case "stale-timeout":
      return { status: "stale", staleSince: event.at };
    default:
      return current;
  }
}

/**
 * Derives a live/connecting/stale status from a raw transport `connected`
 * signal (an EventSource's open/closed state — see `realtime-web`'s and
 * `durable-job-web`'s `onConnectionStateChange`). A disconnect holds
 * "connecting" for `staleAfterMs` before escalating to "stale" so a brief
 * reconnect never flaps the indicator; `staleSince` records the instant the
 * escalation fires so consumers can render a "stale since <time>" affordance.
 */
export function useLiveConnectionStatus(
  connected: boolean,
  options: Readonly<{ staleAfterMs?: number }> = {},
): LiveConnectionStatusState {
  const staleAfterMs = Math.max(0, options.staleAfterMs ?? DEFAULT_LIVE_CONNECTION_STALE_AFTER_MS);
  const [state, setState] = useState<LiveConnectionStatusState>(() =>
    deriveLiveConnectionStatus(
      { status: "connecting", staleSince: null },
      connected ? { type: "connected" } : { type: "disconnected" },
    ),
  );

  useEffect(() => {
    if (connected) {
      setState((current) => deriveLiveConnectionStatus(current, { type: "connected" }));
      return;
    }

    setState((current) => deriveLiveConnectionStatus(current, { type: "disconnected" }));
    const timeout = setTimeout(() => {
      setState((current) => deriveLiveConnectionStatus(current, { type: "stale-timeout", at: new Date() }));
    }, staleAfterMs);

    return () => clearTimeout(timeout);
  }, [connected, staleAfterMs]);

  return state;
}
