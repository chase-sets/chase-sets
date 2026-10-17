import type { BcRetentionSweep } from "@chase-sets/bounded-context-module";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PlatformControlPlane } from "./control-plane";
import type { WorkerHostRuntime, WorkerRunner } from "./worker";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

export const RETENTION_SWEEP_RUNNER_NAME = "retention-sweeps";
export const DEFAULT_RETENTION_SWEEP_RUNNER_INTERVAL_MS = HOUR_MS;
export const DEFAULT_RETENTION_SWEEP_MAX_BATCHES_PER_RUN = 10;

export type RetentionSweepTarget = Readonly<{
  contextName: string;
  db: PgQueryable;
  sweep: BcRetentionSweep;
}>;

/**
 * Bounded failure classification. Raw error text, stacks, causes and thrown
 * values never cross this boundary: swept rows can carry ship-to data, and
 * driver errors echo row values in their message and detail.
 */
export type RetentionSweepFailure = Readonly<{
  errorClass: "database-error" | "system-error" | "type-error" | "range-error" | "error" | "non-error";
  errorCode: string | null;
}>;

export type RetentionSweepFailedEvent = Readonly<{
  contextName: string;
  sweepName: string;
  tableName: string;
  failure: RetentionSweepFailure;
}>;

export type RetentionSweepObserver = Readonly<{
  sweepCompleted?: (event: Readonly<{ contextName: string; sweepName: string; deleted: number }>) => void;
  sweepFailed?: (event: RetentionSweepFailedEvent) => void;
}>;

export type RetentionSweepLogger = Readonly<{
  info: (message: string, fields?: Readonly<Record<string, unknown>>) => void;
  error: (message: string, fields?: Readonly<Record<string, unknown>>) => void;
}>;

export const sharedEventStoreRetentionSweeps: readonly BcRetentionSweep[] = [
  {
    name: "resolved-projection-poison-events",
    tableName: "event_projection_poison_events",
    predicateSql: "candidate.state IN ('resolved', 'ignored') AND candidate.resolved_at < now() - interval '30 days'",
    orderBySql: "candidate.resolved_at ASC",
    intervalMs: 6 * HOUR_MS,
    batchLimit: 500,
  },
  {
    name: "resolved-projection-blocked-streams",
    tableName: "event_projection_blocked_streams",
    predicateSql: "candidate.state = 'resolved' AND candidate.updated_at < now() - interval '30 days'",
    orderBySql: "candidate.updated_at ASC",
    intervalMs: 6 * HOUR_MS,
    batchLimit: 500,
  },
];

export const sharedNotificationOutboxRetentionSweep: BcRetentionSweep = {
  name: "terminal-notification-outbox",
  tableName: "notification_outbox",
  predicateSql: "candidate.status IN ('sent', 'failed') AND candidate.updated_at < now() - interval '30 days'",
  orderBySql: "candidate.updated_at ASC, candidate.outbox_id ASC",
  intervalMs: 6 * HOUR_MS,
  batchLimit: 500,
};

export const platformControlRetentionSweeps: readonly BcRetentionSweep[] = [
  {
    name: "expired-worker-heartbeats",
    tableName: "platform_worker_heartbeats",
    predicateSql: "candidate.heartbeat_at < now() - interval '7 days'",
    orderBySql: "candidate.heartbeat_at ASC, candidate.worker_id ASC",
    intervalMs: 6 * HOUR_MS,
    batchLimit: 500,
  },
  {
    name: "terminal-projection-operations",
    tableName: "platform_projection_operations",
    predicateSql: `candidate.state IN ('succeeded', 'failed', 'cancelled')
      AND candidate.completed_at < now() - interval '90 days'`,
    orderBySql: "candidate.completed_at ASC",
    intervalMs: 6 * HOUR_MS,
    batchLimit: 500,
  },
  {
    name: "terminal-projection-operation-events",
    tableName: "platform_projection_operation_events",
    predicateSql: `candidate.created_at < now() - interval '30 days'
      AND EXISTS (
        SELECT 1
        FROM platform_projection_operations AS operation
        WHERE operation.operation_id = candidate.operation_id
          AND operation.state IN ('succeeded', 'failed', 'cancelled')
          AND operation.completed_at < now() - interval '30 days'
      )`,
    orderBySql: "candidate.created_at ASC",
    intervalMs: 6 * HOUR_MS,
    batchLimit: 500,
  },
  {
    name: "stale-projection-status-snapshots",
    tableName: "platform_projection_status_snapshots",
    predicateSql: "candidate.updated_at < now() - interval '7 days'",
    orderBySql: "candidate.updated_at ASC",
    intervalMs: DAY_MS,
    batchLimit: 500,
  },
];

