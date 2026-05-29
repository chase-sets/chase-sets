import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { platformUcpRuntimeSchemaSql } from "./ucp";

const DEFAULT_PROJECTION_OPERATION_LIMIT = 50;
const PROJECTION_OPERATION_NOTIFY_CHANNEL = "platform_projection_operation_events";

export const platformControlPlaneSchemaSql = `
CREATE TABLE IF NOT EXISTS platform_control_leases (
  lease_name text PRIMARY KEY,
  owner_id text NOT NULL,
  fencing_token bigint NOT NULL CHECK (fencing_token >= 1),
  expires_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  acquired_at timestamptz NOT NULL,
  renewed_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS platform_control_leases_expires_at_idx
  ON platform_control_leases (expires_at);

CREATE TABLE IF NOT EXISTS platform_control_lease_fencing_tokens (
  lease_name text PRIMARY KEY,
  fencing_token bigint NOT NULL CHECK (fencing_token >= 1),
  updated_at timestamptz NOT NULL
);

INSERT INTO platform_control_lease_fencing_tokens (
  lease_name,
  fencing_token,
  updated_at
)
SELECT lease_name, fencing_token, now()
FROM platform_control_leases
ON CONFLICT (lease_name)
DO UPDATE SET
  fencing_token = GREATEST(
    platform_control_lease_fencing_tokens.fencing_token,
    EXCLUDED.fencing_token
  ),
  updated_at = now();

CREATE TABLE IF NOT EXISTS platform_worker_heartbeats (
  worker_id text PRIMARY KEY,
  worker_kind text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_runner_statuses (
  runner_name text PRIMARY KEY,
  runner_kind text NOT NULL,
  owner_id text,
  fencing_token bigint,
  state text NOT NULL,
  last_processed integer NOT NULL DEFAULT 0,
  last_error text,
  last_ran_at timestamptz,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_projection_status_snapshots (
  projection_key text PRIMARY KEY,
  target_context_name text NOT NULL,
  projection_name text NOT NULL,
  runner_name text NOT NULL,
  owner_id text NOT NULL,
  fencing_token bigint,
  status jsonb NOT NULL,
  updated_at timestamptz NOT NULL
);

ALTER TABLE platform_projection_status_snapshots
  ADD COLUMN IF NOT EXISTS fencing_token bigint;

CREATE INDEX IF NOT EXISTS platform_projection_status_snapshots_updated_at_idx
  ON platform_projection_status_snapshots (updated_at DESC);

INSERT INTO platform_control_lease_fencing_tokens (
  lease_name,
  fencing_token,
  updated_at
)
SELECT seed.lease_name, max(seed.fencing_token), now()
FROM (
  SELECT runner_kind || ':' || runner_name AS lease_name, fencing_token
  FROM platform_runner_statuses
  WHERE fencing_token IS NOT NULL
  UNION ALL
  SELECT 'projection-group:' || runner_name AS lease_name, fencing_token
  FROM platform_projection_status_snapshots
  WHERE fencing_token IS NOT NULL
) AS seed
GROUP BY seed.lease_name
ON CONFLICT (lease_name)
DO UPDATE SET
  fencing_token = GREATEST(
    platform_control_lease_fencing_tokens.fencing_token,
    EXCLUDED.fencing_token
  ),
  updated_at = now();

CREATE TABLE IF NOT EXISTS platform_projection_operations (
  operation_id text PRIMARY KEY,
  operation_kind text NOT NULL CHECK (
    operation_kind IN ('rebuild-projection-group', 'rebuild-context', 'retry-blocked-stream', 'replay-stream')
  ),
  state text NOT NULL CHECK (
    state IN ('queued', 'running', 'succeeded', 'failed', 'cancel_requested', 'cancelled')
  ),
  context_name text NOT NULL,
  projection_name text NULL,
  projection_key text NULL,
  stream_id text NULL,
  requested_by_user_id text NULL,
  requested_by_account_id text NULL,
  claim_owner_id text NULL,
  claim_fencing_token bigint NULL,
  claimed_until timestamptz NULL,
  event_sequence integer NOT NULL DEFAULT 0 CHECK (event_sequence >= 0),
  progress jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb NULL,
  error jsonb NULL,
  requested_at timestamptz NOT NULL,
  started_at timestamptz NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS platform_projection_operations_state_requested_idx
  ON platform_projection_operations (state, requested_at ASC);

CREATE INDEX IF NOT EXISTS platform_projection_operations_target_idx
  ON platform_projection_operations (context_name, projection_name, requested_at DESC);

CREATE INDEX IF NOT EXISTS platform_projection_operations_actor_requested_idx
  ON platform_projection_operations (requested_by_user_id, requested_at DESC);

ALTER TABLE platform_projection_operations
  ADD COLUMN IF NOT EXISTS event_sequence integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS platform_projection_operation_events (
  operation_id text NOT NULL REFERENCES platform_projection_operations(operation_id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence >= 1),
  event_name text NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (operation_id, sequence)
);

CREATE INDEX IF NOT EXISTS platform_projection_operation_events_lookup_idx
  ON platform_projection_operation_events (operation_id, sequence);

CREATE TABLE IF NOT EXISTS platform_realtime_stream_leases (
  lease_id text PRIMARY KEY,
  connection_key text NOT NULL,
  expires_at timestamptz NOT NULL,
  acquired_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS platform_realtime_stream_leases_connection_key_idx
  ON platform_realtime_stream_leases (connection_key);

CREATE INDEX IF NOT EXISTS platform_realtime_stream_leases_expires_at_idx
  ON platform_realtime_stream_leases (expires_at);

CREATE INDEX IF NOT EXISTS platform_realtime_stream_leases_connection_expires_idx
  ON platform_realtime_stream_leases (connection_key, expires_at);

CREATE TABLE IF NOT EXISTS platform_realtime_stream_counters (
  counter_key text PRIMARY KEY,
  active_count integer NOT NULL DEFAULT 0 CHECK (active_count >= 0),
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_scheduled_runners (
  runner_name text PRIMARY KEY,
  interval_ms integer NOT NULL CHECK (interval_ms > 0),
  next_run_at timestamptz NOT NULL,
  last_started_at timestamptz NULL,
  last_completed_at timestamptz NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS platform_scheduled_runners_next_run_idx
  ON platform_scheduled_runners (next_run_at);

${platformUcpRuntimeSchemaSql}
`;

