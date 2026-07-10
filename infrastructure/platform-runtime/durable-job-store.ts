import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  createPostgresWorkSignalWaiter,
  emitPostgresWorkSignalNotification,
  type PostgresWorkSignalNotification,
} from "./work-signal-composite";
import { getRuntimeLifecycleRegistry, type RuntimeLifecycleRegistry } from "./runtime-lifecycle";

export type DurableJobStatus = "queued" | "running" | "completed" | "failed";

const DEFAULT_DURABLE_JOB_MAX_ATTEMPTS = 10;
const DEFAULT_DURABLE_JOB_RETRY_BACKOFF_BASE_MS = 1_000;
const DEFAULT_DURABLE_JOB_RETRY_BACKOFF_MAX_MS = 60_000;
const MAX_POSTGRES_INTEGER = 2_147_483_647;

export type DurableJobRecord<TPayload, TProgress, TResult> = Readonly<{
  jobId: string;
  jobKind: string;
  status: DurableJobStatus;
  payload: TPayload;
  progress: TProgress;
  result: TResult | null;
  errorMessage: string | null;
  eventContext: EventStoreContext | null;
  claimOwnerId: string | null;
  claimedUntil: string | null;
  attemptCount: number;
  nextEligibleAt: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}>;

export type DurableJobPublicSnapshot<TProgress, TResult> = Readonly<{
  jobId: string;
  jobKind: string;
  status: DurableJobStatus;
  progress: TProgress;
  result: TResult | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}>;

export type DurableJobEvent<
  _TPayload,
  TProgress,
  TResult,
  TSnapshot = DurableJobPublicSnapshot<TProgress, TResult>,
> = Readonly<{
  sequence: number;
  eventName: "status";
  job: TSnapshot;
  snapshot: TSnapshot;
  createdAt: string;
}>;

export type DurableJobStore<
  TPayload,
  TProgress,
  TResult,
  TSnapshot = DurableJobPublicSnapshot<TProgress, TResult>,
> = Readonly<{
  enqueue: (input: {
    jobId: string;
    jobKind: string;
    payload: TPayload;
    progress: TProgress;
    eventContext?: EventStoreContext | null;
  }) => Promise<DurableJobRecord<TPayload, TProgress, TResult>>;
  claimNext: (input: {
    claimOwnerId: string;
    claimTtlMs: number;
    jobKinds?: readonly string[];
    maxAttempts?: number;
    retryBackoffBaseMs?: number;
    retryBackoffMaxMs?: number;
  }) => Promise<DurableJobRecord<TPayload, TProgress, TResult> | null>;
  updateProgress: (input: {
    jobId: string;
    claimOwnerId: string;
    claimTtlMs: number;
    progress: TProgress;
    result?: TResult | null;
  }) => Promise<boolean>;
  renewClaim: (input: { jobId: string; claimOwnerId: string; claimTtlMs: number }) => Promise<boolean>;
  releaseClaim: (input: {
    jobId: string;
    claimOwnerId: string;
    progress: TProgress;
    result?: TResult | null;
  }) => Promise<boolean>;
  requeue: (input: {
    jobId: string;
    progress: TProgress;
    result?: TResult | null;
    errorMessage?: string | null;
    allowedStatuses?: readonly DurableJobStatus[];
    requireExpiredClaim?: boolean;
  }) => Promise<DurableJobRecord<TPayload, TProgress, TResult> | null>;
  cancel: (input: {
    jobId: string;
    progress: TProgress;
    errorMessage: string;
    allowedStatuses?: readonly DurableJobStatus[];
  }) => Promise<DurableJobRecord<TPayload, TProgress, TResult> | null>;
  complete: (input: { jobId: string; claimOwnerId: string; progress: TProgress; result: TResult }) => Promise<boolean>;
  fail: (input: { jobId: string; claimOwnerId: string; progress: TProgress; errorMessage: string }) => Promise<boolean>;
  get: (jobId: string) => Promise<DurableJobRecord<TPayload, TProgress, TResult> | null>;
  listActive: (input?: {
    jobKinds?: readonly string[];
  }) => Promise<readonly DurableJobRecord<TPayload, TProgress, TResult>[]>;
  listRecent: (input?: {
    jobKinds?: readonly string[];
    eventContext?: EventStoreContext | null;
    limit?: number;
  }) => Promise<readonly DurableJobRecord<TPayload, TProgress, TResult>[]>;
  listEvents: (
    jobId: string,
    afterSequence?: number,
  ) => Promise<readonly DurableJobEvent<TPayload, TProgress, TResult, TSnapshot>[]>;
  waitForEvents: (input: { jobId: string; signal?: AbortSignal; timeoutMs?: number }) => Promise<void>;
  stop?: () => Promise<void>;
  pruneTerminalJobs: (input: { completedBefore: string | Date; limit?: number }) => Promise<number>;
}>;

export type DurableJobTables = Readonly<{
  jobsTable: string;
  eventsTable: string;
  notifyChannel?: string;
  includeBootReshapes?: boolean;
}>;

