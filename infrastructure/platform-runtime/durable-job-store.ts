import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type DurableJobStatus = "queued" | "running" | "completed" | "failed";

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
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}>;

export type DurableJobEvent<TPayload, TProgress, TResult> = Readonly<{
  sequence: number;
  eventName: "status";
  job: DurableJobRecord<TPayload, TProgress, TResult>;
  createdAt: string;
}>;

export type DurableJobStore<TPayload, TProgress, TResult> = Readonly<{
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
  }) => Promise<DurableJobRecord<TPayload, TProgress, TResult> | null>;
  updateProgress: (input: {
    jobId: string;
    claimOwnerId: string;
    progress: TProgress;
    result?: TResult | null;
  }) => Promise<boolean>;
  complete: (input: { jobId: string; claimOwnerId: string; progress: TProgress; result: TResult }) => Promise<boolean>;
  fail: (input: { jobId: string; claimOwnerId: string; progress: TProgress; errorMessage: string }) => Promise<boolean>;
  get: (jobId: string) => Promise<DurableJobRecord<TPayload, TProgress, TResult> | null>;
  listActive: (input?: {
    jobKinds?: readonly string[];
  }) => Promise<readonly DurableJobRecord<TPayload, TProgress, TResult>[]>;
  listEvents: (
    jobId: string,
    afterSequence?: number,
  ) => Promise<readonly DurableJobEvent<TPayload, TProgress, TResult>[]>;
}>;

type DurableJobTables = Readonly<{
  jobsTable: string;
  eventsTable: string;
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
  created_at timestamptz NOT NULL,
  started_at timestamptz NULL,
  completed_at timestamptz NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS ${jobsTable}_status_created_idx
  ON ${jobsTable} (status, created_at ASC);

CREATE INDEX IF NOT EXISTS ${jobsTable}_kind_status_idx
  ON ${jobsTable} (job_kind, status, updated_at DESC);

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

export function createPostgresDurableJobStore<TPayload, TProgress, TResult>(
  db: PgQueryable,
  tables: DurableJobTables,
): DurableJobStore<TPayload, TProgress, TResult> {
  const jobsTable = sqlIdentifier(tables.jobsTable);
  const eventsTable = sqlIdentifier(tables.eventsTable);

  async function appendEvent(job: DurableJobRecord<TPayload, TProgress, TResult>) {
    await db.query(
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
       WHERE job_id = $1`,
      [job.jobId, JSON.stringify(job)],
    );
  }

  async function updateAndAppend(
    sql: string,
    values: readonly unknown[],
  ): Promise<DurableJobRecord<TPayload, TProgress, TResult> | null> {
    const result = await db.query<DurableJobRow>(sql, values);
    if (!result.rows[0]) {
      return null;
    }

    const job = mapJobRow<TPayload, TProgress, TResult>(result.rows[0]);
    await appendEvent(job);
    return job;
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
      return updateAndAppend(
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
             AND ($3::text[] IS NULL OR job_kind = ANY($3::text[]))
           ORDER BY created_at ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
         UPDATE ${jobsTable} AS job
         SET status = 'running',
             claim_owner_id = $1,
             claimed_until = now() + ($2::text || ' milliseconds')::interval,
             started_at = COALESCE(job.started_at, now()),
             updated_at = now()
         FROM claimable
         WHERE job.job_id = claimable.job_id
         RETURNING ${DURABLE_JOB_COLUMNS_FOR_JOB_ALIAS}`,
        [input.claimOwnerId, input.claimTtlMs, jobKinds],
      );
    },
    updateProgress: async (input) => {
      const job = await updateAndAppend(
        `UPDATE ${jobsTable}
         SET progress = $3::jsonb,
             result = COALESCE($4::jsonb, result),
             claimed_until = GREATEST(claimed_until, now()),
             updated_at = now()
         WHERE job_id = $1
           AND claim_owner_id = $2
           AND status = 'running'
         RETURNING ${DURABLE_JOB_COLUMNS}`,
        [
          input.jobId,
          input.claimOwnerId,
          JSON.stringify(input.progress),
          input.result === undefined ? null : JSON.stringify(input.result),
        ],
      );
      return Boolean(job);
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

      return result.rows.map((row) => ({
        sequence: Number(row.sequence),
        eventName: row.event_name,
        job: readJobSnapshot<TPayload, TProgress, TResult>(row.snapshot),
        createdAt: formatTimestamp(row.created_at),
      }));
    },
  };
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
    createdAt: formatTimestamp(row.created_at),
    startedAt: formatNullableTimestamp(row.started_at),
    completedAt: formatNullableTimestamp(row.completed_at),
    updatedAt: formatTimestamp(row.updated_at),
  };
}

function readJobSnapshot<TPayload, TProgress, TResult>(value: unknown): DurableJobRecord<TPayload, TProgress, TResult> {
  return readJson<DurableJobRecord<TPayload, TProgress, TResult>>(value);
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

function sqlIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid SQL identifier: ${value}`);
  }

  return value;
}