export type PlatformLease = Readonly<{
  leaseName: string;
  ownerId: string;
  fencingToken: string;
  expiresAt: string;
}>;

export type ProjectionOperationKind =
  | "rebuild-projection-group"
  | "rebuild-context"
  | "retry-blocked-stream"
  | "replay-stream";

export type ProjectionOperationState = "queued" | "running" | "succeeded" | "failed" | "cancel_requested" | "cancelled";

export type ProjectionOperationRecord = Readonly<{
  operationId: string;
  operationKind: ProjectionOperationKind;
  state: ProjectionOperationState;
  contextName: string;
  projectionName: string | null;
  projectionKey: string | null;
  streamId: string | null;
  requestedByUserId: string | null;
  requestedByAccountId: string | null;
  claimOwnerId: string | null;
  claimFencingToken: string | null;
  claimedUntil: string | null;
  progress: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  requestedAt: string;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
}>;

export type ProjectionOperationEvent = Readonly<{
  sequence: number;
  eventName: "status";
  operation: ProjectionOperationRecord;
  createdAt: string;
}>;

export type ProjectionOperationListFilter = Readonly<{
  limit?: number;
  contextName?: string;
  projectionName?: string;
  state?: ProjectionOperationState;
  requestedByUserId?: string;
}>;

export type ProjectionOperationSummary = Readonly<{
  queuedCount: string;
  runningCount: string;
  failedCount: string;
  cancelRequestedCount: string;
  oldestQueuedAt: string | null;
  oldestRunningAt: string | null;
  averageDurationMs: string | null;
}>;

