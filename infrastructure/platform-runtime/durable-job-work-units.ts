import { createInternalId } from "@chase-sets/primitives/typed-ids";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  emitDurableJobWorkSignal,
  toDurableJobPublicSnapshot,
  type DurableJobPublicSnapshot,
  type DurableJobRecord,
  type DurableJobStatus,
} from "./durable-job-store";

export type DurableJobWorkUnitState = "queued" | "running" | "completed" | "failed" | "skipped";

export type DurableJobWorkUnitRecord<TPayload, TResult> = Readonly<{
  jobId: string;
  unitId: string;
  unitKind: string;
  state: DurableJobWorkUnitState;
  payload: TPayload;
  result: TResult | null;
  errorMessage: string | null;
  claimOwnerId: string | null;
  claimToken: string | null;
  claimedUntil: string | null;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}>;

export type DurableJobWorkUnitClaim<TJobPayload, TJobProgress, TJobResult, TUnitPayload, TUnitResult> = Readonly<{
  workflowName: string;
  laneName: string | null;
  job: DurableJobRecord<TJobPayload, TJobProgress, TJobResult>;
  unit: DurableJobWorkUnitRecord<TUnitPayload, TUnitResult>;
  claimOwnerId: string;
  claimToken: string;
}>;

export type DurableJobWorkUnitClaimOutcomeReason =
  | "claimed"
  | "none_available"
  | "workflow_budget_exhausted"
  | "job_budget_exhausted";

export type DurableJobWorkUnitClaimOutcome = Readonly<{
  workflowName: string;
  laneName: string | null;
  claimed: boolean;
  reason: DurableJobWorkUnitClaimOutcomeReason;
  activeClaims: number;
  workflowMaxActiveClaims: number;
  jobMaxActiveClaims: number;
}>;

export type DurableJobWorkUnitClaimResult<TJobPayload, TJobProgress, TJobResult, TUnitPayload, TUnitResult> =
  | Readonly<{
      claim: DurableJobWorkUnitClaim<TJobPayload, TJobProgress, TJobResult, TUnitPayload, TUnitResult>;
      outcome: DurableJobWorkUnitClaimOutcome;
    }>
  | Readonly<{
      claim: null;
      outcome: DurableJobWorkUnitClaimOutcome;
    }>;

export type DurableJobWorkUnitSummary = Readonly<{
  workflowName: string;
  jobId: string | null;
  total: number;
  queued: number;
  running: number;
  completed: number;
  failed: number;
  skipped: number;
  activeClaims: number;
  expiredClaims: number;
}>;

type DurableJobWorkUnitTables = Readonly<{
  jobsTable: string;
  eventsTable: string;
  workUnitsTable: string;
  notifyChannel?: string;
}>;

type DurableJobWorkUnitStoreOptions<TJobPayload, TJobProgress, TJobResult, TSnapshot> = Readonly<{
  workflowName: string;
  eventSnapshot?: (job: DurableJobRecord<TJobPayload, TJobProgress, TJobResult>) => TSnapshot;
}>;

export type DurableJobWorkUnitTerminalOutcome = "recorded" | "unit-claim-missing" | "parent-already-terminal";

export function isDurableJobWorkUnitTerminalAccepted(outcome: boolean | DurableJobWorkUnitTerminalOutcome): boolean {
  return outcome === true || outcome === "recorded" || outcome === "parent-already-terminal";
}