type DurableJobRow = Readonly<{
  job_id: string;
  job_kind: string;
  status: DurableJobStatus;
  payload: unknown;
  progress: unknown;
  result: unknown;
  error_message: string | null;
  event_context: unknown;
  claim_owner_id: string | null;
  claimed_until: Date | string | null;
  attempt_count?: number | string;
  next_eligible_at?: Date | string | null;
  created_at: Date | string;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  updated_at: Date | string;
}>;

type DurableJobEventRow = Readonly<{
  sequence: number | string;
  event_name: "status";
  snapshot: unknown;
  created_at: Date | string;
}>;

export function durableJobSchemaSql(input: DurableJobTables): string {
  const jobsTable = sqlIdentifier(input.jobsTable);
  const eventsTable = sqlIdentifier(input.eventsTable);
  const includeBootReshapes = input.includeBootReshapes ?? true;

  return `
CREATE TABLE IF NOT EXISTS ${jobsTable} (
  job_id text PRIMARY KEY,
  job_kind text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  progress jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb NULL,
  error_message text NULL,
  event_context jsonb NULL,
  claim_owner_id text NULL,
  claimed_until timestamptz NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  next_eligible_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL,
  started_at timestamptz NULL,
  completed_at timestamptz NULL,
  updated_at timestamptz NOT NULL
);

ALTER TABLE ${jobsTable}
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0;

ALTER TABLE ${jobsTable}
  ADD COLUMN IF NOT EXISTS next_eligible_at timestamptz NULL;

${includeBootReshapes ? durableJobNextEligibleAtBackfillSql(jobsTable) : ""}

DO $$
BEGIN
  ALTER TABLE ${jobsTable}
    ADD CONSTRAINT ${jobsTable}_attempt_count_nonnegative CHECK (attempt_count >= 0);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS ${jobsTable}_status_created_idx
  ON ${jobsTable} (status, created_at ASC);

CREATE INDEX IF NOT EXISTS ${jobsTable}_claim_eligibility_idx
  ON ${jobsTable} (status, next_eligible_at ASC, created_at ASC);

CREATE INDEX IF NOT EXISTS ${jobsTable}_kind_status_idx
  ON ${jobsTable} (job_kind, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS ${jobsTable}_event_context_idx
  ON ${jobsTable} USING GIN (event_context);

CREATE INDEX IF NOT EXISTS ${jobsTable}_event_context_actor_idx
  ON ${jobsTable} (
    (event_context->>'tenantId'),
    (event_context->'audit'->>'forAccountId'),
    (event_context->'audit'->>'performedByUserId'),
    updated_at DESC
  );

CREATE TABLE IF NOT EXISTS ${eventsTable} (
  job_id text NOT NULL REFERENCES ${jobsTable}(job_id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence >= 1),
  event_name text NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (job_id, sequence)
);

CREATE INDEX IF NOT EXISTS ${eventsTable}_lookup_idx
  ON ${eventsTable} (job_id, sequence);
`;
}

export function durableJobSchemaMigrations(input: Pick<DurableJobTables, "jobsTable">): readonly BcSchemaMigration[] {
  const jobsTable = sqlIdentifier(input.jobsTable);
  return [
    {
      migrationId: `20260703_${jobsTable}_next_eligible_at_backfill`,
      description: `Backfill and require ${jobsTable}.next_eligible_at outside boot schema.`,
      statements: [
        `ALTER TABLE ${jobsTable}
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0;

ALTER TABLE ${jobsTable}
  ADD COLUMN IF NOT EXISTS next_eligible_at timestamptz NULL;`,
        durableJobNextEligibleAtBackfillSql(jobsTable),
      ],
    },
  ];
}

function durableJobNextEligibleAtBackfillSql(jobsTable: string): string {
  return `UPDATE ${jobsTable}
SET next_eligible_at = COALESCE(next_eligible_at, created_at, updated_at, now())
WHERE next_eligible_at IS NULL;

ALTER TABLE ${jobsTable}
  ALTER COLUMN next_eligible_at SET DEFAULT now(),
  ALTER COLUMN next_eligible_at SET NOT NULL;`;
}

export function createPostgresDurableJobStore<
  TPayload,
  TProgress,
  TResult,
  TSnapshot = DurableJobPublicSnapshot<TProgress, TResult>,