export type PlatformControlPlane = Readonly<{
  bootstrap: () => Promise<void>;
  acquireLease: (
    input: Readonly<{
      leaseName: string;
      ownerId: string;
      ttlMs: number;
      metadata?: Record<string, unknown>;
    }>,
  ) => Promise<PlatformLease | null>;
  renewLease: (lease: PlatformLease, ttlMs: number) => Promise<boolean>;
  releaseLease: (lease: PlatformLease) => Promise<void>;
  heartbeatWorker: (
    input: Readonly<{
      workerId: string;
      workerKind: string;
      metadata?: Record<string, unknown>;
    }>,
  ) => Promise<void>;
  recordRunnerStatus: (
    input: Readonly<{
      runnerName: string;
      runnerKind: string;
      state: "idle" | "running" | "caught-up" | "degraded" | "error" | "skipped";
      ownerId?: string;
      fencingToken?: string;
      lastProcessed?: number;
      lastError?: string | null;
    }>,
  ) => Promise<void>;
  recordProjectionStatusSnapshot: (
    input: Readonly<{
      projectionKey: string;
      targetContextName: string;
      projectionName: string;
      runnerName: string;
      ownerId: string;
      fencingToken?: string;
      status: Record<string, unknown>;
    }>,
  ) => Promise<void>;
  listProjectionStatusSnapshots: () => Promise<readonly Record<string, unknown>[]>;
  listWorkerHeartbeats: () => Promise<readonly Record<string, unknown>[]>;
  listRunnerStatuses: () => Promise<readonly Record<string, unknown>[]>;
  listLeases: () => Promise<readonly Record<string, unknown>[]>;
  enqueueProjectionOperation: (
    input: Readonly<{
      operationKind: ProjectionOperationKind;
      contextName: string;
      projectionName?: string | null;
      projectionKey?: string | null;
      streamId?: string | null;
      requestedByUserId?: string | null;
      requestedByAccountId?: string | null;
      progress?: Record<string, unknown>;
    }>,
  ) => Promise<ProjectionOperationRecord>;
  claimProjectionOperation: (
    input: Readonly<{
      ownerId: string;
      claimTtlMs: number;
      operationKinds?: readonly ProjectionOperationKind[];
    }>,
  ) => Promise<ProjectionOperationRecord | null>;
  recordProjectionOperationProgress: (
    input: Readonly<{
      operationId: string;
      ownerId: string;
      fencingToken: string;
      claimTtlMs: number;
      progress: Record<string, unknown>;
    }>,
  ) => Promise<boolean>;
  completeProjectionOperation: (
    input: Readonly<{
      operationId: string;
      ownerId: string;
      fencingToken: string;
      result?: Record<string, unknown>;
    }>,
  ) => Promise<boolean>;
  failProjectionOperation: (
    input: Readonly<{
      operationId: string;
      ownerId: string;
      fencingToken: string;
      error: Record<string, unknown>;
      retryable?: boolean;
    }>,
  ) => Promise<boolean>;
  cancelProjectionOperation: (
    input: Readonly<{
      operationId: string;
      requestedByUserId?: string | null;
    }>,
  ) => Promise<boolean>;
  getProjectionOperation: (operationId: string) => Promise<ProjectionOperationRecord | null>;
  listProjectionOperationEvents: (
    operationId: string,
    afterSequence?: number,
  ) => Promise<readonly ProjectionOperationEvent[]>;
  waitForProjectionOperationEvents: (
    input: Readonly<{ operationId: string; signal?: AbortSignal; timeoutMs?: number }>,
  ) => Promise<void>;
  listProjectionOperations: (input?: ProjectionOperationListFilter) => Promise<readonly ProjectionOperationRecord[]>;
  summarizeProjectionOperations: (
    input?: Omit<ProjectionOperationListFilter, "limit">,
  ) => Promise<ProjectionOperationSummary>;
  claimScheduledRunner: (
    input: Readonly<{
      runnerName: string;
      intervalMs: number;
    }>,
  ) => Promise<boolean>;
  recordScheduledRunnerCompleted: (input: Readonly<{ runnerName: string }>) => Promise<void>;
}>;

type LeaseRow = Readonly<{
  lease_name: string;
  owner_id: string;
  fencing_token: string | number | bigint;
  expires_at: Date | string;
}>;

type ProjectionOperationRow = Readonly<{
  operation_id: string;
  operation_kind: ProjectionOperationKind;
  state: ProjectionOperationState;
  context_name: string;
  projection_name: string | null;
  projection_key: string | null;
  stream_id: string | null;
  requested_by_user_id: string | null;
  requested_by_account_id: string | null;
  claim_owner_id: string | null;
  claim_fencing_token: string | number | bigint | null;
  claimed_until: Date | string | null;
  progress: unknown;
  result: unknown;
  error: unknown;
  requested_at: Date | string;
  started_at: Date | string | null;
  updated_at: Date | string;
  completed_at: Date | string | null;
}>;

type ProjectionOperationEventRow = Readonly<{
  sequence: number | string;
  event_name: "status";
  snapshot: unknown;
  created_at: Date | string;
}>;

export async function bootstrapPlatformControlPlane(db: PgQueryable): Promise<void> {
  await db.query(platformControlPlaneSchemaSql);
}

