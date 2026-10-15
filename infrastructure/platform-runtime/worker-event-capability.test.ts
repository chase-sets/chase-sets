import { describe, expect, it, vi } from "vitest";
import {
  assessEventConsumerReadiness,
  createEventConsumerAdmission,
  listConsumedEventTypes,
  WORKER_CONSUMED_EVENT_TYPES_METADATA_KEY,
} from "./worker-event-capability";

const snapshotAt = "2026-10-14T12:00:00.000Z";
const requirement = {
  anchorEventType: "synthetic.thing.created",
  requiredEventTypes: ["synthetic.thing.paused", "synthetic.thing.withdrawn"],
} as const;
const capable = ["synthetic.thing.created", "synthetic.thing.paused", "synthetic.thing.withdrawn"];
const old = ["synthetic.thing.created"];

function worker(workerId: string, secondsAgo: number, consumed?: readonly string[] | "absent") {
  return {
    worker_id: workerId,
    worker_kind: "platform-worker",
    heartbeat_at: new Date(Date.parse(snapshotAt) - secondsAgo * 1000).toISOString(),
    metadata:
      consumed === "absent" || consumed === undefined ? {} : { [WORKER_CONSUMED_EVENT_TYPES_METADATA_KEY]: consumed },
  };
}

const assess = (...workers: ReturnType<typeof worker>[]) =>
  assessEventConsumerReadiness({ snapshotAt, workers }, requirement);

describe("worker event capability", () => {
  it("lists the sorted event types the runners read, falling back to handler keys", () => {
    expect(
      listConsumedEventTypes([
        { eventTypes: ["b.event", "a.event"] },
        { handlers: { "c.event": async () => undefined } },
        { eventTypes: ["a.event"] },
      ]),
    ).toEqual(["a.event", "b.event", "c.event"]);
  });

  it("is ready only when every live worker reads the required types and a capable worker is active", () => {
    expect(assess(worker("wrk_new", 5, capable))).toEqual({ ready: true });
    // A worker that does not host the anchor consumer is irrelevant to this requirement.
    expect(assess(worker("wrk_new", 5, capable), worker("wrk_other", 5, ["other.event"]))).toEqual({ ready: true });
  });

  it("stays closed while an old worker heartbeated within the expired window", () => {
    expect(assess(worker("wrk_new", 5, capable), worker("wrk_old", 9 * 60, old))).toEqual({
      ready: false,
      reason: "worker_without_capability",
      workerIds: ["wrk_old"],
    });
    expect(assess(worker("wrk_new", 5, capable), worker("wrk_pre", 30, "absent"))).toMatchObject({
      reason: "worker_without_capability",
      workerIds: ["wrk_pre"],
    });
    expect(
      assess(worker("wrk_new", 5, capable), { ...worker("wrk_bad", 0, old), heartbeat_at: "unreadable" }),
    ).toMatchObject({
      reason: "worker_without_capability",
      workerIds: ["wrk_bad"],
    });
  });

  it("opens once old heartbeats age past the expired window", () => {
    expect(assess(worker("wrk_new", 5, capable), worker("wrk_old", 10 * 60 + 1, old))).toEqual({ ready: true });
  });

  it("needs an active capable worker, not just a recent one", () => {
    expect(assess()).toEqual({ ready: false, reason: "no_capable_worker", workerIds: [] });
    expect(assess(worker("wrk_new", 2 * 60, capable))).toEqual({
      ready: false,
      reason: "no_capable_worker",
      workerIds: [],
    });
  });

  it("is closed by the switch before reading heartbeats, and re-reads them on every check", async () => {
    const readWorkerHeartbeatHistory = vi.fn(async () => ({
      snapshotAt,
      workers: [worker("wrk_new", 5, capable)],
      summary: {} as never,
    }));
    await expect(
      createEventConsumerAdmission({ open: false, controlPlane: { readWorkerHeartbeatHistory }, requirement }).check(),
    ).resolves.toEqual({ admitted: false, reason: "switch_closed" });
    expect(readWorkerHeartbeatHistory).not.toHaveBeenCalled();
    await expect(createEventConsumerAdmission({ open: true, requirement }).check()).resolves.toEqual({
      admitted: false,
      reason: "control_plane_unavailable",
    });
    const admission = createEventConsumerAdmission({
      open: true,
      controlPlane: { readWorkerHeartbeatHistory },
      requirement,
    });
    await expect(admission.check()).resolves.toEqual({ admitted: true });
    readWorkerHeartbeatHistory.mockResolvedValueOnce({
      snapshotAt,
      workers: [worker("wrk_new", 5, capable), worker("wrk_rolled_back", 1, old)],
      summary: {} as never,
    });
    await expect(admission.check()).resolves.toEqual({
      admitted: false,
      reason: "worker_without_capability",
      workerIds: ["wrk_rolled_back"],
    });
    expect(readWorkerHeartbeatHistory).toHaveBeenCalledTimes(2);
  });
});
