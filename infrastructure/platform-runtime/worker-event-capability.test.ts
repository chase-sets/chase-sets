import { describe, expect, it, vi } from "vitest";
import type { WorkerQuiesceCohortSnapshot } from "./control-plane";
import {
  assessEventConsumerReadiness,
  createEventConsumerAdmission,
  listConsumedEventTypes,
  PLATFORM_WORKER_KIND,
  quiescedDeploymentsIncludePlatformWorker,
  WORKER_CONSUMED_EVENT_TYPES_METADATA_KEY,
} from "./worker-event-capability";

const snapshotAt = "2026-10-14T12:00:00.000Z";
const requirement = {
  anchorEventType: "synthetic.thing.created",
  requiredEventTypes: ["synthetic.thing.paused", "synthetic.thing.withdrawn"],
} as const;
const capable = ["synthetic.thing.created", "synthetic.thing.paused", "synthetic.thing.withdrawn"];
const old = ["synthetic.thing.created"];
const secondsAgo = (seconds: number) => new Date(Date.parse(snapshotAt) - seconds * 1000).toISOString();

function worker(
  workerId: string,
  times: Readonly<{ startedSecondsAgo: number; heartbeatSecondsAgo: number }>,
  consumed?: readonly string[],
) {
  return {
    worker_id: workerId,
    worker_kind: PLATFORM_WORKER_KIND,
    started_at: secondsAgo(times.startedSecondsAgo),
    heartbeat_at: secondsAgo(times.heartbeatSecondsAgo),
    metadata: consumed === undefined ? {} : { [WORKER_CONSUMED_EVENT_TYPES_METADATA_KEY]: consumed },
  };
}

// The latest deployment quiesce ran 20 minutes ago; capable workers started after it.
const quiescedAt = secondsAgo(20 * 60);
const fresh = (workerId: string, consumed: readonly string[] = capable) =>
  worker(workerId, { startedSecondsAgo: 15 * 60, heartbeatSecondsAgo: 5 }, consumed);
const retired = (workerId: string) =>
  worker(workerId, { startedSecondsAgo: 60 * 60, heartbeatSecondsAgo: 21 * 60 }, old);

