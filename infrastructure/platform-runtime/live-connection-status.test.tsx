// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deriveLiveConnectionStatus,
  useLiveConnectionStatus,
  type LiveConnectionStatusState,
} from "./live-connection-status";

describe("deriveLiveConnectionStatus", () => {
  it("goes live on a connected event regardless of the prior state", () => {
    const stale: LiveConnectionStatusState = { status: "stale", staleSince: new Date("2026-07-09T00:00:00.000Z") };

    expect(deriveLiveConnectionStatus(stale, { type: "connected" })).toEqual({ status: "live", staleSince: null });
  });

  it("drops from live to connecting on disconnect, resetting staleSince", () => {
    const live: LiveConnectionStatusState = { status: "live", staleSince: null };

    expect(deriveLiveConnectionStatus(live, { type: "disconnected" })).toEqual({
      status: "connecting",
      staleSince: null,
    });
  });

  it("leaves an already-connecting or already-stale state untouched by a second disconnect event", () => {
    const connecting: LiveConnectionStatusState = { status: "connecting", staleSince: null };
    const stale: LiveConnectionStatusState = { status: "stale", staleSince: new Date("2026-07-09T00:00:00.000Z") };

    expect(deriveLiveConnectionStatus(connecting, { type: "disconnected" })).toBe(connecting);
    expect(deriveLiveConnectionStatus(stale, { type: "disconnected" })).toBe(stale);
  });

  it("escalates to stale with the timeout's timestamp", () => {
    const connecting: LiveConnectionStatusState = { status: "connecting", staleSince: null };
    const at = new Date("2026-07-09T00:00:10.000Z");

    expect(deriveLiveConnectionStatus(connecting, { type: "stale-timeout", at })).toEqual({
      status: "stale",
      staleSince: at,
    });
  });
});

let latest: LiveConnectionStatusState;

function Probe({ connected, staleAfterMs }: { connected: boolean; staleAfterMs?: number }) {
  latest = useLiveConnectionStatus(connected, { staleAfterMs });
  return null;
}

describe("useLiveConnectionStatus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts live when the transport is already connected", () => {
    render(<Probe connected={true} />);

    expect(latest).toEqual({ status: "live", staleSince: null });
  });

  it("starts connecting, then escalates to stale once the threshold elapses", () => {
    render(<Probe connected={false} staleAfterMs={1_000} />);

    expect(latest.status).toBe("connecting");

    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(latest.status).toBe("connecting");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(latest.status).toBe("stale");
    expect(latest.staleSince).toBeInstanceOf(Date);
  });

  it("never flaps to stale when the transport reconnects inside the grace window", () => {
    const { rerender } = render(<Probe connected={true} staleAfterMs={1_000} />);
    expect(latest.status).toBe("live");

    rerender(<Probe connected={false} staleAfterMs={1_000} />);
    expect(latest.status).toBe("connecting");

    act(() => {
      vi.advanceTimersByTime(500);
    });

    rerender(<Probe connected={true} staleAfterMs={1_000} />);
    expect(latest.status).toBe("live");

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(latest.status).toBe("live");
  });

  it("returns to live and clears staleSince once a stale connection recovers", () => {
    const { rerender } = render(<Probe connected={false} staleAfterMs={1_000} />);

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(latest.status).toBe("stale");

    rerender(<Probe connected={true} staleAfterMs={1_000} />);
    expect(latest).toEqual({ status: "live", staleSince: null });
  });
});