export function createPostgresPlatformControlPlane(db: PgTransactionalPool): PlatformControlPlane {
  const projectionOperationWaiter = createProjectionOperationNotificationWaiter(db);

  return {
    bootstrap: () => bootstrapPlatformControlPlane(db),
    acquireLease: async (input) => {
      const result = await db.query<LeaseRow>(
        `WITH claimable AS (
           SELECT $1::text AS lease_name
           WHERE NOT EXISTS (
             SELECT 1
             FROM platform_control_leases
             WHERE lease_name = $1
           )
           UNION ALL
           SELECT lease_name
           FROM platform_control_leases
           WHERE lease_name = $1
             AND (
               expires_at <= now()
               OR owner_id = $2
             )
         ),
         next_token AS (
           INSERT INTO platform_control_lease_fencing_tokens (
             lease_name,
             fencing_token,
             updated_at
           )
           SELECT lease_name, 1, now()
           FROM claimable
           ON CONFLICT (lease_name)
           DO UPDATE SET
             fencing_token = platform_control_lease_fencing_tokens.fencing_token + 1,
             updated_at = now()
           RETURNING lease_name, fencing_token
         )
         INSERT INTO platform_control_leases (
           lease_name,
           owner_id,
           fencing_token,
           expires_at,
           metadata,
           acquired_at,
           renewed_at
         )
         SELECT
           $1,
           $2,
           next_token.fencing_token,
           now() + ($3::text || ' milliseconds')::interval,
           $4::jsonb,
           now(),
           now()
         FROM next_token
         ON CONFLICT (lease_name)
         DO UPDATE SET
           owner_id = EXCLUDED.owner_id,
           fencing_token = EXCLUDED.fencing_token,
           expires_at = EXCLUDED.expires_at,
           metadata = EXCLUDED.metadata,
           acquired_at = now(),
           renewed_at = now()
         WHERE platform_control_leases.expires_at <= now()
            OR platform_control_leases.owner_id = EXCLUDED.owner_id
         RETURNING lease_name, owner_id, fencing_token, expires_at`,
        [input.leaseName, input.ownerId, input.ttlMs, JSON.stringify(input.metadata ?? {})],
      );

      return result.rows[0] ? mapLeaseRow(result.rows[0]) : null;
    },
    renewLease: async (lease, ttlMs) => {
      const result = await db.query(
        `UPDATE platform_control_leases
         SET expires_at = now() + ($4::text || ' milliseconds')::interval,
             renewed_at = now()
         WHERE lease_name = $1
           AND owner_id = $2
           AND fencing_token = $3::bigint
           AND expires_at > now()`,
        [lease.leaseName, lease.ownerId, lease.fencingToken, ttlMs],
      );
      return (result.rowCount ?? 0) > 0;
    },
    releaseLease: async (lease) => {
      await db.query(
        `DELETE FROM platform_control_leases
         WHERE lease_name = $1
           AND owner_id = $2
           AND fencing_token = $3::bigint`,
        [lease.leaseName, lease.ownerId, lease.fencingToken],
      );
    },
    heartbeatWorker: async (input) => {
      await db.query(
        `INSERT INTO platform_worker_heartbeats (
           worker_id,
           worker_kind,
           metadata,
           started_at,
           heartbeat_at
         ) VALUES ($1, $2, $3::jsonb, now(), now())
         ON CONFLICT (worker_id)
         DO UPDATE SET
           worker_kind = EXCLUDED.worker_kind,
           metadata = EXCLUDED.metadata,
           heartbeat_at = EXCLUDED.heartbeat_at`,
        [input.workerId, input.workerKind, JSON.stringify(input.metadata ?? {})],
      );
    },
    recordRunnerStatus: async (input) => {
      await db.query(
        `INSERT INTO platform_runner_statuses (
           runner_name,
           runner_kind,
           owner_id,
           fencing_token,
           state,
           last_processed,
           last_error,
           last_ran_at,
           updated_at
         ) VALUES ($1, $2, $3, $4::bigint, $5, $6, $7, now(), now())
         ON CONFLICT (runner_name)
         DO UPDATE SET
           runner_kind = EXCLUDED.runner_kind,
           owner_id = EXCLUDED.owner_id,
           fencing_token = EXCLUDED.fencing_token,
           state = EXCLUDED.state,
           last_processed = EXCLUDED.last_processed,
           last_error = EXCLUDED.last_error,
           last_ran_at = EXCLUDED.last_ran_at,
           updated_at = EXCLUDED.updated_at
         WHERE platform_runner_statuses.fencing_token IS NULL
            OR EXCLUDED.fencing_token IS NULL
            OR EXCLUDED.fencing_token >= platform_runner_statuses.fencing_token`,
        [
          input.runnerName,
          input.runnerKind,
          input.ownerId ?? null,
          input.fencingToken ?? null,
          input.state,
          input.lastProcessed ?? 0,
          input.lastError ?? null,
        ],
      );
    },
    recordProjectionStatusSnapshot: async (input) => {
      await db.query(
        `INSERT INTO platform_projection_status_snapshots (
           projection_key,
           target_context_name,
           projection_name,
           runner_name,
           owner_id,
           fencing_token,
           status,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6::bigint, $7::jsonb, now())
         ON CONFLICT (projection_key)
         DO UPDATE SET
           target_context_name = EXCLUDED.target_context_name,
           projection_name = EXCLUDED.projection_name,
           runner_name = EXCLUDED.runner_name,
           owner_id = EXCLUDED.owner_id,
           fencing_token = EXCLUDED.fencing_token,
           status = EXCLUDED.status,
           updated_at = EXCLUDED.updated_at
         WHERE platform_projection_status_snapshots.fencing_token IS NULL
            OR EXCLUDED.fencing_token IS NULL
            OR EXCLUDED.fencing_token >= platform_projection_status_snapshots.fencing_token`,
        [
          input.projectionKey,
          input.targetContextName,
          input.projectionName,
          input.runnerName,
          input.ownerId,
          input.fencingToken ?? null,
          JSON.stringify(input.status),
        ],
      );
    },
    listProjectionStatusSnapshots: async () =>
      (
        await db.query(
          `SELECT projection_key, target_context_name, projection_name,
                runner_name, owner_id, fencing_token, status, updated_at
         FROM platform_projection_status_snapshots
         ORDER BY target_context_name, projection_name`,
        )
      ).rows,
    listWorkerHeartbeats: async () =>
      (
        await db.query(
          `SELECT worker_id, worker_kind, metadata, started_at, heartbeat_at
         FROM platform_worker_heartbeats
         ORDER BY worker_id`,
        )
      ).rows,
    listRunnerStatuses: async () =>
      (
        await db.query(
          `SELECT runner_name, runner_kind, owner_id, fencing_token, state,
                last_processed, last_error, last_ran_at, updated_at
         FROM platform_runner_statuses
         ORDER BY runner_name`,
        )
      ).rows,
    listLeases: async () =>
      (
        await db.query(
          `SELECT lease_name, owner_id, fencing_token, expires_at, metadata,
                acquired_at, renewed_at
         FROM platform_control_leases
         ORDER BY lease_name`,
        )
      ).rows,
    enqueueProjectionOperation: async (input) => {
      return runControlPlaneWrite(db, async (queryable) => {
        const result = await queryable.query<ProjectionOperationRow>(
          `INSERT INTO platform_projection_operations (
           operation_id,
           operation_kind,
           state,
           context_name,
           projection_name,
           projection_key,
           stream_id,
           requested_by_user_id,
           requested_by_account_id,
           progress,
           requested_at,
           updated_at
         ) VALUES ($1, $2, 'queued', $3, $4, $5, $6, $7, $8, $9::jsonb, now(), now())
         RETURNING ${PROJECTION_OPERATION_COLUMNS}`,
          [
            createProjectionOperationId(),
            input.operationKind,
            input.contextName,
            input.projectionName ?? null,
            input.projectionKey ?? null,
            input.streamId ?? null,
            input.requestedByUserId ?? null,
            input.requestedByAccountId ?? null,
            JSON.stringify(input.progress ?? {}),
          ],
        );

        const operation = mapProjectionOperationRow(result.rows[0]);
        await appendProjectionOperationEvent(queryable, operation);

        return operation;
      });
    },
    claimProjectionOperation: async (input) => {
      const operationKinds = input.operationKinds?.length ? [...new Set(input.operationKinds)] : null;
      return runControlPlaneWrite(db, async (queryable) => {
        const result = await queryable.query<ProjectionOperationRow>(
          `WITH claimable AS (
           SELECT operation_id
           FROM platform_projection_operations
           WHERE (
               state = 'queued'
               OR (
                 state = 'running'
                 AND claimed_until <= now()
               )
             )
             AND ($3::text[] IS NULL OR operation_kind = ANY($3::text[]))
           ORDER BY requested_at ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
         UPDATE platform_projection_operations AS operation
         SET state = 'running',
             claim_owner_id = $1,
             claim_fencing_token = COALESCE(operation.claim_fencing_token, 0) + 1,
             claimed_until = now() + ($2::text || ' milliseconds')::interval,
             started_at = COALESCE(operation.started_at, now()),
             updated_at = now()
         FROM claimable
         WHERE operation.operation_id = claimable.operation_id
          RETURNING ${projectionOperationColumns("operation")}`,
          [input.ownerId, input.claimTtlMs, operationKinds],
        );

        if (!result.rows[0]) {
          return null;
        }

        const operation = mapProjectionOperationRow(result.rows[0]);
        await appendProjectionOperationEvent(queryable, operation);

        return operation;
      });
    },
    recordProjectionOperationProgress: async (input) => {
      return runControlPlaneWrite(db, async (queryable) => {
        const result = await queryable.query<ProjectionOperationRow>(
          `UPDATE platform_projection_operations
         SET progress = $4::jsonb,
             claimed_until = now() + ($5::text || ' milliseconds')::interval,
             updated_at = now()
         WHERE operation_id = $1
           AND claim_owner_id = $2
           AND claim_fencing_token = $3::bigint
           AND state IN ('running', 'cancel_requested')
           AND claimed_until > now()
         RETURNING ${PROJECTION_OPERATION_COLUMNS}`,
          [input.operationId, input.ownerId, input.fencingToken, JSON.stringify(input.progress), input.claimTtlMs],
        );
        if (!result.rows[0]) {
          return false;
        }

        await appendProjectionOperationEvent(queryable, mapProjectionOperationRow(result.rows[0]));
        return true;
      });
    },
    completeProjectionOperation: async (input) => {
      return runControlPlaneWrite(db, async (queryable) => {
        const result = await queryable.query<ProjectionOperationRow>(
          `UPDATE platform_projection_operations
         SET state = CASE WHEN state = 'cancel_requested' THEN 'cancelled' ELSE 'succeeded' END,
             result = $4::jsonb,
             error = NULL,
             claimed_until = NULL,
             completed_at = now(),
             updated_at = now()
         WHERE operation_id = $1
           AND claim_owner_id = $2
           AND claim_fencing_token = $3::bigint
           AND state IN ('running', 'cancel_requested')
           AND claimed_until > now()
         RETURNING ${PROJECTION_OPERATION_COLUMNS}`,
          [input.operationId, input.ownerId, input.fencingToken, JSON.stringify(input.result ?? {})],
        );
        if (!result.rows[0]) {
          return false;
        }

        await appendProjectionOperationEvent(queryable, mapProjectionOperationRow(result.rows[0]));
        return true;
      });
    },
    failProjectionOperation: async (input) => {
      return runControlPlaneWrite(db, async (queryable) => {
        const result = await queryable.query<ProjectionOperationRow>(
          `UPDATE platform_projection_operations
         SET state = $4,
             error = $5::jsonb,
             claimed_until = NULL,
             completed_at = CASE WHEN $4 = 'failed' THEN now() ELSE completed_at END,
             updated_at = now()
         WHERE operation_id = $1
           AND claim_owner_id = $2
           AND claim_fencing_token = $3::bigint
           AND state IN ('running', 'cancel_requested')
           AND claimed_until > now()
         RETURNING ${PROJECTION_OPERATION_COLUMNS}`,
          [
            input.operationId,
            input.ownerId,
            input.fencingToken,
            input.retryable ? "queued" : "failed",
            JSON.stringify(input.error),
          ],
        );
        if (!result.rows[0]) {
          return false;
        }

        await appendProjectionOperationEvent(queryable, mapProjectionOperationRow(result.rows[0]));
        return true;
      });
    },
    cancelProjectionOperation: async (input) => {
      return runControlPlaneWrite(db, async (queryable) => {
        const result = await queryable.query<ProjectionOperationRow>(
          `UPDATE platform_projection_operations
         SET state = CASE
               WHEN state = 'queued' THEN 'cancelled'
               WHEN state = 'running' THEN 'cancel_requested'
               ELSE state
             END,
             error = CASE
               WHEN state = 'queued' THEN $2::jsonb
               ELSE error
             END,
             completed_at = CASE
               WHEN state = 'queued' THEN now()
               ELSE completed_at
             END,
             updated_at = now()
         WHERE operation_id = $1
           AND state IN ('queued', 'running')
         RETURNING ${PROJECTION_OPERATION_COLUMNS}`,
          [
            input.operationId,
            JSON.stringify({
              code: "cancel_requested",
              requestedByUserId: input.requestedByUserId ?? null,
            }),
          ],
        );
        if (!result.rows[0]) {
          return false;
        }

        await appendProjectionOperationEvent(queryable, mapProjectionOperationRow(result.rows[0]));
        return true;
      });
    },
    getProjectionOperation: async (operationId) => {
      const result = await db.query<ProjectionOperationRow>(
        `SELECT ${PROJECTION_OPERATION_COLUMNS}
         FROM platform_projection_operations
         WHERE operation_id = $1`,
        [operationId],
      );

      return result.rows[0] ? mapProjectionOperationRow(result.rows[0]) : null;
    },
    listProjectionOperationEvents: async (operationId, afterSequence = 0) =>
      listProjectionOperationEvents(db, operationId, afterSequence),
    waitForProjectionOperationEvents: (input) => projectionOperationWaiter.wait(input),
    listProjectionOperations: async (input = {}) => {
      const { predicates, params } = buildProjectionOperationPredicates(input);

      const limit = Math.max(1, Math.min(input.limit ?? DEFAULT_PROJECTION_OPERATION_LIMIT, 200));
      params.push(limit);

      const whereSql = predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";
      const result = await db.query<ProjectionOperationRow>(
        `SELECT ${PROJECTION_OPERATION_COLUMNS}
         FROM platform_projection_operations
         ${whereSql}
         ORDER BY requested_at DESC
         LIMIT $${params.length}`,
        params,
      );

      return result.rows.map(mapProjectionOperationRow);
    },
    summarizeProjectionOperations: async (input = {}) => {
      const { predicates, params } = buildProjectionOperationPredicates(input);
      const whereSql = predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";
      const result = await db.query<
        Readonly<{
          queued_count: string | number | bigint;
          running_count: string | number | bigint;
          failed_count: string | number | bigint;
          cancel_requested_count: string | number | bigint;
          oldest_queued_at: Date | string | null;
          oldest_running_at: Date | string | null;
          average_duration_ms: string | number | null;
        }>
      >(
        `SELECT
           COUNT(*) FILTER (WHERE state = 'queued') AS queued_count,
           COUNT(*) FILTER (WHERE state = 'running') AS running_count,
           COUNT(*) FILTER (WHERE state = 'failed') AS failed_count,
           COUNT(*) FILTER (WHERE state = 'cancel_requested') AS cancel_requested_count,
           MIN(requested_at) FILTER (WHERE state = 'queued') AS oldest_queued_at,
           MIN(started_at) FILTER (WHERE state IN ('running', 'cancel_requested')) AS oldest_running_at,
           AVG(EXTRACT(EPOCH FROM (COALESCE(completed_at, now()) - started_at)) * 1000)
             FILTER (WHERE started_at IS NOT NULL) AS average_duration_ms
         FROM platform_projection_operations
         ${whereSql}`,
        params,
      );
      const row = result.rows[0];

      return {
        queuedCount: String(row?.queued_count ?? "0"),
        runningCount: String(row?.running_count ?? "0"),
        failedCount: String(row?.failed_count ?? "0"),
        cancelRequestedCount: String(row?.cancel_requested_count ?? "0"),
        oldestQueuedAt: formatNullableTimestamp(row?.oldest_queued_at ?? null),
        oldestRunningAt: formatNullableTimestamp(row?.oldest_running_at ?? null),
        averageDurationMs:
          row?.average_duration_ms == null ? null : String(Math.round(Number(row.average_duration_ms))),
      };
    },
    claimScheduledRunner: async (input) => {
      const intervalMs = Math.max(1, Math.floor(input.intervalMs));
      await db.query(
        `INSERT INTO platform_scheduled_runners (
           runner_name,
           interval_ms,
           next_run_at,
           updated_at
         ) VALUES ($1, $2, now(), now())
         ON CONFLICT (runner_name) DO NOTHING`,
        [input.runnerName, intervalMs],
      );

      const result = await db.query(
        `UPDATE platform_scheduled_runners
         SET
           interval_ms = $2::integer,
           last_started_at = now(),
           next_run_at = now() + ($2::integer::text || ' milliseconds')::interval,
           updated_at = now()
         WHERE runner_name = $1
           AND next_run_at <= now()`,
        [input.runnerName, intervalMs],
      );

      return (result.rowCount ?? 0) > 0;
    },
    recordScheduledRunnerCompleted: async (input) => {
      await db.query(
        `UPDATE platform_scheduled_runners
         SET
           last_completed_at = now(),
           updated_at = now()
         WHERE runner_name = $1`,
        [input.runnerName],
      );
    },
  };
}

