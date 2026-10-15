import type { ContextSubscriptionRunner } from "@chase-sets/bounded-context-runtime";
import {
  ACTIVE_WORKER_HEARTBEAT_MAX_AGE_MS,
  EXPIRED_WORKER_HEARTBEAT_MAX_AGE_MS,
  type PlatformControlPlane,
  type WorkerHeartbeatHistorySnapshot,
} from "./control-plane";

/** Worker heartbeat metadata key listing every event type the worker's subscription runners read. */
export const WORKER_CONSUMED_EVENT_TYPES_METADATA_KEY = "consumedEventTypes";

/** The sorted event types a worker's subscription runners filter on; a runner without `eventTypes` reads its handler keys. */
export function listConsumedEventTypes(
  runners: readonly Pick<ContextSubscriptionRunner, "eventTypes" | "handlers">[],
): readonly string[] {
  return [...new Set(runners.flatMap((runner) => runner.eventTypes ?? Object.keys(runner.handlers ?? {})))].sort();
}

export type EventConsumerReadinessRequirement = Readonly<{
  /** A live worker reading this event type hosts a consumer that must also read every required type. */
  anchorEventType: string;
  requiredEventTypes: readonly string[];
}>;

export type EventConsumerReadiness =
  | Readonly<{ ready: true }>
  | Readonly<{
      ready: false;
      reason: "worker_without_capability" | "no_capable_worker";
      workerIds: readonly string[];
    }>;

/**
 * Producer admission for event types added to existing subscriptions. An old worker filters the new
 * types out and can checkpoint past them, so a producer stays closed until no worker without them has
 * heartbeated within the expired-heartbeat window (far beyond the lease TTL) and a capable worker is
 * active. A heartbeat without the capability key comes from a build that predates it and blocks admission.
 */
export function assessEventConsumerReadiness(
  snapshot: Pick<WorkerHeartbeatHistorySnapshot, "snapshotAt" | "workers">,
  requirement: EventConsumerReadinessRequirement,
): EventConsumerReadiness {
  const snapshotAtMs = Date.parse(snapshot.snapshotAt);
  const workers = snapshot.workers.flatMap((worker) => {
    const heartbeatAgeMs = snapshotAtMs - Date.parse(String(worker.heartbeat_at));
    // An unreadable heartbeat time counts as live, so it can only close admission.
    if (heartbeatAgeMs > EXPIRED_WORKER_HEARTBEAT_MAX_AGE_MS) return [];
    const metadata = worker.metadata as Record<string, unknown> | null | undefined;
    const consumed = metadata?.[WORKER_CONSUMED_EVENT_TYPES_METADATA_KEY];
    return [
      {
        workerId: String(worker.worker_id),
        active: heartbeatAgeMs <= ACTIVE_WORKER_HEARTBEAT_MAX_AGE_MS,
        consumed: Array.isArray(consumed) ? new Set(consumed.filter((type) => typeof type === "string")) : null,
      },
    ];
  });
  const readsAll = (consumed: ReadonlySet<string>) =>
    requirement.requiredEventTypes.every((eventType) => consumed.has(eventType));
  const incapable = workers.filter(
    (worker) =>
      worker.consumed === null || (worker.consumed.has(requirement.anchorEventType) && !readsAll(worker.consumed)),
  );
  if (incapable.length > 0)
    return { ready: false, reason: "worker_without_capability", workerIds: incapable.map((worker) => worker.workerId) };
  const capable = workers.some(
    (worker) => worker.active && worker.consumed?.has(requirement.anchorEventType) && readsAll(worker.consumed),
  );
  return capable ? { ready: true } : { ready: false, reason: "no_capable_worker", workerIds: [] };
}

export type EventConsumerAdmissionDecision =
  | Readonly<{ admitted: true }>
  | Readonly<{
      admitted: false;
      reason: "switch_closed" | "control_plane_unavailable" | "worker_without_capability" | "no_capable_worker";
      workerIds?: readonly string[];
    }>;

/**
 * A default-closed producer admission: the operator switch opens it only once the live workers read the
 * required event types. The decision is read per call, so a returning old worker closes it again.
 */
export function createEventConsumerAdmission(
  input: Readonly<{
    open: boolean;
    controlPlane?: Pick<PlatformControlPlane, "readWorkerHeartbeatHistory">;
    requirement: EventConsumerReadinessRequirement;
  }>,
): Readonly<{ check: () => Promise<EventConsumerAdmissionDecision> }> {
  return {
    async check() {
      if (!input.open) return { admitted: false, reason: "switch_closed" };
      if (!input.controlPlane) return { admitted: false, reason: "control_plane_unavailable" };
      const readiness = assessEventConsumerReadiness(
        await input.controlPlane.readWorkerHeartbeatHistory(),
        input.requirement,
      );
      return readiness.ready
        ? { admitted: true }
        : { admitted: false, reason: readiness.reason, workerIds: readiness.workerIds };
    },
  };
}