>(
  db: PgQueryable,
  tables: DurableJobTables,
  options: {
    eventSnapshot?: (job: DurableJobRecord<TPayload, TProgress, TResult>) => TSnapshot;
    notificationWaiterPool?: PgTransactionalPool;
    notificationRetryCooldownMs?: number;
    lifecycle?: RuntimeLifecycleRegistry;
    maxAttempts?: number;
    retryBackoffBaseMs?: number;
    retryBackoffMaxMs?: number;
  } = {},
): DurableJobStore<TPayload, TProgress, TResult, TSnapshot> {
  const jobsTable = sqlIdentifier(tables.jobsTable);
  const eventsTable = sqlIdentifier(tables.eventsTable);
  const notifyChannel = sqlNotifyChannel(tables.notifyChannel ?? "durable_job_events");
  const notificationPool = options.notificationWaiterPool ?? db;
  const lifecycle =
    options.lifecycle ?? getRuntimeLifecycleRegistry(notificationPool) ?? getRuntimeLifecycleRegistry(db);
  const notificationWaiter = isTransactionalPool(notificationPool)
    ? createDurableJobNotificationWaiter(notificationPool, notifyChannel, {
        retryCooldownMs: options.notificationRetryCooldownMs,
      })
    : null;
  const unregisterNotificationWaiter = notificationWaiter
    ? lifecycle?.register({
        name: `durable-job-store.${jobsTable}.notification-waiter`,
        stop: () => notificationWaiter.stop(),
      })
    : undefined;
  const defaultMaxAttempts = normalizeDurableJobMaxAttempts(options.maxAttempts);
  const defaultRetryBackoffBaseMs = normalizeDurableJobBackoffMs(
    options.retryBackoffBaseMs,
    DEFAULT_DURABLE_JOB_RETRY_BACKOFF_BASE_MS,
  );
  const defaultRetryBackoffMaxMs = Math.max(
    defaultRetryBackoffBaseMs,
    normalizeDurableJobBackoffMs(options.retryBackoffMaxMs, DEFAULT_DURABLE_JOB_RETRY_BACKOFF_MAX_MS),
  );
  const eventSnapshot =
    options.eventSnapshot ??
    ((job: DurableJobRecord<TPayload, TProgress, TResult>) =>
      toDurableJobPublicSnapshot<TPayload, TProgress, TResult>(job) as TSnapshot);

  async function appendEvent(
    queryable: PgQueryable,
    job: DurableJobRecord<TPayload, TProgress, TResult>,
  ): Promise<number> {
    const snapshot = eventSnapshot(job);
    const result = await queryable.query<{ sequence: number | string }>(
      `INSERT INTO ${eventsTable} (
         job_id,
         sequence,
         event_name,
         snapshot,
         created_at
       )
       SELECT
         $1,
         coalesce(max(sequence), 0) + 1,
         'status',
         $2::jsonb,
         now()
       FROM ${eventsTable}
       WHERE job_id = $1
       RETURNING sequence`,
      [job.jobId, JSON.stringify(snapshot)],
    );
    const sequence = Number(result.rows[0]?.sequence ?? 0);
    await emitDurableJobWorkSignal(queryable, notifyChannel, "durable-job-store", job.jobId, sequence);
    return sequence;
  }

  async function updateAndAppend(
    sql: string,
    values: readonly unknown[],
  ): Promise<DurableJobRecord<TPayload, TProgress, TResult> | null> {
    return runDurableJobWrite(db, async (queryable) => {
      const result = await queryable.query<DurableJobRow>(sql, values);
      if (!result.rows[0]) {
        return null;
      }

      const job = mapJobRow<TPayload, TProgress, TResult>(result.rows[0]);
      await appendEvent(queryable, job);
      return job;
    });
  }

  return {
    enqueue: async (input) => {
      const job = await updateAndAppend(
        `INSERT INTO ${jobsTable} (
           job_id,
           job_kind,
           status,
           payload,
           progress,
           event_context,
           created_at,
           updated_at
         ) VALUES ($1, $2, 'queued', $3::jsonb, $4::jsonb, $5::jsonb, now(), now())
         RETURNING ${DURABLE_JOB_COLUMNS}`,
        [
          input.jobId,
          input.jobKind,
          JSON.stringify(input.payload),
          JSON.stringify(input.progress),
          input.eventContext ? JSON.stringify(input.eventContext) : null,
        ],
      );
      if (!job) {
        throw new Error("Durable job was not enqueued.");
      }
      return job;
    },
    claimNext: async (input) => {
      const jobKinds = input.jobKinds?.length ? [...new Set(input.jobKinds)] : null;
      const maxAttempts = normalizeDurableJobMaxAttempts(input.maxAttempts ?? defaultMaxAttempts);
      const retryBackoffBaseMs = normalizeDurableJobBackoffMs(input.retryBackoffBaseMs, defaultRetryBackoffBaseMs);
      const retryBackoffMaxMs = Math.max(
        retryBackoffBaseMs,
        normalizeDurableJobBackoffMs(input.retryBackoffMaxMs, defaultRetryBackoffMaxMs),
      );
      return runDurableJobWrite(db, async (queryable) => {
        const exhausted = await queryable.query<DurableJobRow>(
          `WITH exhausted AS (
             SELECT job_id
             FROM ${jobsTable}
             WHERE (
                 status = 'queued'
                 OR (
                   status = 'running'
                   AND claimed_until <= now()
                 )
               )
               AND attempt_count >= $2::integer
               AND next_eligible_at <= now()
               AND ($1::text[] IS NULL OR job_kind = ANY($1::text[]))
             ORDER BY created_at ASC
             LIMIT 25
             FOR UPDATE SKIP LOCKED
           )
           UPDATE ${jobsTable} AS job
           SET status = 'failed',
               error_message = COALESCE(error_message, 'Durable job retry attempts exhausted.'),
               claim_owner_id = NULL,
               claimed_until = NULL,
               completed_at = COALESCE(completed_at, now()),
               updated_at = now()
           FROM exhausted
           WHERE job.job_id = exhausted.job_id
           RETURNING ${DURABLE_JOB_COLUMNS_FOR_JOB_ALIAS}`,
          [jobKinds, maxAttempts],
        );
        for (const row of exhausted.rows) {
          await appendEvent(queryable, mapJobRow<TPayload, TProgress, TResult>(row));
        }

        const claimed = await queryable.query<DurableJobRow>(
          `WITH claimable AS (
             SELECT job_id
             FROM ${jobsTable}
             WHERE (
                 status = 'queued'
                 OR (
                   status = 'running'
                   AND claimed_until <= now()
                 )
               )
               AND attempt_count < $4::integer
               AND next_eligible_at <= now()
               AND ($3::text[] IS NULL OR job_kind = ANY($3::text[]))
             ORDER BY created_at ASC
             LIMIT 1
             FOR UPDATE SKIP LOCKED
           )
           UPDATE ${jobsTable} AS job
           SET status = 'running',
               claim_owner_id = $1,
               claimed_until = now() + ($2::text || ' milliseconds')::interval,
               attempt_count = job.attempt_count + 1,
               next_eligible_at =
                 now()
                 + ($2::text || ' milliseconds')::interval
                 + (
                   LEAST(
                     $6::numeric,
                     $5::numeric * power(2::numeric, LEAST(GREATEST(job.attempt_count, 0), 10))
                   )::integer::text || ' milliseconds'
                 )::interval,
               started_at = COALESCE(job.started_at, now()),
               updated_at = now()
           FROM claimable
           WHERE job.job_id = claimable.job_id
           RETURNING ${DURABLE_JOB_COLUMNS_FOR_JOB_ALIAS}`,
          [input.claimOwnerId, input.claimTtlMs, jobKinds, maxAttempts, retryBackoffBaseMs, retryBackoffMaxMs],
        );
        if (!claimed.rows[0]) {
          return null;
        }

        const job = mapJobRow<TPayload, TProgress, TResult>(claimed.rows[0]);
        await appendEvent(queryable, job);
        return job;
      });
    },
    updateProgress: async (input) => {
      const job = await updateAndAppend(
        `UPDATE ${jobsTable}
         SET progress = $3::jsonb,
             result = COALESCE($4::jsonb, result),
             claimed_until = now() + ($5::text || ' milliseconds')::interval,
             updated_at = now()
         WHERE job_id = $1
           AND claim_owner_id = $2
           AND status = 'running'
           AND claimed_until > now()
         RETURNING ${DURABLE_JOB_COLUMNS}`,
        [
          input.jobId,
          input.claimOwnerId,
          JSON.stringify(input.progress),
          input.result === undefined ? null : JSON.stringify(input.result),
          input.claimTtlMs,
        ],
      );
      return Boolean(job);
    },
    renewClaim: async (input) => {
      const result = await db.query(
        `UPDATE ${jobsTable}
         SET claimed_until = now() + ($3::text || ' milliseconds')::interval,
             updated_at = now()
         WHERE job_id = $1
           AND claim_owner_id = $2
           AND status = 'running'
           AND claimed_until > now()`,
        [input.jobId, input.claimOwnerId, input.claimTtlMs],
      );
      return Number(result.rowCount ?? 0) > 0;
    },
    releaseClaim: async (input) => {
      const job = await updateAndAppend(
        `UPDATE ${jobsTable} AS job
         SET status = 'queued',
             progress = $3::jsonb,
             result = COALESCE($4::jsonb, result),
             claim_owner_id = NULL,
             claimed_until = NULL,
             next_eligible_at =
               now()
               + (
                 LEAST(
                   $6::numeric,
                   $5::numeric * power(2::numeric, LEAST(GREATEST(job.attempt_count - 1, 0), 10))
                 )::integer::text || ' milliseconds'
               )::interval,
             updated_at = now()
          WHERE job_id = $1
            AND claim_owner_id = $2
            AND status = 'running'
            AND claimed_until > now()
          RETURNING ${DURABLE_JOB_COLUMNS_FOR_JOB_ALIAS}`,
        [
          input.jobId,
          input.claimOwnerId,
          JSON.stringify(input.progress),
          input.result === undefined ? null : JSON.stringify(input.result),
          defaultRetryBackoffBaseMs,
          defaultRetryBackoffMaxMs,
        ],
      );
      return Boolean(job);
    },
    requeue: async (input) => {
      const allowedStatuses: DurableJobStatus[] = input.allowedStatuses?.length
        ? [...new Set(input.allowedStatuses)]
        : ["failed", "completed"];
      return updateAndAppend(
        `UPDATE ${jobsTable}
         SET status = 'queued',
             progress = $2::jsonb,
             result = COALESCE($3::jsonb, result),
             error_message = $4,
             claim_owner_id = NULL,
             claimed_until = NULL,
             attempt_count = 0,
             next_eligible_at = now(),
             completed_at = NULL,
             updated_at = now()
         WHERE job_id = $1
           AND status = ANY($5::text[])
           AND ($6::boolean = false OR claimed_until IS NULL OR claimed_until <= now())
         RETURNING ${DURABLE_JOB_COLUMNS}`,
        [
          input.jobId,
          JSON.stringify(input.progress),
          input.result === undefined ? null : JSON.stringify(input.result),
          input.errorMessage ?? null,
          allowedStatuses,
          input.requireExpiredClaim ?? false,
        ],
      );
    },
    cancel: async (input) => {
      const allowedStatuses: DurableJobStatus[] = input.allowedStatuses?.length
        ? [...new Set(input.allowedStatuses)]
        : ["queued", "running"];
      return updateAndAppend(
        `UPDATE ${jobsTable}
         SET status = 'failed',
             progress = $2::jsonb,
             error_message = $3,
             claim_owner_id = NULL,
             claimed_until = NULL,
             completed_at = now(),
             updated_at = now()
         WHERE job_id = $1
           AND status = ANY($4::text[])
         RETURNING ${DURABLE_JOB_COLUMNS}`,
        [input.jobId, JSON.stringify(input.progress), input.errorMessage, allowedStatuses],
      );
    },
    waitForEvents: async (input) => {
      const timeoutMs = Math.max(100, Math.floor(input.timeoutMs ?? 500));
      try {
        await (notificationWaiter?.wait({
          jobId: input.jobId,
          signal: input.signal,
          timeoutMs,
        }) ?? waitForDurableJobTimeout(timeoutMs, input.signal));
      } catch {
        await waitForDurableJobTimeout(timeoutMs, input.signal);
      }
    },
    stop: async () => {
      unregisterNotificationWaiter?.();
      await notificationWaiter?.stop();
    },
    pruneTerminalJobs: async (input) => {
      const result = await db.query<{ job_id: string }>(
        `WITH expired AS (
           SELECT job_id
           FROM ${jobsTable}
           WHERE status IN ('completed', 'failed')
             AND completed_at < $1::timestamptz
           ORDER BY completed_at ASC, job_id ASC
           LIMIT $2
         )
         DELETE FROM ${jobsTable} AS job
         USING expired
         WHERE job.job_id = expired.job_id
         RETURNING job.job_id`,
        [formatDateInput(input.completedBefore), Math.max(1, Math.min(input.limit ?? 500, 5_000))],
      );
      return Number(result.rowCount ?? result.rows.length);
    },
    complete: async (input) => {
      const job = await updateAndAppend(
        `UPDATE ${jobsTable}
         SET status = 'completed',
             progress = $3::jsonb,
             result = $4::jsonb,
             error_message = NULL,
             claimed_until = NULL,
             completed_at = now(),
             updated_at = now()
         WHERE job_id = $1
           AND claim_owner_id = $2
           AND status = 'running'
           AND claimed_until > now()
         RETURNING ${DURABLE_JOB_COLUMNS}`,
        [input.jobId, input.claimOwnerId, JSON.stringify(input.progress), JSON.stringify(input.result)],
      );
      return Boolean(job);
    },
    fail: async (input) => {
      const job = await updateAndAppend(
        `UPDATE ${jobsTable}
         SET status = 'failed',
             progress = $3::jsonb,
             error_message = $4,
             claimed_until = NULL,
             completed_at = now(),
             updated_at = now()
         WHERE job_id = $1
           AND claim_owner_id = $2
           AND status = 'running'
           AND claimed_until > now()
         RETURNING ${DURABLE_JOB_COLUMNS}`,
        [input.jobId, input.claimOwnerId, JSON.stringify(input.progress), input.errorMessage],
      );
      return Boolean(job);
    },
    get: async (jobId) => {
      const result = await db.query<DurableJobRow>(
        `SELECT ${DURABLE_JOB_COLUMNS}
         FROM ${jobsTable}
         WHERE job_id = $1`,
        [jobId],
      );
      return result.rows[0] ? mapJobRow<TPayload, TProgress, TResult>(result.rows[0]) : null;
    },
    listActive: async (input = {}) => {
      const jobKinds = input.jobKinds?.length ? [...new Set(input.jobKinds)] : null;
      const result = await db.query<DurableJobRow>(
        `SELECT ${DURABLE_JOB_COLUMNS}
         FROM ${jobsTable}
         WHERE status IN ('queued', 'running')
           AND ($1::text[] IS NULL OR job_kind = ANY($1::text[]))
         ORDER BY created_at ASC
         LIMIT 50`,
        [jobKinds],
      );
      return result.rows.map(mapJobRow<TPayload, TProgress, TResult>);
    },
    listRecent: async (input = {}) => {
      const jobKinds = input.jobKinds?.length ? [...new Set(input.jobKinds)] : null;
      const tenantId = input.eventContext?.tenantId ?? null;
      const forAccountId = input.eventContext?.audit?.forAccountId ?? null;
      const performedByUserId = input.eventContext?.audit?.performedByUserId ?? null;
      const limit = Math.max(1, Math.min(input.limit ?? 50, 250));
      const result = await db.query<DurableJobRow>(
        `SELECT ${DURABLE_JOB_COLUMNS}
         FROM ${jobsTable}
         WHERE ($1::text[] IS NULL OR job_kind = ANY($1::text[]))
           AND ($2::text IS NULL OR event_context->>'tenantId' = $2::text)
           AND ($3::text IS NULL OR event_context->'audit'->>'forAccountId' = $3::text)
           AND ($4::text IS NULL OR event_context->'audit'->>'performedByUserId' = $4::text)
         ORDER BY updated_at DESC, created_at DESC, job_id ASC
         LIMIT $5`,
        [jobKinds, tenantId, forAccountId, performedByUserId, limit],
      );
      return result.rows.map(mapJobRow<TPayload, TProgress, TResult>);
    },
    listEvents: async (jobId, afterSequence = 0) => {
      const result = await db.query<DurableJobEventRow>(
        `SELECT sequence, event_name, snapshot, created_at
         FROM ${eventsTable}
         WHERE job_id = $1
           AND sequence > $2
         ORDER BY sequence ASC
         LIMIT 100`,
        [jobId, Math.max(0, Math.floor(afterSequence))],
      );

      return result.rows.map((row) => {
        const snapshot = readJobSnapshot<TSnapshot>(row.snapshot);
        return {
          sequence: Number(row.sequence),
          eventName: row.event_name,
          job: snapshot,
          snapshot,
          createdAt: formatTimestamp(row.created_at),
        };
      });
    },
  };
}

