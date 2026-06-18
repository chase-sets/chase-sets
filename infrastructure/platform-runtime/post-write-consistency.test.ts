import { afterEach, describe, expect, it, vi } from "vitest";
import {
  recordPlatformPostWriteConsistencyEvent,
  registerPostWriteConsistencyRecorder,
  type PlatformPostWriteConsistencyEvent,
} from "./post-write-consistency";

const accountCartPendingEvent = {
  boundedContextName: "checkout",
  surface: "account-cart",
  strategy: "fresh-read",
  outcome: "handoff_pending",
  routeId: "account-cart",
  routeTemplate: "/account/cart",
  correctionSource: "semantic-handoff:checkout.cart.add-line",
  actorMode: "account",
  recoveryAction: "pending_empty_state",
  freshnessOutcome: "valid-after-write",
} as const satisfies PlatformPostWriteConsistencyEvent;

let unregister: (() => void) | null = null;

afterEach(() => {
  unregister?.();
  unregister = null;
});

describe("post-write consistency telemetry port", () => {
  it("buffers bounded events until a deployable registers an adapter", () => {
    expect(() => recordPlatformPostWriteConsistencyEvent(accountCartPendingEvent)).not.toThrow();

    const recorder = vi.fn();
    unregister = registerPostWriteConsistencyRecorder(recorder);

    expect(recorder).toHaveBeenCalledWith(accountCartPendingEvent);
  });

  it("forwards structural post-write consistency events to the registered adapter", () => {
    const recorder = vi.fn();
    unregister = registerPostWriteConsistencyRecorder(recorder);

    recordPlatformPostWriteConsistencyEvent(accountCartPendingEvent);

    expect(recorder).toHaveBeenCalledWith(accountCartPendingEvent);
  });

  it("restores the previous adapter when the current registration is released", () => {
    const first = vi.fn();
    const second = vi.fn();
    const unregisterFirst = registerPostWriteConsistencyRecorder(first);
    const unregisterSecond = registerPostWriteConsistencyRecorder(second);
    unregister = () => {
      unregisterSecond();
      unregisterFirst();
    };

    recordPlatformPostWriteConsistencyEvent(accountCartPendingEvent);
    unregisterSecond();
    recordPlatformPostWriteConsistencyEvent({
      ...accountCartPendingEvent,
      outcome: "handoff_satisfied",
      recoveryAction: "none",
    });

    expect(second).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "handoff_satisfied",
      }),
    );
  });
});