const snapshot = (
  workers: readonly ReturnType<typeof worker>[],
  overrides: Partial<WorkerQuiesceCohortSnapshot> = {},
): WorkerQuiesceCohortSnapshot => ({ snapshotAt, quiescedAt, workers, leaseOwnerIds: [], ...overrides });

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

  it("recognizes the quiesced platform worker deployment by its release-prefixed name", () => {
    expect(quiescedDeploymentsIncludePlatformWorker("release-platform-worker")).toBe(true);
    expect(quiescedDeploymentsIncludePlatformWorker(" release-catalog-worker , platform-worker ")).toBe(true);
    expect(quiescedDeploymentsIncludePlatformWorker("release-catalog-worker")).toBe(false);
    expect(quiescedDeploymentsIncludePlatformWorker("release-platform-worker-canary")).toBe(false);
    expect(quiescedDeploymentsIncludePlatformWorker(undefined)).toBe(false);
  });

  it("is ready when every worker since the quiesce reads the required types and one is active", () => {
    expect(assessEventConsumerReadiness(snapshot([retired("wrk_old"), fresh("wrk_new")]), requirement)).toEqual({
      ready: true,
    });
    // A worker that does not host the anchor consumer is irrelevant to this requirement.
    expect(
      assessEventConsumerReadiness(snapshot([fresh("wrk_new"), fresh("wrk_other", ["other.event"])]), requirement),
    ).toEqual({ ready: true });
  });

  it("stays closed until a deployment quiesce is recorded", () => {
    expect(assessEventConsumerReadiness(snapshot([fresh("wrk_new")], { quiescedAt: null }), requirement)).toEqual({
      ready: false,
      reason: "workers_not_quiesced",
      workerIds: [],
    });
  });

  it("keeps an incapable worker started since the quiesce blocking however old its heartbeat is", () => {
    // Heartbeat writes can fail while the process keeps renewing its leases, so a stale heartbeat retires nothing.
    for (const heartbeatSecondsAgo of [5, 10 * 60 + 1, 6 * 60 * 60]) {
      expect(
        assessEventConsumerReadiness(
          snapshot([fresh("wrk_new"), worker("wrk_old", { startedSecondsAgo: 19 * 60, heartbeatSecondsAgo }, old)]),
          requirement,
        ),
      ).toEqual({ ready: false, reason: "worker_without_capability", workerIds: ["wrk_old"] });
    }
    expect(
      assessEventConsumerReadiness(
        snapshot([fresh("wrk_new"), worker("wrk_pre", { startedSecondsAgo: 19 * 60, heartbeatSecondsAgo: 30 })]),
        requirement,
      ),
    ).toMatchObject({ reason: "worker_without_capability", workerIds: ["wrk_pre"] });
  });

  it("treats a worker that heartbeated after the quiesce, or whose times are unreadable, as still running", () => {
    expect(
      assessEventConsumerReadiness(
        snapshot([
          fresh("wrk_new"),
          worker("wrk_survivor", { startedSecondsAgo: 60 * 60, heartbeatSecondsAgo: 60 }, old),
        ]),
        requirement,
      ),
    ).toMatchObject({ reason: "worker_without_capability", workerIds: ["wrk_survivor"] });
    expect(
      assessEventConsumerReadiness(
        snapshot([fresh("wrk_new"), { ...retired("wrk_bad"), started_at: "unreadable" }]),
        requirement,
      ),
    ).toMatchObject({ reason: "worker_without_capability", workerIds: ["wrk_bad"] });
  });

  it("stays closed while a worker retired by the quiesce still owns an unexpired lease", () => {
    expect(
      assessEventConsumerReadiness(
        snapshot([retired("wrk_old"), fresh("wrk_new")], { leaseOwnerIds: ["wrk_new", "wrk_old", "wrk_old"] }),
        requirement,
      ),
    ).toEqual({ ready: false, reason: "retired_worker_holds_lease", workerIds: ["wrk_old"] });
  });

  it("needs an active capable worker, not just a recent one", () => {
    expect(assessEventConsumerReadiness(snapshot([retired("wrk_old")]), requirement)).toEqual({
      ready: false,
      reason: "no_capable_worker",
      workerIds: [],
    });
    expect(
      assessEventConsumerReadiness(
        snapshot([worker("wrk_new", { startedSecondsAgo: 15 * 60, heartbeatSecondsAgo: 2 * 60 }, capable)]),
        requirement,
      ),
    ).toEqual({ ready: false, reason: "no_capable_worker", workerIds: [] });
  });

  it("is closed by the switch before reading the control plane, and re-reads it on every check", async () => {
    let workers: readonly ReturnType<typeof worker>[] = [retired("wrk_old"), fresh("wrk_new")];
    const query = vi.fn(async () => ({
      rows: [{ snapshot_at: new Date(snapshotAt), quiesced_at: new Date(quiescedAt), workers, lease_owner_ids: [] }],
    }));
    const db = { query } as never;
    await expect(createEventConsumerAdmission({ open: false, db, requirement }).check()).resolves.toEqual({
      admitted: false,
      reason: "switch_closed",
    });
    expect(query).not.toHaveBeenCalled();
    await expect(createEventConsumerAdmission({ open: true, requirement }).check()).resolves.toEqual({
      admitted: false,
      reason: "control_plane_unavailable",
    });
    const admission = createEventConsumerAdmission({ open: true, db, requirement });
    await expect(admission.check()).resolves.toEqual({ admitted: true });
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("FROM platform_worker_quiesces"), [
      PLATFORM_WORKER_KIND,
    ]);
    workers = [...workers, worker("wrk_rolled_back", { startedSecondsAgo: 1, heartbeatSecondsAgo: 1 }, old)];
    await expect(admission.check()).resolves.toEqual({
      admitted: false,
      reason: "worker_without_capability",
      workerIds: ["wrk_rolled_back"],
    });
    expect(query).toHaveBeenCalledTimes(2);
  });
});
