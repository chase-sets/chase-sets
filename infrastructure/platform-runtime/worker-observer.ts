import type {
  WorkerHolderLifecycleEvent,
  WorkerRuntimeObserver,
  WorkerRunnerCompletedEvent,
  WorkerRunnerFailedEvent,
  WorkerLeaseEvent,
  WorkerProjectionOperationEvent,
} from "./worker";

export type WorkerObserverLogger = Readonly<{
  debug: (message: string, fields?: Readonly<Record<string, unknown>>) => void;
  info: (message: string, fields?: Readonly<Record<string, unknown>>) => void;
  warn: (message: string, fields?: Readonly<Record<string, unknown>>) => void;
  error: (message: string, fields?: Readonly<Record<string, unknown>>) => void;
}>;

export function createWorkerObserver(
  logger: WorkerObserverLogger,
  workerKind: string,
  runnerGroup?: string,
  observeProjectionStatus?: WorkerRuntimeObserver["projectionStatusObserved"],
): WorkerRuntimeObserver {
  const fields = (event: object): Readonly<Record<string, unknown>> => ({
    workerKind,
    runnerGroup,
    ...event,
  });

  return {
    projectionStatusObserved: observeProjectionStatus,
    leaseMissed: (event: WorkerLeaseEvent) =>
      logger.debug("Worker runner lease missed.", {
        type: "worker.runner.lease_missed",
        ...fields(event),
      }),
    leaseRenewFailed: (event: WorkerLeaseEvent & Readonly<{ error?: unknown }>) =>
      logger.warn("Worker runner lease renewal failed.", {
        type: "worker.runner.lease_renew_failed",
        ...fields(event),
      }),
    runnerCompleted: (event: WorkerRunnerCompletedEvent) => {
      const log = event.processed > 0 || event.state === "degraded" ? logger.info : logger.debug;
      log("Worker runner completed.", {
        type: "worker.runner.completed",
        ...fields(event),
      });
    },
    runnerFailed: (event: WorkerRunnerFailedEvent) =>
      logger.error("Worker runner failed.", {
        type: "worker.runner.failed",
        ...fields(event),
      }),
    holderLifecycle: (event: WorkerHolderLifecycleEvent) => {
      const lifecycle = holderLifecycleFields(event);
      if (!lifecycle || !isIdentity(workerKind) || (runnerGroup !== undefined && !isIdentity(runnerGroup))) {
        return;
      }
      logger.info("Worker runner holder lifecycle.", {
        type: "worker.runner.holder_lifecycle",
        workerKind,
        runnerGroup,
        ...lifecycle,
      });
    },
    projectionOperationStarted: (event: WorkerProjectionOperationEvent) =>
      logger.info("Projection operation started.", {
        type: "projection.operation.started",
        ...fields(event),
      }),
    projectionOperationCompleted: (event: WorkerProjectionOperationEvent) =>
      logger.info("Projection operation completed.", {
        type: "projection.operation.completed",
        ...fields(event),
      }),
    projectionOperationFailed: (event: WorkerProjectionOperationEvent & Readonly<{ error: unknown }>) =>
      logger.error("Projection operation failed.", {
        type: "projection.operation.failed",
        ...fields(event),
      }),
  };
}

function isIdentity(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9._:-]{1,200}$/.test(value);
}

function holderLifecycleFields(event: WorkerHolderLifecycleEvent): Readonly<Record<string, unknown>> | null {
  if (
    !event ||
    !isIdentity(event.workerId) ||
    !isIdentity(event.runnerName) ||
    typeof event.leaseIntervalId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(event.leaseIntervalId) ||
    typeof event.timestamp !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(event.timestamp) ||
    !Number.isFinite(Date.parse(event.timestamp)) ||
    new Date(event.timestamp).toISOString() !== event.timestamp ||
    !Number.isFinite(event.elapsedMs) ||
    event.elapsedMs < 0
  ) {
    return null;
  }
  const common = {
    workerId: event.workerId,
    runnerName: event.runnerName,
    leaseIntervalId: event.leaseIntervalId,
    timestamp: event.timestamp,
    elapsedMs: event.elapsedMs,
    phase: event.phase,
  };
  switch (event.phase) {
    case "acquired":
      return common;
    case "lost":
      return event.reason === "renewal-loss" ? { ...common, reason: event.reason } : null;
    case "released":
    case "release-failed":
      return ["idle", "stop", "renewal-loss"].includes(event.reason) ? { ...common, reason: event.reason } : null;
    case "pass-start":
    case "run-start":
    case "run-end":
    case "pass-end": {
      if (!Number.isSafeInteger(event.passSeq) || event.passSeq <= 0) {
        return null;
      }
      const pass = { ...common, passSeq: event.passSeq };
      if (event.phase === "pass-start" || event.phase === "run-start") {
        return pass;
      }
      if (!["success", "error", "cancelled", "lease-lost"].includes(event.outcome)) {
        return null;
      }
      const end = { ...pass, outcome: event.outcome };
      if (event.phase === "run-end") {
        return end;
      }
      if (
        !["retained", "release-pending", "lost"].includes(event.disposition) ||
        (event.processed !== undefined && (!Number.isSafeInteger(event.processed) || event.processed < 0))
      ) {
        return null;
      }
      return {
        ...end,
        disposition: event.disposition,
        ...(event.processed === undefined ? {} : { processed: event.processed }),
      };
    }
    default:
      return null;
  }
}