export type DurableJobWorkUnitStore<TJobPayload, TJobProgress, TJobResult, TUnitPayload, TUnitResult> = Readonly<{
  enqueue: (input: {
    jobId: string;
    units: readonly Readonly<{ unitId: string; unitKind?: string; payload: TUnitPayload }>[];
  }) => Promise<number>;
  claimNext: (input: {
    claimOwnerId: string;
    claimTtlMs: number;
    workflowMaxActiveClaims: number;
    jobMaxActiveClaims: number;
    jobKinds?: readonly string[];
    laneName?: string | null;
  }) => Promise<DurableJobWorkUnitClaimResult<TJobPayload, TJobProgress, TJobResult, TUnitPayload, TUnitResult>>;
  renewClaim: (input: {
    jobId: string;
    unitId: string;
    claimOwnerId: string;
    claimToken: string;
    claimTtlMs: number;
  }) => Promise<boolean>;
  releaseClaim: (input: {
    jobId: string;
    unitId: string;
    claimOwnerId: string;
    claimToken: string;
  }) => Promise<boolean>;
  recordTerminal: (input: {
    jobId: string;
    unitId: string;
    claimOwnerId: string;
    claimToken: string;
    state: Exclude<DurableJobWorkUnitState, "queued" | "running">;
    unitResult?: TUnitResult | null;
    errorMessage?: string | null;
    parentProgress: TJobProgress;
    parentResult?: TJobResult | null;
    completeJob?: boolean;
    resolveParentUpdate?: (queryable: PgQueryable) => Promise<
      Readonly<{
        parentProgress: TJobProgress;
        parentResult?: TJobResult | null;
        completeJob?: boolean;
      }>
    >;
  }) => Promise<DurableJobWorkUnitTerminalOutcome>;
  reconcileTerminalParent: (input: {
    jobId: string;
    parentProgress: TJobProgress;
    parentResult?: TJobResult | null;
    completeJob?: boolean;
    resolveParentUpdate?: (queryable: PgQueryable) => Promise<
      Readonly<{
        parentProgress: TJobProgress;
        parentResult?: TJobResult | null;
        completeJob?: boolean;
      }>
    >;
  }) => Promise<boolean>;
  listForJob: (jobId: string) => Promise<readonly DurableJobWorkUnitRecord<TUnitPayload, TUnitResult>[]>;
  summarize: (input?: { jobId?: string | null }) => Promise<DurableJobWorkUnitSummary>;
}>;

