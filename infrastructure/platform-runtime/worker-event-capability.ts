import type { ContextSubscriptionRunner } from "@chase-sets/bounded-context-runtime";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  ACTIVE_WORKER_HEARTBEAT_MAX_AGE_MS,
  readWorkerQuiesceCohort,
  type WorkerQuiesceCohortSnapshot,
} from "./control-plane";

/** The worker kind every platform worker heartbeats and leases as; its deployment is quiesced before each bootstrap. */
export const PLATFORM_WORKER_KIND = "platform-worker";

/** Worker heartbeat metadata key listing every event type the worker's subscription runners read. */
export const WORKER_CONSUMED_EVENT_TYPES_METADATA_KEY = "consumedEventTypes";

/** The sorted event types a worker's subscription runners filter on; a runner without `eventTypes` reads its handler keys. */
export function listConsumedEventTypes(
  runners: readonly Pick<ContextSubscriptionRunner, "eventTypes" | "handlers">[],
): readonly string[] {
  return [...new Set(runners.flatMap((runner) => runner.eventTypes ?? Object.keys(runner.handlers ?? {})))].sort();
}

/**
 * Whether the deployment quiesce confirmed that no platform worker pod remained before it started the
 * bootstrap. The quiesce lists the deployments it confirmed, each named `<release>-platform-worker`.
 */
export function quiescedDeploymentsIncludePlatformWorker(quiescedDeployments: string | undefined): boolean {
  return (quiescedDeployments ?? "")
    .split(",")
    .map((name) => name.trim())
    .some((name) => name === PLATFORM_WORKER_KIND || name.endsWith(`-${PLATFORM_WORKER_KIND}`));
}

export type EventConsumerReadinessRequirement = Readonly<{
  /** A running worker reading this event type hosts a consumer that must also read every required type. */
  anchorEventType: string;
  requiredEventTypes: readonly string[];
}>;

export type EventConsumerReadiness =
  | Readonly<{ ready: true }>
  | Readonly<{
      ready: false;
      reason: "workers_not_quiesced" | "retired_worker_holds_lease" | "worker_without_capability" | "no_capable_worker";
      workerIds: readonly string[];
    }>;

/**
 * Producer admission for event types added to existing subscriptions. An old worker filters the new
 * types out and can checkpoint past them. A stale heartbeat does not retire it, because the process can
 * keep renewing its leases, so only the deployment quiesce does: it confirms that no worker pod remains
 * before it records the quiesce. A producer stays closed until a quiesce is recorded, no worker started
 * before it still owns a lease, every worker that can still be running reads the required types whatever
 * its heartbeat age, and one of those workers is active. A heartbeat without the capability key comes from
 * a build that predates it.
 */
export function assessEventConsumerReadiness(
  snapshot: WorkerQuiesceCohortSnapshot,
  requirement: EventConsumerReadinessRequirement,
): EventConsumerReadiness {
  if (snapshot.quiescedAt === null) return { ready: false, reason: "workers_not_quiesced", workerIds: [] };
  const quiescedAtMs = Date.parse(snapshot.quiescedAt);
  const snapshotAtMs = Date.parse(snapshot.snapshotAt);
  // Retired means started and last heartbeated strictly before the quiesce; an unreadable time keeps a worker running.
  const before = (value: unknown) => Date.parse(String(value)) < quiescedAtMs;
  const retiredWorkerIds = new Set<string>();
  const running = snapshot.workers.flatMap((worker) => {
    const workerId = String(worker.worker_id);
    if (before(worker.started_at) && before(worker.heartbeat_at)) {
      retiredWorkerIds.add(workerId);
      return [];
    }
    const metadata = worker.metadata as Record<string, unknown> | null | undefined;
    const consumed = metadata?.[WORKER_CONSUMED_EVENT_TYPES_METADATA_KEY];
    return [
      {
        workerId,
        active: snapshotAtMs - Date.parse(String(worker.heartbeat_at)) <= ACTIVE_WORKER_HEARTBEAT_MAX_AGE_MS,
        consumed: Array.isArray(consumed) ? new Set(consumed.filter((type) => typeof type === "string")) : null,
      },
    ];
  });
  const leaseHolders = [...new Set(snapshot.leaseOwnerIds.filter((ownerId) => retiredWorkerIds.has(ownerId)))];
  if (leaseHolders.length > 0) return { ready: false, reason: "retired_worker_holds_lease", workerIds: leaseHolders };
  const readsAll = (consumed: ReadonlySet<string>) =>
    requirement.requiredEventTypes.every((eventType) => consumed.has(eventType));
  const incapable = running.filter(
    (worker) =>
      worker.consumed === null || (worker.consumed.has(requirement.anchorEventType) && !readsAll(worker.consumed)),
  );
  if (incapable.length > 0)
    return { ready: false, reason: "worker_without_capability", workerIds: incapable.map((worker) => worker.workerId) };
  const capable = running.some(
    (worker) => worker.active && worker.consumed?.has(requirement.anchorEventType) && readsAll(worker.consumed),
  );
  return capable ? { ready: true } : { ready: false, reason: "no_capable_worker", workerIds: [] };
}

export type EventConsumerAdmissionDecision =
  | Readonly<{ admitted: true }>
  | Readonly<{
      admitted: false;
      reason:
        | "switch_closed"
        | "control_plane_unavailable"
        | Extract<EventConsumerReadiness, { ready: false }>["reason"];
      workerIds?: readonly string[];
    }>;

/**
 * A default-closed producer admission: the operator switch opens it only once the platform workers that
 * can still be running read the required event types. The decision is read per call, so a returning old
 * worker closes it again.
 */
export function createEventConsumerAdmission(
  input: Readonly<{
    open: boolean;
    /** The control-plane database that holds worker heartbeats, leases and quiesces. */
    db?: PgQueryable;
    requirement: EventConsumerReadinessRequirement;
  }>,
): Readonly<{ check: () => Promise<EventConsumerAdmissionDecision> }> {
  return {
    async check() {
      if (!input.open) return { admitted: false, reason: "switch_closed" };
      if (!input.db) return { admitted: false, reason: "control_plane_unavailable" };
      const readiness = assessEventConsumerReadiness(
        await readWorkerQuiesceCohort(input.db, PLATFORM_WORKER_KIND),
        input.requirement,
      );
      return readiness.ready
        ? { admitted: true }
        : { admitted: false, reason: readiness.reason, workerIds: readiness.workerIds };
    },
  };
}
