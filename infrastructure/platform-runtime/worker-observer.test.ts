import { describe, expect, it, vi } from "vitest";
import { createWorkerObserver } from "./worker-observer";

describe("worker observer holder lifecycle adapter", () => {
  it("emits the allowlisted holder lifecycle log shape", () => {
    const logs: Array<Readonly<Record<string, unknown>>> = [];
    const logger = {
      debug: vi.fn(),
      info: vi.fn((_message: string, fields?: Readonly<Record<string, unknown>>) => {
        if (fields?.type === "worker.runner.holder_lifecycle") {
          logs.push(fields);
        }
      }),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const observer = createWorkerObserver(logger, "platform-worker", "projections");

    observer.holderLifecycle?.({
      workerId: "worker-a",
      runnerName: "catalog.listing",
      leaseIntervalId: "123e4567-e89b-42d3-a456-426614174000",
      timestamp: "2026-09-30T17:00:00.000Z",
      elapsedMs: 12.5,
      phase: "pass-end",
      passSeq: 1,
      outcome: "success",
      disposition: "retained",
      processed: 2,
    });

    expect(logs).toHaveLength(1);
    expect(logs[0]).toEqual({
      type: "worker.runner.holder_lifecycle",
      workerKind: "platform-worker",
      runnerGroup: "projections",
      workerId: "worker-a",
      runnerName: "catalog.listing",
      leaseIntervalId: "123e4567-e89b-42d3-a456-426614174000",
      timestamp: "2026-09-30T17:00:00.000Z",
      elapsedMs: 12.5,
      phase: "pass-end",
      passSeq: 1,
      outcome: "success",
      disposition: "retained",
      processed: 2,
    });
  });

  it("drops malformed lifecycle fields without logging secrets or payloads", () => {
    const info = vi.fn();
    const observer = createWorkerObserver({ debug: vi.fn(), info, warn: vi.fn(), error: vi.fn() }, "platform-worker");

    observer.holderLifecycle?.({
      workerId: "worker-a",
      runnerName: "catalog.listing",
      leaseIntervalId: "not-an-id",
      timestamp: "2026-09-30T17:00:00.000Z",
      elapsedMs: 1,
      phase: "acquired",
    });

    expect(info).not.toHaveBeenCalled();
  });
});