export function collectRetentionSweepTargets(
  runtime: WorkerHostRuntime,
  platformControlDb: PgQueryable,
): readonly RetentionSweepTarget[] {
  const targets = runtime.mountedContexts.flatMap((context) => {
    const sweeps = [...(context.module.retentionSweeps ?? [])];
    if (context.module.schemaSql.includes("CREATE TABLE IF NOT EXISTS event_projection_poison_events")) {
      sweeps.push(...sharedEventStoreRetentionSweeps);
    }
    if (context.module.schemaSql.includes("CREATE TABLE IF NOT EXISTS notification_outbox")) {
      sweeps.push(sharedNotificationOutboxRetentionSweep);
    }

    return sweeps.map((sweep) => ({ contextName: context.contextName, db: context.pool, sweep }));
  });

  return [
    ...targets,
    ...platformControlRetentionSweeps.map((sweep) => ({
      contextName: "platform-control",
      db: platformControlDb,
      sweep,
    })),
  ];
}

export function createRetentionSweepRunner(
  input: Readonly<{
    controlPlane: Pick<PlatformControlPlane, "claimScheduledRunner" | "recordScheduledRunnerCompleted">;
    targets: readonly RetentionSweepTarget[];
    intervalMs?: number;
    maxBatchesPerRun?: number;
    observer?: RetentionSweepObserver;
  }>,
): WorkerRunner {
  const intervalMs = Math.max(1_000, Math.floor(input.intervalMs ?? DEFAULT_RETENTION_SWEEP_RUNNER_INTERVAL_MS));
  const maxBatchesPerRun = Math.max(
    1,
    Math.floor(input.maxBatchesPerRun ?? DEFAULT_RETENTION_SWEEP_MAX_BATCHES_PER_RUN),
  );

  return {
    name: RETENTION_SWEEP_RUNNER_NAME,
    kind: "job",
    runOnce: async () => {
      const claimed = await input.controlPlane.claimScheduledRunner({
        runnerName: RETENTION_SWEEP_RUNNER_NAME,
        intervalMs,
      });
      if (!claimed) {
        return { processed: 0, lastGlobalPosition: ZERO_GLOBAL_POSITION, state: "caught-up" };
      }

      let processed = 0;
      for (const target of input.targets) {
        const scheduledRunnerName = retentionScheduledRunnerName(target);
        try {
          const sweepClaimed = await input.controlPlane.claimScheduledRunner({
            runnerName: scheduledRunnerName,
            intervalMs: target.sweep.intervalMs,
          });
          if (!sweepClaimed) {
            continue;
          }

          let deleted = 0;
          for (let batch = 0; batch < maxBatchesPerRun; batch += 1) {
            const batchDeleted = await executeRetentionSweepBatch(target.db, target.sweep);
            deleted += batchDeleted;
            if (batchDeleted < target.sweep.batchLimit) {
              break;
            }
          }

          processed += deleted;
          await input.controlPlane.recordScheduledRunnerCompleted({ runnerName: scheduledRunnerName });
          input.observer?.sweepCompleted?.({
            contextName: target.contextName,
            sweepName: target.sweep.name,
            deleted,
          });
        } catch (error) {
          // Retention is best-effort background maintenance. The scheduled
          // claim already advances the next attempt, so observe this failure,
          // continue other tables, and retry this sweep on its next interval.
          input.observer?.sweepFailed?.({
            contextName: safeRetentionName(target.contextName),
            sweepName: safeRetentionName(target.sweep.name),
            tableName: safeRetentionName(target.sweep.tableName),
            failure: classifyRetentionSweepFailure(error),
          });
        }
      }

      await input.controlPlane.recordScheduledRunnerCompleted({ runnerName: RETENTION_SWEEP_RUNNER_NAME });
      return { processed, lastGlobalPosition: ZERO_GLOBAL_POSITION, state: "caught-up" };
    },
  };
}

