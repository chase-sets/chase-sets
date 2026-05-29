import { describe, expect, it, vi } from "vitest";
import {
  createInMemoryDurableJobStreamLimiter,
  createDurableJobEventStream,
  formatDurableJobSseEvent,
  parseDurableJobEventCursor,
} from "./durable-job-events";

describe("durable job event streams", () => {
  it("formats SSE events with durable ids", () => {
    expect(formatDurableJobSseEvent({ sequence: 42, eventName: "status", data: { status: "running" } })).toBe(
      'id: 42\nevent: status\ndata: {"status":"running"}\n\n',
    );
  });

  it("parses Last-Event-ID style cursors", () => {
    expect(parseDurableJobEventCursor("7")).toBe(7);
    expect(parseDurableJobEventCursor("job_1:9")).toBe(9);
    expect(parseDurableJobEventCursor("nope")).toBe(0);
  });

  it("replays events after the request cursor and closes on terminal status", async () => {
    const loadEvents = vi.fn(async (afterSequence: number) =>
      afterSequence < 2
        ? [
            { sequence: 2, eventName: "status", data: { status: "running" } },
            { sequence: 3, eventName: "status", data: { status: "completed" } },
          ]
        : [],
    );
    const request = new Request("https://admin.test/jobs/job_1/events", {
      headers: { "Last-Event-ID": "1" },
    });

    const response = await createDurableJobEventStream({
      request,
      loadEvents,
      isTerminal: (event) => event.data.status === "completed",
    });

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).toContain("id: 2");
    expect(body).toContain('"status":"running"');
    expect(body).toContain("id: 3");
    expect(body).toContain('"status":"completed"');
    expect(loadEvents).toHaveBeenCalledWith(1);
  });

  it("closes terminal reconnects when the cursor already passed the terminal event", async () => {
    const waitForEvents = vi.fn(async () => undefined);
    const response = await createDurableJobEventStream({
      request: new Request("https://admin.test/jobs/job_1/events", {
        headers: { "Last-Event-ID": "3" },
      }),
      loadEvents: vi.fn(async () => []),
      loadCurrentSnapshot: vi.fn(async () => ({ status: "completed" })),
      waitForEvents,
      isTerminal: (event) => event.data.status === "completed",
      isTerminalSnapshot: (snapshot) => snapshot.status === "completed",
    });

    await expect(response.text()).resolves.toBe("");
    expect(waitForEvents).not.toHaveBeenCalled();
  });

  it("rejects durable job streams when the limiter is exhausted", async () => {
    const limiter = createInMemoryDurableJobStreamLimiter({ maxActiveStreams: 1, maxActiveStreamsPerConnectionKey: 1 });
    const held = await limiter.acquire({ connectionKey: "account_1" });

    const response = await createDurableJobEventStream({
      streamLimiter: limiter,
      streamLimitKey: "account_1",
      loadEvents: async () => [],
      isTerminal: () => false,
    });

    expect(response.status).toBe(429);
    held?.release();
  });

  it("returns a structured unavailable response when the limiter backend fails", async () => {
    const response = await createDurableJobEventStream({
      streamLimiter: {
        acquire: async () => {
          throw new Error("limiter unavailable");
        },
      },
      streamLimitKey: "account_1",
      loadEvents: async () => [],
      isTerminal: () => false,
    });

    await expect(response.json()).resolves.toEqual({
      error: {
        code: "durable_job_stream_limiter_unavailable",
        message: "Durable job status streams are temporarily unavailable.",
      },
    });
    expect(response.status).toBe(503);
  });
});
