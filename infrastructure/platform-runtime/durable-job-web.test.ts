import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeDurableJobStatus } from "./durable-job-web";

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly listeners = new Map<string, Set<(event: Event) => void>>();
  readonly close = vi.fn();

  constructor(readonly url: string) {
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

describe("durable job web subscriptions", () => {
  const originalWindow = globalThis.window;
  const originalEventSource = globalThis.EventSource;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    Object.defineProperty(globalThis, "window", {
      value: { location: { href: "https://admin.test/catalog" } },
      configurable: true,
    });
    Object.defineProperty(globalThis, "EventSource", {
      value: FakeEventSource,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(globalThis, "window", {
      value: originalWindow,
      configurable: true,
    });
    Object.defineProperty(globalThis, "EventSource", {
      value: originalEventSource,
      configurable: true,
    });
  });

  it("reopens manual reconnects with the last durable event cursor", () => {
    const statuses: unknown[] = [];
    const subscription = subscribeDurableJobStatus({
      url: "/api/catalog/source-observations/integration-jobs/job_1/events",
      onStatus: (job) => statuses.push(job),
      reconnectDelayMs: 500,
    });

    expect(FakeEventSource.instances[0]?.url).toBe("/api/catalog/source-observations/integration-jobs/job_1/events");
    FakeEventSource.instances[0]?.emit("status", { status: "running" }, "7");
    FakeEventSource.instances[0]?.emit("error", {});
    vi.advanceTimersByTime(500);

    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1]?.url).toBe(
      "https://admin.test/api/catalog/source-observations/integration-jobs/job_1/events?cursor=7",
    );
    expect(statuses).toEqual([{ status: "running" }]);

    subscription.close();
  });

  it("applies sync-required snapshots and reconnects with the sync cursor", () => {
    const statuses: unknown[] = [];
    const subscription = subscribeDurableJobStatus({
      url: "/api/catalog/source-observations/integration-jobs/job_1/events",
      onStatus: (job) => statuses.push(job),
      reconnectDelayMs: 500,
    });

    FakeEventSource.instances[0]?.emit(
      "sync.required",
      { kind: "sync.required", snapshot: { status: "running", progress: { completed: 50 } } },
      "42",
    );
    vi.advanceTimersByTime(500);

    expect(statuses).toEqual([{ status: "running", progress: { completed: 50 } }]);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1]?.url).toBe(
      "https://admin.test/api/catalog/source-observations/integration-jobs/job_1/events?cursor=42",
    );

    subscription.close();
  });

  it("supports custom terminal predicates for non-durable-job status vocabularies", () => {
    const statuses: unknown[] = [];
    const terminal = vi.fn();
    const subscription = subscribeDurableJobStatus({
      url: "/api/platform/projections/operations/op_1/events",
      isTerminal: (job: { state: string }) => job.state === "succeeded",
      onStatus: (job) => statuses.push(job),
      onTerminal: terminal,
    });

    FakeEventSource.instances[0]?.emit("status", { state: "succeeded" }, "3");
    FakeEventSource.instances[0]?.emit("error", {});
    vi.advanceTimersByTime(1_000);

    expect(statuses).toEqual([{ state: "succeeded" }]);
    expect(terminal).toHaveBeenCalledWith({ state: "succeeded" });
    expect(FakeEventSource.instances[0]?.close).toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(1);

    subscription.close();
  });

  it("reports connection open/dropped transitions without conflating them with job status", () => {
    const states: boolean[] = [];
    const subscription = subscribeDurableJobStatus({
      url: "/api/platform/projections/operations/op_1/events",
      onStatus: () => undefined,
      onConnectionStateChange: (connected) => states.push(connected),
      reconnectDelayMs: 500,
    });

    FakeEventSource.instances[0]?.emit("open", {});
    expect(states).toEqual([true]);

    FakeEventSource.instances[0]?.emit("status", { status: "running" }, "1");
    expect(states).toEqual([true]);

    FakeEventSource.instances[0]?.emit("error", {});
    expect(states).toEqual([true, false]);

    vi.advanceTimersByTime(500);
    FakeEventSource.instances[1]?.emit("open", {});
    expect(states).toEqual([true, false, true]);

    subscription.close();
  });

  it("does not report a dropped connection when a terminal job closes the stream cleanly", () => {
    const states: boolean[] = [];
    const subscription = subscribeDurableJobStatus({
      url: "/api/platform/projections/operations/op_1/events",
      isTerminal: (job: { state: string }) => job.state === "succeeded",
      onStatus: () => undefined,
      onConnectionStateChange: (connected) => states.push(connected),
    });

    FakeEventSource.instances[0]?.emit("open", {});
    FakeEventSource.instances[0]?.emit("status", { state: "succeeded" }, "1");
    // The browser reports the server ending the stream as an "error" even
    // though the job already reached a terminal state — this must not read as
    // a dropped connection.
    FakeEventSource.instances[0]?.emit("error", {});

    expect(states).toEqual([true]);

    subscription.close();
  });
});