export function createRetentionSweepLogObserver(logger: RetentionSweepLogger): RetentionSweepObserver {
  return {
    sweepCompleted: (event) => {
      if (event.deleted > 0) {
        logger.info("Retention sweep completed.", {
          type: "retention.sweep.completed",
          contextName: safeRetentionName(event.contextName),
          sweepName: safeRetentionName(event.sweepName),
          deleted: event.deleted,
        });
      }
    },
    sweepFailed: (event) =>
      logger.error("Retention sweep failed; it will retry on its next interval.", {
        type: "retention.sweep.failed",
        contextName: safeRetentionName(event.contextName),
        sweepName: safeRetentionName(event.sweepName),
        tableName: safeRetentionName(event.tableName),
        errorClass: event.failure.errorClass,
        errorCode: isLoggableFailureCode(event.failure.errorCode) ? event.failure.errorCode : null,
      }),
  };
}

export function classifyRetentionSweepFailure(error: unknown): RetentionSweepFailure {
  try {
    return error instanceof Error ? classifyError(error) : { errorClass: "non-error", errorCode: null };
  } catch {
    // A hostile getter or proxy trap must not turn an isolated sweep failure into a runner failure.
    return { errorClass: "error", errorCode: null };
  }
}

// Diagnostic codes are admitted by explicit membership only: a code that merely
// looks like a SQLSTATE or errno can still carry payload bytes, so it logs as null.
const LOGGABLE_SQLSTATE_CODES: ReadonlySet<string> = new Set([
  "08000",
  "08001",
  "08003",
  "08006",
  "22P02",
  "23505",
  "25P02",
  "40001",
  "40P01",
  "42501",
  "42P01",
  "53100",
  "53200",
  "53300",
  "55P03",
  "57014",
  "57P01",
  "57P02",
  "57P03",
  "XX000",
]);
const LOGGABLE_ERRNO_CODES: ReadonlySet<string> = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
]);

function admittedCode(code: unknown, admitted: ReadonlySet<string>): string | null {
  return typeof code === "string" && admitted.has(code) ? code : null;
}

function isLoggableFailureCode(code: string | null): code is string {
  return code !== null && (LOGGABLE_SQLSTATE_CODES.has(code) || LOGGABLE_ERRNO_CODES.has(code));
}

function classifyError(error: Error): RetentionSweepFailure {
  const code = (error as { code?: unknown }).code;
  // pg's DatabaseError carries the server SQLSTATE; Node system errors carry an errno code.
  if (error.constructor.name === "DatabaseError") {
    return { errorClass: "database-error", errorCode: admittedCode(code, LOGGABLE_SQLSTATE_CODES) };
  }
  if (typeof (error as { errno?: unknown }).errno === "number") {
    return { errorClass: "system-error", errorCode: admittedCode(code, LOGGABLE_ERRNO_CODES) };
  }
  if (error instanceof TypeError) return { errorClass: "type-error", errorCode: null };
  if (error instanceof RangeError) return { errorClass: "range-error", errorCode: null };
  return { errorClass: "error", errorCode: null };
}

function safeRetentionName(value: string): string {
  return /^[a-z][a-z0-9._-]{0,127}$/.test(value) ? value : "invalid-name";
}

export async function executeRetentionSweepBatch(db: PgQueryable, sweep: BcRetentionSweep): Promise<number> {
  const tableName = assertSqlIdentifier(sweep.tableName, "tableName");
  const predicateSql = assertTrustedSqlFragment(sweep.predicateSql, "predicateSql");
  const orderBySql = assertTrustedSqlFragment(sweep.orderBySql, "orderBySql");
  const batchLimit = Math.max(1, Math.floor(sweep.batchLimit));
  const result = await db.query(
    `WITH sweep_lock AS (
       SELECT pg_try_advisory_xact_lock(hashtextextended($2::text, 0)) AS acquired
     ),
     candidates AS (
       SELECT candidate.ctid
       FROM ${tableName} AS candidate
       WHERE (SELECT acquired FROM sweep_lock)
         AND (${predicateSql})
       ORDER BY ${orderBySql}
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     DELETE FROM ${tableName} AS retained
     USING candidates
     WHERE retained.ctid = candidates.ctid`,
    [batchLimit, `retention:${tableName}:${sweep.name}`],
  );

  return Number(result.rowCount ?? 0);
}

function retentionScheduledRunnerName(target: RetentionSweepTarget): string {
  return `retention.${target.contextName}.${target.sweep.name}`;
}

function assertSqlIdentifier(value: string, fieldName: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) {
    throw new Error(`Retention sweep ${fieldName} '${value}' is not a safe SQL identifier.`);
  }
  return value;
}

function assertTrustedSqlFragment(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!normalized || /;|--|\/\*|\$\d+/.test(normalized)) {
    throw new Error(`Retention sweep ${fieldName} must be one trusted, parameter-free SQL fragment.`);
  }
  return normalized;
}