function buildProjectionOperationPredicates(input: Omit<ProjectionOperationListFilter, "limit">) {
  const predicates: string[] = [];
  const params: unknown[] = [];

  if (input.contextName) {
    params.push(input.contextName);
    predicates.push(`context_name = $${params.length}`);
  }
  if (input.projectionName) {
    params.push(input.projectionName);
    predicates.push(`projection_name = $${params.length}`);
  }
  if (input.state) {
    params.push(input.state);
    predicates.push(`state = $${params.length}`);
  }
  if (input.requestedByUserId) {
    params.push(input.requestedByUserId);
    predicates.push(`requested_by_user_id = $${params.length}`);
  }

  return { predicates, params };
}

const PROJECTION_OPERATION_COLUMN_NAMES = [
  "operation_id",
  "operation_kind",
  "state",
  "context_name",
  "projection_name",
  "projection_key",
  "stream_id",
  "requested_by_user_id",
  "requested_by_account_id",
  "claim_owner_id",
  "claim_fencing_token",
  "claimed_until",
  "progress",
  "result",
  "error",
  "requested_at",
  "started_at",
  "updated_at",
  "completed_at",
] as const;

const PROJECTION_OPERATION_COLUMNS = projectionOperationColumns();

function projectionOperationColumns(alias?: string): string {
  return PROJECTION_OPERATION_COLUMN_NAMES.map((columnName) => (alias ? `${alias}.${columnName}` : columnName)).join(
    ",\n  ",
  );
}