export type DurableJobExecutionContext<TProgress, TResult> = Readonly<{
  signal?: AbortSignal;
  throwIfCancelled: () => void;
  renew: () => Promise<void>;
  checkpointProgress: (progress: TProgress, result?: TResult | null) => Promise<void>;
}>;

export class DurableJobHandoffError extends Error {
  readonly code = "durable_job_handoff";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DurableJobHandoffError";
  }
}

export type DurableJobProgressCheckpoint<TProgress, TResult> = Readonly<{
  checkpoint: (progress: TProgress, result?: TResult | null) => Promise<void>;
  flush: (progress: TProgress, result?: TResult | null) => Promise<void>;
}>;

export function createDurableJobExecutionContext<TPayload, TProgress, TResult, TSnapshot>(
  store: DurableJobStore<TPayload, TProgress, TResult, TSnapshot>,
  input: Readonly<{
    jobId: string;
    claimOwnerId: string;
    claimTtlMs: number;
    signal?: AbortSignal;
    throwIfLeaseLost?: () => void;
    cancelledMessage: string;
    claimLostMessage: string;
  }>,
): DurableJobExecutionContext<TProgress, TResult> {
  const throwIfCancelled = () => {
    input.throwIfLeaseLost?.();
    if (input.signal?.aborted) {
      throw new Error(input.cancelledMessage);
    }
  };

  const requireClaim = async (succeeded: Promise<boolean> | boolean) => {
    if (!(await succeeded)) {
      throw new Error(input.claimLostMessage);
    }
  };

  return {
    signal: input.signal,
    throwIfCancelled,
    renew: async () => {
      throwIfCancelled();
      await requireClaim(
        store.renewClaim({
          jobId: input.jobId,
          claimOwnerId: input.claimOwnerId,
          claimTtlMs: input.claimTtlMs,
        }),
      );
    },
    checkpointProgress: async (progress, result) => {
      throwIfCancelled();
      await requireClaim(
        store.updateProgress({
          jobId: input.jobId,
          claimOwnerId: input.claimOwnerId,
          claimTtlMs: input.claimTtlMs,
          progress,
          result,
        }),
      );
    },
  };
}

