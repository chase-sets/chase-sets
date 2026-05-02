import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRealtimeSubscriptionDiagnostics,
  subscribeRealtimePatches,
} from "./realtime-web";

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly listeners = new Map<string, Set<(event: Event) => void>>();
  readonly close = vi.fn();

  constructor(
    readonly url: string,
    readonly init?: EventSourceInit,
  ) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: Event) => void) {
    const listeners = this.listeners.get(type) ?? new Set<(event: Event) => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, data: unknown, lastEventId = "") {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data), lastEventId } as MessageEvent);
    }
  }
}

describe("realtime web subscriptions", () => {
  const originalWindow = globalThis.window;
  const originalEventSource = globalThis.EventSource;

  beforeEach(() => {
    FakeEventSource.instances = [];
    Object.defineProperty(globalThis, "window", {
      value: {},
      configurable: true,
    });
    Object.defineProperty(globalThis, "EventSource", {
      value: FakeEventSource,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "window", {
      value: originalWindow,
      configurable: true,
    });
    Object.defineProperty(globalThis, "EventSource", {
      value: originalEventSource,
      configurable: true,
    });
  });

  it("coalesces matching topic sets onto one EventSource", () => {
    const patches: unknown[] = [];
    const first = subscribeRealtimePatches({
      topics: ["listing:list_1", "public:market"],
      onPatch: (patch) => patches.push(["first", patch]),
      onSyncRequired: () => undefined,
      debounceMs: 0,
    });
    const second = subscribeRealtimePatches({
      topics: ["public:market", "listing:list_1"],
      onPatch: (patch) => patches.push(["second", patch]),
      onSyncRequired: () => undefined,
      debounceMs: 0,
    });

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe(
      "/api/realtime/events?topic=listing%3Alist_1&topic=public%3Amarket",
    );
    expect(FakeEventSource.instances[0].init).toEqual({ withCredentials: true });
    expect(getRealtimeSubscriptionDiagnostics()).toMatchObject({
      activeSourceCount: 1,
      sources: [
        {
          topics: ["listing:list_1", "public:market"],
          subscriberCount: 2,
        },
      ],
    });

    FakeEventSource.instances[0].emit("projection.patch", {
      kind: "projection.patch",
      context: "discovery",
      projection: "discovery-market-projection",
      topics: ["listing:list_1", "public:market"],
      changes: [{ op: "remove", entity: "discovery.marketListing", id: "list_1" }],
    }, "cursor_1");

    expect(patches.map((entry) => (entry as unknown[])[0])).toEqual(["first", "second"]);
    expect(getRealtimeSubscriptionDiagnostics().sources[0]).toMatchObject({
      lastEventId: "cursor_1",
      subscriberCount: 2,
    });

    first.close();
    expect(FakeEventSource.instances[0].close).not.toHaveBeenCalled();

    second.close();
    expect(FakeEventSource.instances[0].close).toHaveBeenCalledTimes(1);
  });

  it("ignores malformed streamed messages before invoking handlers", () => {
    const onPatch = vi.fn();
    const onSyncRequired = vi.fn();
    const subscription = subscribeRealtimePatches({
      topics: ["public:market"],
      onPatch,
      onSyncRequired,
      debounceMs: 0,
    });

    FakeEventSource.instances[0].emit("projection.patch", {
      kind: "projection.patch",
      context: "discovery",
      projection: "discovery-market-projection",
      topics: ["public:market"],
      changes: [],
    });
    FakeEventSource.instances[0].emit("sync.required", {
      kind: "sync.required",
      reason: "unknown",
      contexts: ["discovery"],
    });

    expect(onPatch).not.toHaveBeenCalled();
    expect(onSyncRequired).not.toHaveBeenCalled();

    subscription.close();
  });
});