function createProjectionOperationId(): string {
  const cryptoLike = globalThis.crypto as { randomUUID?: () => string } | undefined;
  return `projection-operation-${cryptoLike?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
}

function mapLeaseRow(row: LeaseRow): PlatformLease {
  return {
    leaseName: row.lease_name,
    ownerId: row.owner_id,
    fencingToken: String(row.fencing_token),
    expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at),
  };
}

function mapProjectionOperationRow(row: ProjectionOperationRow | undefined): ProjectionOperationRecord {
  if (!row) {
    throw new Error("Projection operation query did not return a row.");
  }

  return {
    operationId: row.operation_id,
    operationKind: row.operation_kind,
    state: row.state,
    contextName: row.context_name,
    projectionName: row.projection_name,
    projectionKey: row.projection_key,
    streamId: row.stream_id,
    requestedByUserId: row.requested_by_user_id,
    requestedByAccountId: row.requested_by_account_id,
    claimOwnerId: row.claim_owner_id,
    claimFencingToken: row.claim_fencing_token === null ? null : String(row.claim_fencing_token),
    claimedUntil: formatNullableTimestamp(row.claimed_until),
    progress: readJsonRecord(row.progress) ?? {},
    result: readJsonRecord(row.result),
    error: readJsonRecord(row.error),
    requestedAt: formatTimestamp(row.requested_at),
    startedAt: formatNullableTimestamp(row.started_at),
    updatedAt: formatTimestamp(row.updated_at),
    completedAt: formatNullableTimestamp(row.completed_at),
  };
}

async function appendProjectionOperationEvent(db: PgQueryable, operation: ProjectionOperationRecord): Promise<void> {
  const sequenceResult = await db.query<{ event_sequence: number | string }>(
    `UPDATE platform_projection_operations
     SET event_sequence = event_sequence + 1
     WHERE operation_id = $1
     RETURNING event_sequence`,
    [operation.operationId],
  );
  const sequence = Number(sequenceResult.rows[0]?.event_sequence ?? 0);
  if (!sequence) {
    throw new Error("Projection operation event sequence was not reserved.");
  }

  await db.query(
    `INSERT INTO platform_projection_operation_events (
       operation_id,
       sequence,
       event_name,
       snapshot,
       created_at
     ) VALUES ($1, $2, 'status', $3::jsonb, now())`,
    [operation.operationId, sequence, JSON.stringify(operation)],
  );
  await db.query(`SELECT pg_notify($1, $2)`, [
    PROJECTION_OPERATION_NOTIFY_CHANNEL,
    JSON.stringify({ operationId: operation.operationId, sequence }),
  ]);
}

async function listProjectionOperationEvents(
  db: PgQueryable,
  operationId: string,
  afterSequence = 0,
): Promise<readonly ProjectionOperationEvent[]> {
  const result = await db.query<ProjectionOperationEventRow>(
    `SELECT sequence, event_name, snapshot, created_at
     FROM platform_projection_operation_events
     WHERE operation_id = $1
       AND sequence > $2
     ORDER BY sequence ASC
     LIMIT 100`,
    [operationId, Math.max(0, Math.floor(afterSequence))],
  );

  return result.rows.map((row) => ({
    sequence: Number(row.sequence),
    eventName: row.event_name,
    operation: readProjectionOperationSnapshot(row.snapshot),
    createdAt: formatTimestamp(row.created_at),
  }));
}

function readProjectionOperationSnapshot(value: unknown): ProjectionOperationRecord {
  if (typeof value === "string") {
    return JSON.parse(value) as ProjectionOperationRecord;
  }

  return value as ProjectionOperationRecord;
}

function formatTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function formatNullableTimestamp(value: Date | string | null): string | null {
  return value === null ? null : formatTimestamp(value);
}

function readJsonRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (typeof value === "string" && value.length > 0) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  return null;
}

async function runControlPlaneWrite<T>(db: PgTransactionalPool, work: (queryable: PgQueryable) => Promise<T>) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

type ProjectionOperationNotificationClient = Awaited<ReturnType<PgTransactionalPool["connect"]>> & {
  on?: (event: "notification" | "error", listener: (message?: { payload?: string }) => void) => void;
  off?: (event: "notification" | "error", listener: (message?: { payload?: string }) => void) => void;
};

function createProjectionOperationNotificationWaiter(db: PgTransactionalPool) {
  let clientPromise: Promise<ProjectionOperationNotificationClient> | null = null;

  async function getClient() {
    clientPromise ??= (async () => {
      const client = (await db.connect()) as ProjectionOperationNotificationClient;
      const reset = () => {
        client.off?.("error", reset);
        clientPromise = null;
        client.release();
      };
      client.on?.("error", reset);
      await client.query(`LISTEN ${PROJECTION_OPERATION_NOTIFY_CHANNEL}`);
      return client;
    })();

    return clientPromise;
  }

  return {
    wait: async (input: Readonly<{ operationId: string; signal?: AbortSignal; timeoutMs?: number }>) => {
      const timeoutMs = Math.max(100, Math.floor(input.timeoutMs ?? 500));
      if (input.signal?.aborted) {
        return waitForProjectionOperationTimeout(timeoutMs, input.signal);
      }

      const eventClient = await getClient();
      await new Promise<void>((resolve) => {
        let settled = false;
        const cleanup = () => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          input.signal?.removeEventListener("abort", cleanup);
          eventClient.off?.("notification", onNotification);
          eventClient.off?.("error", cleanup);
          resolve();
        };
        const onNotification = (message?: { payload?: string }) => {
          if (projectionOperationNotificationMatches(message?.payload, input.operationId)) {
            cleanup();
          }
        };
        const timer = setTimeout(cleanup, timeoutMs);

        input.signal?.addEventListener("abort", cleanup, { once: true });
        eventClient.on?.("notification", onNotification);
        eventClient.on?.("error", cleanup);
      });
    },
  };
}

function projectionOperationNotificationMatches(payload: string | undefined, operationId: string): boolean {
  if (!payload) {
    return false;
  }

  try {
    const parsed = JSON.parse(payload) as { operationId?: unknown };
    return parsed.operationId === operationId;
  } catch {
    return false;
  }
}

function waitForProjectionOperationTimeout(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