export function createDurableJobProgressCheckpoint<TProgress, TResult>(
  context: DurableJobExecutionContext<TProgress, TResult>,
  options: Readonly<{
    minIntervalMs?: number;
    minCompletedDelta?: number;
    minRenewIntervalMs?: number;
    completed?: (progress: TProgress) => number | null | undefined;
    isTerminal?: (progress: TProgress) => boolean;
  }> = {},
): DurableJobProgressCheckpoint<TProgress, TResult> {
  const minIntervalMs = Math.max(0, Math.floor(options.minIntervalMs ?? 1_000));
  const minCompletedDelta = Math.max(1, Math.floor(options.minCompletedDelta ?? 25));
  const minRenewIntervalMs = Math.max(0, Math.floor(options.minRenewIntervalMs ?? 5_000));
  let lastCheckpointAt = 0;
  let lastCompleted: number | null = null;
  let lastRenewedAt = 0;

  const shouldCheckpoint = (progress: TProgress) => {
    if (options.isTerminal?.(progress)) {
      return true;
    }

    const now = Date.now();
    const completed = options.completed?.(progress);
    if (lastCheckpointAt === 0) {
      return true;
    }

    if (typeof completed === "number" && Number.isFinite(completed)) {
      const previousCompleted = lastCompleted ?? 0;
      if (completed - previousCompleted >= minCompletedDelta) {
        return true;
      }
    }

    return now - lastCheckpointAt >= minIntervalMs;
  };

  const recordCheckpoint = async (progress: TProgress, result?: TResult | null) => {
    await context.checkpointProgress(progress, result);
    lastCheckpointAt = Date.now();
    lastRenewedAt = lastCheckpointAt;
    const completed = options.completed?.(progress);
    lastCompleted = typeof completed === "number" && Number.isFinite(completed) ? completed : lastCompleted;
  };

  return {
    checkpoint: async (progress, result) => {
      if (shouldCheckpoint(progress)) {
        await recordCheckpoint(progress, result);
        return;
      }

      context.throwIfCancelled();
      const now = Date.now();
      if (lastRenewedAt === 0 || now - lastRenewedAt >= minRenewIntervalMs) {
        await context.renew();
        lastRenewedAt = Date.now();
      }
    },
    flush: recordCheckpoint,
  };
}