type JobRow = Readonly<{
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

type WorkUnitRow = Readonly<{
  job_id: string;
  unit_id: string;
  unit_kind: string;
  state: DurableJobWorkUnitState;
  payload: unknown;
  result: unknown;
  error_message: string | null;
  claim_owner_id: string | null;
  claim_token: string | null;
  claimed_until: Date | string | null;
  attempt_count: number | string;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
}>;

type ClaimedRow = PrefixedJobRow & PrefixedUnitRow;

type PrefixedJobRow = Readonly<Record<`job_${keyof JobRow}`, unknown>>;
type PrefixedUnitRow = Readonly<Record<`unit_${keyof WorkUnitRow}`, unknown>>;

type SummaryRow = Readonly<{
  total: number | string;
  queued: number | string;
  running: number | string;
  completed: number | string;
  failed: number | string;
  skipped: number | string;
  active_claims: number | string;
  expired_claims: number | string;
}>;

export function durableJobWorkUnitSchemaSql(
  input: Pick<DurableJobWorkUnitTables, "jobsTable" | "workUnitsTable">,
): string {
  const jobsTable = sqlIdentifier(input.jobsTable);
  const workUnitsTable = sqlIdentifier(input.workUnitsTable);

  return `
CREATE TABLE IF NOT EXISTS ${workUnitsTable} (
  job_id text NOT NULL REFERENCES ${jobsTable}(job_id) ON DELETE CASCADE,
  unit_id text NOT NULL,
  unit_kind text NOT NULL DEFAULT 'default',
  state text NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed', 'skipped')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb NULL,
  error_message text NULL,
  claim_owner_id text NULL,
  claim_token text NULL,
  claimed_until timestamptz NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz NULL,
  PRIMARY KEY (job_id, unit_id)
);

CREATE INDEX IF NOT EXISTS ${workUnitsTable}_claimable_idx
  ON ${workUnitsTable} (state, claimed_until, created_at ASC);

CREATE INDEX IF NOT EXISTS ${workUnitsTable}_job_state_idx
  ON ${workUnitsTable} (job_id, state, updated_at DESC);

CREATE INDEX IF NOT EXISTS ${workUnitsTable}_active_claims_idx
  ON ${workUnitsTable} (job_id, claimed_until)
  WHERE state = 'running';
`;
}

export function createPostgresDurableJobWorkUnitStore<
  TJobPayload,
  TJobProgress,
  TJobResult,
  TUnitPayload,
  TUnitResult,
  TSnapshot = DurableJobPublicSnapshot<TJobProgress, TJobResult>,
>(
  db: PgQueryable,
  tables: DurableJobWorkUnitTables,
  options: DurableJobWorkUnitStoreOptions<TJobPayload, TJobProgress, TJobResult, TSnapshot>,
): DurableJobWorkUnitStore<TJobPayload, TJobProgress, TJobResult, TUnitPayload, TUnitResult> {
  const jobsTable = sqlIdentifier(tables.jobsTable);
  const eventsTable = sqlIdentifier(tables.eventsTable);
  const workUnitsTable = sqlIdentifier(tables.workUnitsTable);
  const notifyChannel = sqlNotifyChannel(tables.notifyChannel ?? "durable_job_events");
  const eventSnapshot =
    options.eventSnapshot ??
    ((job: DurableJobRecord<TJobPayload, TJobProgress, TJobResult>) =>
      toDurableJobPublicSnapshot<TJobPayload, TJobProgress, TJobResult>(job) as TSnapshot);

  async function appendEvent(
    queryable: PgQueryable,
    job: DurableJobRecord<TJobPayload, TJobProgress, TJobResult>,
  ): Promise<void> {
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
    await emitDurableJobWorkSignal(queryable, notifyChannel, "durable-job-work-units", job.jobId, sequence);
  }

  return {
    enqueue: async (input) => {
      if (input.units.length === 0) {
        return 0;
      }

      const result = await db.query(
        `INSERT INTO ${workUnitsTable} (
           job_id,
           unit_id,
           unit_kind,
           state,
           payload,
           created_at,
           updated_at
         )
         SELECT
           $1,
           unit_id,
           unit_kind,
           'queued',
           payload,
           now(),
           now()
         FROM jsonb_to_recordset($2::jsonb) AS unit(unit_id text, unit_kind text, payload jsonb)
         ON CONFLICT (job_id, unit_id) DO NOTHING`,
        [
          input.jobId,
          JSON.stringify(
            input.units.map((unit) => ({
              unit_id: unit.unitId,
              unit_kind: unit.unitKind ?? "default",
              payload: unit.payload,
            })),
          ),
        ],
      );
      return Number(result.rowCount ?? 0);
    },
    claimNext: async (input) => {
      const claimToken = createInternalId("durable-job-claim");
      const workflowMaxActiveClaims = positiveInt(input.workflowMaxActiveClaims);
      const jobMaxActiveClaims = positiveInt(input.jobMaxActiveClaims);
      const jobKinds = input.jobKinds?.length ? [...new Set(input.jobKinds)] : null;
      const laneName = input.laneName ?? null;

      const claim = await runDurableWorkUnitWrite(db, async (queryable) => {
        const result = await queryable.query<ClaimedRow>(
          `WITH workflow_budget AS (
             SELECT count(*)::integer AS active_claims
             FROM ${workUnitsTable}
             WHERE state = 'running'
               AND claimed_until > now()
           ),
           active_by_job AS (
             SELECT job_id, count(*)::integer AS active_claims
             FROM ${workUnitsTable}
             WHERE state = 'running'
               AND claimed_until > now()
             GROUP BY job_id
           ),
           claimable AS (
             SELECT unit.job_id, unit.unit_id
             FROM ${workUnitsTable} AS unit
             JOIN ${jobsTable} AS job
               ON job.job_id = unit.job_id
             LEFT JOIN active_by_job AS active_job
               ON active_job.job_id = unit.job_id
             CROSS JOIN workflow_budget
             WHERE job.status IN ('queued', 'running')
               AND ($6::text[] IS NULL OR job.job_kind = ANY($6::text[]))
               AND (
                 unit.state = 'queued'
                 OR (
                   unit.state = 'running'
                   AND unit.claimed_until <= now()
                 )
               )
               AND workflow_budget.active_claims < $4
               AND coalesce(active_job.active_claims, 0) < $5
             ORDER BY coalesce(active_job.active_claims, 0) ASC, job.created_at ASC, unit.created_at ASC, unit.unit_id ASC
             LIMIT 1
             FOR UPDATE OF unit SKIP LOCKED
           ),
           claimed_unit AS (
             UPDATE ${workUnitsTable} AS unit
             SET state = 'running',
                 claim_owner_id = $1,
                 claim_token = $2,
                 claimed_until = now() + ($3::text || ' milliseconds')::interval,
                 attempt_count = unit.attempt_count + 1,
                 updated_at = now()
             FROM claimable
             WHERE unit.job_id = claimable.job_id
               AND unit.unit_id = claimable.unit_id
             RETURNING unit.job_id, unit.unit_id, ${prefixedWorkUnitColumns("unit")}
           ),
           parent_job AS (
             UPDATE ${jobsTable} AS job
             SET status = 'running',
                 started_at = COALESCE(job.started_at, now()),
                 updated_at = now()
             FROM claimed_unit
             WHERE job.job_id = claimed_unit.job_id
             RETURNING ${prefixedJobColumns("job")}
           )
           SELECT *
           FROM parent_job
           JOIN claimed_unit
             ON claimed_unit.job_id = parent_job.job_job_id`,
          [input.claimOwnerId, claimToken, input.claimTtlMs, workflowMaxActiveClaims, jobMaxActiveClaims, jobKinds],
        );
        const row = result.rows[0];
        if (!row) {
          return null;
        }

        const mapped = mapClaimRow<TJobPayload, TJobProgress, TJobResult, TUnitPayload, TUnitResult>(
          options.workflowName,
          laneName,
          input.claimOwnerId,
          claimToken,
          row,
        );
        await appendEvent(queryable, mapped.job);
        return mapped;
      });

      if (claim) {
        return {
          claim,
          outcome: {
            workflowName: options.workflowName,
            laneName,
            claimed: true,
            reason: "claimed",
            activeClaims: 0,
            workflowMaxActiveClaims,
            jobMaxActiveClaims,
          },
        };
      }

      return {
        claim: null,
        outcome: await resolveClaimMissOutcome(db, workUnitsTable, jobsTable, {
          workflowName: options.workflowName,
          laneName,
          workflowMaxActiveClaims,
          jobMaxActiveClaims,
          jobKinds,
        }),
      };
    },
    renewClaim: async (input) => {
      const result = await db.query(
        `UPDATE ${workUnitsTable}
         SET claimed_until = now() + ($4::text || ' milliseconds')::interval,
             updated_at = now()
         WHERE job_id = $1
           AND unit_id = $2
           AND claim_owner_id = $3
           AND claim_token = $5
           AND state = 'running'
           AND claimed_until > now()`,
        [input.jobId, input.unitId, input.claimOwnerId, input.claimTtlMs, input.claimToken],
      );
      return Number(result.rowCount ?? 0) > 0;
    },
    releaseClaim: async (input) => {
      const result = await db.query(
        `UPDATE ${workUnitsTable}
         SET state = 'queued',
             claim_owner_id = NULL,
             claim_token = NULL,
             claimed_until = NULL,
             updated_at = now()
         WHERE job_id = $1
           AND unit_id = $2
           AND claim_owner_id = $3
           AND claim_token = $4
           AND state = 'running'
           AND claimed_until > now()`,
        [input.jobId, input.unitId, input.claimOwnerId, input.claimToken],
      );
      return Number(result.rowCount ?? 0) > 0;
    },
    recordTerminal: async (input) => {
      return runDurableWorkUnitWrite(db, async (queryable) => {
        const terminalResult = await queryable.query<Readonly<{ job_id: string }>>(
          `WITH terminal_unit AS (
             UPDATE ${workUnitsTable}
             SET state = $5,
                 result = $6::jsonb,
                 error_message = $7,
                 claim_owner_id = NULL,
                 claim_token = NULL,
                 claimed_until = NULL,
                 completed_at = now(),
                 updated_at = now()
             WHERE job_id = $1
               AND unit_id = $2
               AND claim_owner_id = $3
               AND claim_token = $4
               AND state = 'running'
               AND claimed_until > now()
             RETURNING job_id
           )
           SELECT job_id
           FROM terminal_unit`,
          [
            input.jobId,
            input.unitId,
            input.claimOwnerId,
            input.claimToken,
            input.state,
            input.unitResult === undefined ? null : JSON.stringify(input.unitResult),
            input.errorMessage ?? null,
          ],
        );
        if (!terminalResult.rows[0]) {
          return "unit-claim-missing";
        }

        await queryable.query(`SELECT job_id FROM ${jobsTable} WHERE job_id = $1 FOR UPDATE`, [input.jobId]);
        const parentUpdate = input.resolveParentUpdate ? await input.resolveParentUpdate(queryable) : input;
        const result = await queryable.query<PrefixedJobRow>(
          `UPDATE ${jobsTable} AS job
           SET status = CASE WHEN $4::boolean THEN 'completed' ELSE 'running' END,
               progress = $2::jsonb,
               result = COALESCE($3::jsonb, result),
               error_message = CASE WHEN $4::boolean THEN NULL ELSE error_message END,
               claimed_until = NULL,
               completed_at = CASE WHEN $4::boolean THEN now() ELSE completed_at END,
               updated_at = now()
           WHERE job.job_id = $1
             AND job.status IN ('queued', 'running')
           RETURNING ${prefixedJobColumns("job")}`,
          [
            input.jobId,
            JSON.stringify(parentUpdate.parentProgress),
            parentUpdate.parentResult === undefined ? null : JSON.stringify(parentUpdate.parentResult),
            parentUpdate.completeJob === true,
          ],
        );
        const row = result.rows[0];
        if (!row) {
          return "parent-already-terminal";
        }

        const job = mapPrefixedJobRow<TJobPayload, TJobProgress, TJobResult>(row);
        await appendEvent(queryable, job);
        return "recorded";
      });
    },
    reconcileTerminalParent: async (input) => {
      const parent = await runDurableWorkUnitWrite(db, async (queryable) => {
        const lockedJob = await queryable.query<Readonly<{ job_id: string }>>(
          `SELECT job_id
           FROM ${jobsTable}
           WHERE job_id = $1
             AND status IN ('queued', 'running')
           FOR UPDATE`,
          [input.jobId],
        );
        if (!lockedJob.rows[0]) {
          return null;
        }

        const nonTerminal = await queryable.query<Readonly<{ count: number | string }>>(
          `SELECT count(*)::integer AS count
           FROM ${workUnitsTable}
           WHERE job_id = $1
             AND state NOT IN ('completed', 'failed', 'skipped')`,
          [input.jobId],
        );
        if (Number(nonTerminal.rows[0]?.count ?? 0) > 0) {
          return null;
        }

        const parentUpdate = input.resolveParentUpdate ? await input.resolveParentUpdate(queryable) : input;
        const result = await queryable.query<PrefixedJobRow>(
          `UPDATE ${jobsTable} AS job
           SET status = CASE WHEN $4::boolean THEN 'completed' ELSE 'running' END,
               progress = $2::jsonb,
               result = COALESCE($3::jsonb, result),
               error_message = CASE WHEN $4::boolean THEN NULL ELSE error_message END,
               claim_owner_id = NULL,
               claimed_until = NULL,
               completed_at = CASE WHEN $4::boolean THEN now() ELSE completed_at END,
               updated_at = now()
           WHERE job.job_id = $1
           RETURNING ${prefixedJobColumns("job")}`,
          [
            input.jobId,
            JSON.stringify(parentUpdate.parentProgress),
            parentUpdate.parentResult === undefined ? null : JSON.stringify(parentUpdate.parentResult),
            parentUpdate.completeJob === true,
          ],
        );
        const row = result.rows[0];
        if (!row) {
          return null;
        }

        const job = mapPrefixedJobRow<TJobPayload, TJobProgress, TJobResult>(row);
        await appendEvent(queryable, job);
        return job;
      });
      return Boolean(parent);
    },
    listForJob: async (jobId) => {
      const result = await db.query<PrefixedUnitRow>(
        `SELECT ${prefixedWorkUnitColumns("unit")}
         FROM ${workUnitsTable} AS unit
         WHERE unit.job_id = $1
         ORDER BY unit.created_at ASC, unit.unit_id ASC`,
        [jobId],
      );
      return result.rows.map(mapPrefixedUnitRow<TUnitPayload, TUnitResult>);
    },
    summarize: async (input = {}) => summarizeWorkUnits(db, workUnitsTable, options.workflowName, input.jobId ?? null),
  };
}

async function resolveClaimMissOutcome(
  db: PgQueryable,
  workUnitsTable: string,
  jobsTable: string,
  input: Readonly<{
    workflowName: string;
    laneName: string | null;
    workflowMaxActiveClaims: number;
    jobMaxActiveClaims: number;
    jobKinds: readonly string[] | null;
  }>,
): Promise<DurableJobWorkUnitClaimOutcome> {
  const result = await db.query<Readonly<{ pending: number | string; active_claims: number | string }>>(
    `SELECT
       count(*) FILTER (
         WHERE job.status IN ('queued', 'running')
           AND ($1::text[] IS NULL OR job.job_kind = ANY($1::text[]))
           AND (
             unit.state = 'queued'
             OR (
               unit.state = 'running'
               AND unit.claimed_until <= now()
             )
           )
       )::integer AS pending,
       count(*) FILTER (
         WHERE unit.state = 'running'
           AND unit.claimed_until > now()
       )::integer AS active_claims
     FROM ${workUnitsTable} AS unit
     JOIN ${jobsTable} AS job
       ON job.job_id = unit.job_id`,
    [input.jobKinds],
  );
  const activeClaims = Number(result.rows[0]?.active_claims ?? 0);
  const pending = Number(result.rows[0]?.pending ?? 0);
  const reason =
    pending === 0
      ? "none_available"
      : activeClaims >= input.workflowMaxActiveClaims
        ? "workflow_budget_exhausted"
        : "job_budget_exhausted";

  return {
    workflowName: input.workflowName,
    laneName: input.laneName,
    claimed: false,
    reason,
    activeClaims,
    workflowMaxActiveClaims: input.workflowMaxActiveClaims,
    jobMaxActiveClaims: input.jobMaxActiveClaims,
  };
}

async function summarizeWorkUnits(
  db: PgQueryable,
  workUnitsTable: string,
  workflowName: string,
  jobId: string | null,
): Promise<DurableJobWorkUnitSummary> {
  const result = await db.query<SummaryRow>(
    `SELECT
       count(*)::integer AS total,
       count(*) FILTER (WHERE state = 'queued')::integer AS queued,
       count(*) FILTER (WHERE state = 'running')::integer AS running,
       count(*) FILTER (WHERE state = 'completed')::integer AS completed,
       count(*) FILTER (WHERE state = 'failed')::integer AS failed,
       count(*) FILTER (WHERE state = 'skipped')::integer AS skipped,
       count(*) FILTER (WHERE state = 'running' AND claimed_until > now())::integer AS active_claims,
       count(*) FILTER (WHERE state = 'running' AND claimed_until <= now())::integer AS expired_claims
     FROM ${workUnitsTable}
     WHERE ($1::text IS NULL OR job_id = $1)`,
    [jobId],
  );
  const row = result.rows[0];
  return {
    workflowName,
    jobId,
    total: Number(row?.total ?? 0),
    queued: Number(row?.queued ?? 0),
    running: Number(row?.running ?? 0),
    completed: Number(row?.completed ?? 0),
    failed: Number(row?.failed ?? 0),
    skipped: Number(row?.skipped ?? 0),
    activeClaims: Number(row?.active_claims ?? 0),
    expiredClaims: Number(row?.expired_claims ?? 0),
  };
}

function mapClaimRow<TJobPayload, TJobProgress, TJobResult, TUnitPayload, TUnitResult>(
  workflowName: string,
  laneName: string | null,
  claimOwnerId: string,
  claimToken: string,
  row: ClaimedRow,
): DurableJobWorkUnitClaim<TJobPayload, TJobProgress, TJobResult, TUnitPayload, TUnitResult> {
  return {
    workflowName,
    laneName,
    job: mapPrefixedJobRow<TJobPayload, TJobProgress, TJobResult>(row),
    unit: mapPrefixedUnitRow<TUnitPayload, TUnitResult>(row),
    claimOwnerId,
    claimToken,
  };
}

function mapPrefixedJobRow<TPayload, TProgress, TResult>(
  row: PrefixedJobRow,
): DurableJobRecord<TPayload, TProgress, TResult> {
  return {
    jobId: String(row.job_job_id),
    jobKind: String(row.job_job_kind),
    status: row.job_status as DurableJobStatus,
    payload: readJson<TPayload>(row.job_payload),
    progress: readJson<TProgress>(row.job_progress),
    result: row.job_result == null ? null : readJson<TResult>(row.job_result),
    errorMessage: row.job_error_message == null ? null : String(row.job_error_message),
    eventContext: row.job_event_context == null ? null : readJson<EventStoreContext>(row.job_event_context),
    claimOwnerId: row.job_claim_owner_id == null ? null : String(row.job_claim_owner_id),
    claimedUntil: formatNullableTimestamp(row.job_claimed_until as Date | string | null),
    attemptCount: Number(row.job_attempt_count ?? 0),
    nextEligibleAt:
      formatNullableTimestamp((row.job_next_eligible_at ?? row.job_created_at) as Date | string | null) ??
      formatTimestamp(row.job_created_at as Date | string),
    createdAt: formatTimestamp(row.job_created_at as Date | string),
    startedAt: formatNullableTimestamp(row.job_started_at as Date | string | null),
    completedAt: formatNullableTimestamp(row.job_completed_at as Date | string | null),
    updatedAt: formatTimestamp(row.job_updated_at as Date | string),
  };
}

function mapPrefixedUnitRow<TPayload, TResult>(row: PrefixedUnitRow): DurableJobWorkUnitRecord<TPayload, TResult> {
  return {
    jobId: String(row.unit_job_id),
    unitId: String(row.unit_unit_id),
    unitKind: String(row.unit_unit_kind),
    state: row.unit_state as DurableJobWorkUnitState,
    payload: readJson<TPayload>(row.unit_payload),
    result: row.unit_result == null ? null : readJson<TResult>(row.unit_result),
    errorMessage: row.unit_error_message == null ? null : String(row.unit_error_message),
    claimOwnerId: row.unit_claim_owner_id == null ? null : String(row.unit_claim_owner_id),
    claimToken: row.unit_claim_token == null ? null : String(row.unit_claim_token),
    claimedUntil: formatNullableTimestamp(row.unit_claimed_until as Date | string | null),
    attemptCount: Number(row.unit_attempt_count),
    createdAt: formatTimestamp(row.unit_created_at as Date | string),
    updatedAt: formatTimestamp(row.unit_updated_at as Date | string),
    completedAt: formatNullableTimestamp(row.unit_completed_at as Date | string | null),
  };
}

function prefixedJobColumns(alias: string): string {
  return JOB_COLUMNS.map((column) => `${alias}.${column} AS job_${column}`).join(", ");
}

function prefixedWorkUnitColumns(alias: string): string {
  return WORK_UNIT_COLUMNS.map((column) => `${alias}.${column} AS unit_${column}`).join(", ");
}

const JOB_COLUMNS = [
  "job_id",
  "job_kind",
  "status",
  "payload",
  "progress",
  "result",
  "error_message",
  "event_context",
  "claim_owner_id",
  "claimed_until",
  "attempt_count",
  "next_eligible_at",
  "created_at",
  "started_at",
  "completed_at",
  "updated_at",
] as const satisfies readonly (keyof JobRow)[];

const WORK_UNIT_COLUMNS = [
  "job_id",
  "unit_id",
  "unit_kind",
  "state",
  "payload",
  "result",
  "error_message",
  "claim_owner_id",
  "claim_token",
  "claimed_until",
  "attempt_count",
  "created_at",
  "updated_at",
  "completed_at",
] as const satisfies readonly (keyof WorkUnitRow)[];

async function runDurableWorkUnitWrite<T>(db: PgQueryable, work: (queryable: PgQueryable) => Promise<T>): Promise<T> {
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

function positiveInt(value: number): number {
  return Math.max(1, Math.floor(value));
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

function sqlNotifyChannel(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid durable job notify channel: ${value}`);
  }

  return value;
}

function isTransactionalPool(db: PgQueryable): db is PgTransactionalPool {
  return typeof (db as { connect?: unknown }).connect === "function";
}
