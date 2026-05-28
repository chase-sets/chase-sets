import { describe, expect, it, vi } from "vitest";
import {
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

    const response = createDurableJobEventStream({
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
});