export async function runDurableJobSideEffect<TProgress, TResult, T>(
  context: DurableJobExecutionContext<TProgress, TResult> | undefined,
  work: (signal: AbortSignal) => Promise<T>,
  options: Readonly<{
    renewIntervalMs?: number;
    claimLostMessage?: string;
  }> = {},
): Promise<T> {
  if (!context) {
    return work(new AbortController().signal);
  }

  const renewIntervalMs = Math.max(250, Math.floor(options.renewIntervalMs ?? 5_000));
  const abortController = new AbortController();
  const claimLostMessage = options.claimLostMessage ?? "Durable job claim was lost while running a side effect.";
  let settled = false;
  let rejectHandoff: ((error: Error) => void) | null = null;

  const handoff = new Promise<never>((_resolve, reject) => {
    rejectHandoff = reject;
  });
  handoff.catch(() => undefined);
  const toHandoffError = (error: unknown) => {
    const cause = error instanceof Error ? error : undefined;
    return error instanceof DurableJobHandoffError
      ? error
      : new DurableJobHandoffError(cause?.message ?? claimLostMessage, { cause });
  };
  const handOff = (error: unknown) => {
    const handoffError = toHandoffError(error);
    if (settled) {
      return handoffError;
    }

    abortController.abort(handoffError);
    rejectHandoff?.(handoffError);
    return handoffError;
  };
  const abortFromParent = () => handOff(new DurableJobHandoffError("Durable job was cancelled."));

  context.signal?.addEventListener("abort", abortFromParent, { once: true });
  let renewalTimer: ReturnType<typeof setInterval> | null = null;

  try {
    await context.renew().catch((error) => {
      throw handOff(error);
    });
    let renewalInFlight = false;
    renewalTimer = setInterval(() => {
      if (renewalInFlight) {
        return;
      }
      renewalInFlight = true;
      void context
        .renew()
        .catch(handOff)
        .finally(() => {
          renewalInFlight = false;
        });
    }, renewIntervalMs);
    renewalTimer.unref?.();

    context.throwIfCancelled();
    const workPromise = work(abortController.signal);
    workPromise.catch(() => undefined);
    const result = await Promise.race([workPromise, handoff]);
    await context.renew().catch((error) => {
      throw new DurableJobHandoffError(error instanceof Error ? error.message : claimLostMessage, {
        cause: error instanceof Error ? error : undefined,
      });
    });
    return result;
  } finally {
    settled = true;
    if (renewalTimer) {
      clearInterval(renewalTimer);
    }
    context.signal?.removeEventListener("abort", abortFromParent);
    abortController.abort();
  }
}

export function isDurableJobHandoffError(error: unknown, input?: { signal?: AbortSignal }): boolean {
  return (
    input?.signal?.aborted ||
    error instanceof DurableJobHandoffError ||
    (error instanceof Error && (error.message.startsWith("Lost lease ") || error.message.includes("claim was lost")))
  );
}

const DURABLE_JOB_COLUMNS = `
  job_id,
  job_kind,
  status,
  payload,
  progress,
  result,
  error_message,
  event_context,
  claim_owner_id,
  claimed_until,
  attempt_count,
  next_eligible_at,
  created_at,
  started_at,
  completed_at,
  updated_at
`;

const DURABLE_JOB_COLUMNS_FOR_JOB_ALIAS = `
  job.job_id,
  job.job_kind,
  job.status,
  job.payload,
  job.progress,
  job.result,
  job.error_message,
  job.event_context,
  job.claim_owner_id,
  job.claimed_until,
  job.attempt_count,
  job.next_eligible_at,
  job.created_at,
  job.started_at,
  job.completed_at,
  job.updated_at
`;

function mapJobRow<TPayload, TProgress, TResult>(row: DurableJobRow): DurableJobRecord<TPayload, TProgress, TResult> {
  return {
    jobId: row.job_id,
    jobKind: row.job_kind,
    status: row.status,
    payload: readJson<TPayload>(row.payload),
    progress: readJson<TProgress>(row.progress),
    result: row.result == null ? null : readJson<TResult>(row.result),
    errorMessage: row.error_message,
    eventContext: row.event_context == null ? null : readJson<EventStoreContext>(row.event_context),
    claimOwnerId: row.claim_owner_id,
    claimedUntil: formatNullableTimestamp(row.claimed_until),
    attemptCount: Number(row.attempt_count ?? 0),
    nextEligibleAt: formatNullableTimestamp(row.next_eligible_at ?? row.created_at) ?? formatTimestamp(row.created_at),
    createdAt: formatTimestamp(row.created_at),
    startedAt: formatNullableTimestamp(row.started_at),
    completedAt: formatNullableTimestamp(row.completed_at),
    updatedAt: formatTimestamp(row.updated_at),
  };
}

export function toDurableJobPublicSnapshot<TPayload, TProgress, TResult>(
  job: DurableJobRecord<TPayload, TProgress, TResult>,
): DurableJobPublicSnapshot<TProgress, TResult> {
  return {
    jobId: job.jobId,
    jobKind: job.jobKind,
    status: job.status,
    progress: job.progress,
    result: job.result,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    updatedAt: job.updatedAt,
  };
}

function readJobSnapshot<TSnapshot>(value: unknown): TSnapshot {
  return readJson<TSnapshot>(value);
}

function readJson<T>(value: unknown): T {
  if (typeof value === "string") {
    return JSON.parse(value) as T;
  }

  return value as T;
}

function formatTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function formatNullableTimestamp(value: Date | string | null): string | null {
  return value === null ? null : formatTimestamp(value);
}

function formatDateInput(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function sqlIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid SQL identifier: ${value}`);
  }

  return value;
}

function sqlNotifyChannel(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid durable job notify channel: ${value}`);
  }

  return value;
}

function isTransactionalPool(db: PgQueryable): db is PgTransactionalPool {
  return typeof (db as { connect?: unknown }).connect === "function";
}

async function runDurableJobWrite<T>(db: PgQueryable, work: (queryable: PgQueryable) => Promise<T>): Promise<T> {
  if (!isTransactionalPool(db)) {
    return work(db);
  }

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

// Durable job event notifications ride the platform work-signal composite:
// versioned envelopes on the store's notify channel, dedicated
// composite waiters with bounded-timeout fallback, and circuit-broken
// listener retries. Context-owned job/event tables stay the source of truth;
// a missed notification only means waiting out the poll timeout.
export async function emitDurableJobWorkSignal(
  queryable: PgQueryable,
  channel: string,
  source: string,
  jobId: string,
  sequence: number,
): Promise<void> {
  await emitPostgresWorkSignalNotification(queryable, {
    channel,
    envelope: {
      kind: "durable-job.event",
      source,
      payload: { jobId, sequence },
    },
  });
}

function createDurableJobNotificationWaiter(
  db: PgTransactionalPool,
  channel: string,
  options: Readonly<{ retryCooldownMs?: number }> = {},
) {
  const waiter = createPostgresWorkSignalWaiter(db, {
    channel,
    listenRetryCooldownMs: Math.max(1_000, Math.floor(options.retryCooldownMs ?? 60_000)),
  });

  return {
    wait: async (input: Readonly<{ jobId: string; signal?: AbortSignal; timeoutMs?: number }>) => {
      await waiter.wait({
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        matches: (notification) => durableJobNotificationMatchesJob(notification, input.jobId),
      });
    },
    stop: () => waiter.stop(),
  };
}

function durableJobNotificationMatchesJob(notification: PostgresWorkSignalNotification, jobId: string): boolean {
  if (notification.envelope) {
    return notification.envelope.kind === "durable-job.event" && notification.envelope.payload.jobId === jobId;
  }

  // Rolling-deploy compatibility: pre-composite emitters send a raw
  // { jobId, sequence } payload.
  return notificationJobId(notification.payload) === jobId;
}

function notificationJobId(payload: string | undefined): string | null {
  if (!payload) {
    return null;
  }

  try {
    const parsed = JSON.parse(payload) as { jobId?: unknown };
    return typeof parsed.jobId === "string" ? parsed.jobId : null;
  } catch {
    return null;
  }
}

function waitForDurableJobTimeout(ms: number, signal?: AbortSignal): Promise<void> {
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

function normalizeDurableJobMaxAttempts(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_DURABLE_JOB_MAX_ATTEMPTS;
  }

  return Math.max(1, Math.min(MAX_POSTGRES_INTEGER, Math.floor(value)));
}

function normalizeDurableJobBackoffMs(value: number | undefined, fallback: number): number {
  const raw = value ?? fallback;
  return Number.isFinite(raw) ? Math.max(0, Math.min(MAX_POSTGRES_INTEGER, Math.floor(raw))) : fallback;
}
