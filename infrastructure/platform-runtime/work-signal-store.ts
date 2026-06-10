import { randomUUID } from "node:crypto";

import { withPgTransaction, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";

export const platformWorkSignalStoreSchemaSql = `
CREATE TABLE IF NOT EXISTS platform_projection_wake_intents (
  wake_intent_id text PRIMARY KEY,
  coalescing_key text NOT NULL UNIQUE,
  source_context_name text NOT NULL,
  target_context_name text NOT NULL,
  projection_name text NOT NULL,
  checkpoint_key text NOT NULL,
  required_position bigint NOT NULL CHECK (required_position >= 0),
  required_cursor text,
  priority_lane text NOT NULL CHECK (priority_lane IN ('hot', 'standard', 'bulk')),
  origin text NOT NULL CHECK (origin IN ('relay', 'api-wait', 'reconciliation', 'operator')),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  payload_version integer NOT NULL DEFAULT 1 CHECK (payload_version >= 1),
  correlation_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL CHECK (state IN ('queued', 'claimed', 'completed', 'failed', 'expired')),
  claim_owner_id text,
  claim_fencing_token bigint,
  claimed_required_position bigint CHECK (claimed_required_position IS NULL OR claimed_required_position >= 0),
  claimed_required_cursor text,
  claimed_until timestamptz,
  next_eligible_at timestamptz NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_platform_projection_wake_intents_claim_due
  ON platform_projection_wake_intents (priority_lane, next_eligible_at, created_at)
  WHERE state IN ('queued', 'failed');

CREATE INDEX IF NOT EXISTS idx_platform_projection_wake_intents_claim_expired
  ON platform_projection_wake_intents (claimed_until)
  WHERE state = 'claimed';

CREATE INDEX IF NOT EXISTS idx_platform_projection_wake_intents_target
  ON platform_projection_wake_intents (target_context_name, projection_name, source_context_name, state);

CREATE INDEX IF NOT EXISTS idx_platform_projection_wake_intents_expiry
  ON platform_projection_wake_intents (expires_at);

CREATE INDEX IF NOT EXISTS idx_platform_projection_wake_intents_origin_lane
  ON platform_projection_wake_intents (origin, priority_lane, state);

CREATE TABLE IF NOT EXISTS platform_projection_checkpoint_readiness (
  checkpoint_key text NOT NULL,
  source_context_name text NOT NULL,
  target_context_name text NOT NULL,
  projection_name text NOT NULL,
  ready_position bigint NOT NULL CHECK (ready_position >= 0),
  ready_cursor text,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  payload_version integer NOT NULL DEFAULT 1 CHECK (payload_version >= 1),
  correlation_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (checkpoint_key, source_context_name)
);

CREATE INDEX IF NOT EXISTS idx_platform_projection_checkpoint_readiness_target
  ON platform_projection_checkpoint_readiness (target_context_name, projection_name, source_context_name);

CREATE INDEX IF NOT EXISTS idx_platform_projection_checkpoint_readiness_expiry
  ON platform_projection_checkpoint_readiness (expires_at);

CREATE TABLE IF NOT EXISTS platform_projection_checkpoint_waiters (
  waiter_id text PRIMARY KEY,
  checkpoint_key text NOT NULL,
  source_context_name text NOT NULL,
  target_context_name text NOT NULL,
  projection_name text NOT NULL,
  required_position bigint NOT NULL CHECK (required_position >= 0),
  required_cursor text,
  origin text NOT NULL CHECK (origin IN ('relay', 'api-wait', 'reconciliation', 'operator')),
  correlation_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  satisfied_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_platform_projection_checkpoint_waiters_ready
  ON platform_projection_checkpoint_waiters (checkpoint_key, source_context_name, required_position)
  WHERE satisfied_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_platform_projection_checkpoint_waiters_expiry
  ON platform_projection_checkpoint_waiters (expires_at);
`;

export type WorkSignalPriorityLane = "hot" | "standard" | "bulk";
export type WorkSignalWakeOrigin = "relay" | "api-wait" | "reconciliation" | "operator";
export type ProjectionWakeIntentState = "queued" | "claimed" | "completed" | "failed" | "expired";

export type JsonRecord = Record<string, unknown>;

export type ProjectionWakeIntentRecord = Readonly<{
  wakeIntentId: string;
  coalescingKey: string;
  sourceContextName: string;
  targetContextName: string;
  projectionName: string;
  checkpointKey: string;
  requiredPosition: bigint;
  requiredCursor: string | null;
  priorityLane: WorkSignalPriorityLane;
  origin: WorkSignalWakeOrigin;
  schemaVersion: number;
  payloadVersion: number;
  correlationId: string | null;
  metadata: JsonRecord;
  state: ProjectionWakeIntentState;
  claimOwnerId: string | null;
  claimFencingToken: bigint | null;
  claimedRequiredPosition: bigint | null;
  claimedRequiredCursor: string | null;
  claimedUntil: Date | null;
  nextEligibleAt: Date;
  attemptCount: number;
  lastError: JsonRecord | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  completedAt: Date | null;
}>;

export type CheckpointReadinessRecord = Readonly<{
  checkpointKey: string;
  sourceContextName: string;
  targetContextName: string;
  projectionName: string;
  readyPosition: bigint;
  readyCursor: string | null;
  schemaVersion: number;
  payloadVersion: number;
  correlationId: string | null;
  metadata: JsonRecord;
  recordedAt: Date;
  expiresAt: Date;
}>;

export type CheckpointWaiterRecord = Readonly<{
  waiterId: string;
  checkpointKey: string;
  sourceContextName: string;
  targetContextName: string;
  projectionName: string;
  requiredPosition: bigint;
  requiredCursor: string | null;
  origin: WorkSignalWakeOrigin;
  correlationId: string | null;
  metadata: JsonRecord;
  createdAt: Date;
  expiresAt: Date;
  satisfiedAt: Date | null;
}>;

export type ProjectionWakeIntentSummary = Readonly<{
  queuedCount: number;
  claimedCount: number;
  failedCount: number;
  expiredCount: number;
  staleClaimCount: number;
  oldestQueuedAt: Date | null;
  oldestClaimedAt: Date | null;
}>;

export type WorkSignalCleanupResult = Readonly<{
  expiredWakeIntents: number;
  prunedWakeIntents: number;
  prunedCheckpointReadiness: number;
  prunedCheckpointWaiters: number;
}>;

export type EnqueueProjectionWakeIntentInput = Readonly<{
  sourceContextName: string;
  targetContextName: string;
  projectionName: string;
  checkpointKey: string;
  requiredPosition: bigint | number | string;
  requiredCursor?: string | null;
  priorityLane?: WorkSignalPriorityLane;
  origin: WorkSignalWakeOrigin;
  correlationId?: string | null;
  metadata?: JsonRecord;
  coalescingKey?: string;
  schemaVersion?: number;
  payloadVersion?: number;
  nextEligibleAt?: Date | string;
  expiresAt?: Date | string;
}>;

export type ClaimProjectionWakeIntentInput = Readonly<{
  claimOwnerId: string;
  claimTtlMs: number;
  priorityLanes?: readonly WorkSignalPriorityLane[];
  targetContextNames?: readonly string[];
}>;

export type CompleteProjectionWakeIntentInput = Readonly<{
  wakeIntentId: string;
  claimOwnerId: string;
  claimFencingToken: bigint | number | string;
}>;

export type FailProjectionWakeIntentInput = CompleteProjectionWakeIntentInput &
  Readonly<{
    retryAfterMs: number;
    error?: JsonRecord | null;
  }>;

export type RecordCheckpointReadyInput = Readonly<{
  checkpointKey: string;
  sourceContextName: string;
  targetContextName: string;
  projectionName: string;
  readyPosition: bigint | number | string;
  readyCursor?: string | null;
  correlationId?: string | null;
  metadata?: JsonRecord;
  schemaVersion?: number;
  payloadVersion?: number;
  expiresAt?: Date | string;
}>;

export type AddCheckpointWaiterInput = Readonly<{
  checkpointKey: string;
  sourceContextName: string;
  targetContextName: string;
  projectionName: string;
  requiredPosition: bigint | number | string;
  requiredCursor?: string | null;
  origin: WorkSignalWakeOrigin;
  correlationId?: string | null;
  metadata?: JsonRecord;
  waiterId?: string;
  expiresAt?: Date | string;
}>;

export type CleanupExpiredWorkSignalsInput = Readonly<{
  before?: Date | string;
  limit?: number;
}>;

export type WorkSignalStoreOptions = Readonly<{
  defaultWakeTtlMs?: number;
  defaultReadinessTtlMs?: number;
  defaultWaiterTtlMs?: number;
  now?: () => Date;
}>;

export type ProjectionWakeIntentCompletionResult = "completed" | "requeued" | "lost";

export type PostgresWorkSignalStore = Readonly<{
  enqueueProjectionWakeIntent(input: EnqueueProjectionWakeIntentInput): Promise<ProjectionWakeIntentRecord>;
  claimNextProjectionWakeIntent(input: ClaimProjectionWakeIntentInput): Promise<ProjectionWakeIntentRecord | null>;
  completeProjectionWakeIntent(input: CompleteProjectionWakeIntentInput): Promise<ProjectionWakeIntentCompletionResult>;
  failProjectionWakeIntent(input: FailProjectionWakeIntentInput): Promise<boolean>;
  recordCheckpointReady(input: RecordCheckpointReadyInput): Promise<CheckpointReadinessRecord>;
  addCheckpointWaiter(input: AddCheckpointWaiterInput): Promise<CheckpointWaiterRecord>;
  cleanupExpiredWorkSignals(input?: CleanupExpiredWorkSignalsInput): Promise<WorkSignalCleanupResult>;
  summarizeProjectionWakeIntents(): Promise<ProjectionWakeIntentSummary>;
}>;

const DEFAULT_WAKE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_READINESS_TTL_MS = 10 * 60 * 1000;
const DEFAULT_WAITER_TTL_MS = 5 * 60 * 1000;
const DEFAULT_CLEANUP_LIMIT = 500;
const CURRENT_SCHEMA_VERSION = 1;
const CURRENT_PAYLOAD_VERSION = 1;

const WAKE_INTENT_COLUMNS = `
  wake_intent_id,
  coalescing_key,
  source_context_name,
  target_context_name,
  projection_name,
  checkpoint_key,
  required_position,
  required_cursor,
  priority_lane,
  origin,
  schema_version,
  payload_version,
  correlation_id,
  metadata,
  state,
  claim_owner_id,
  claim_fencing_token,
  claimed_required_position,
  claimed_required_cursor,
  claimed_until,
  next_eligible_at,
  attempt_count,
  last_error,
  created_at,
  updated_at,
  expires_at,
  completed_at
`;

const CHECKPOINT_READINESS_COLUMNS = `
  checkpoint_key,
  source_context_name,
  target_context_name,
  projection_name,
  ready_position,
  ready_cursor,
  schema_version,
  payload_version,
  correlation_id,
  metadata,
  recorded_at,
  expires_at
`;

const CHECKPOINT_WAITER_COLUMNS = `
  waiter_id,
  checkpoint_key,
  source_context_name,
  target_context_name,
  projection_name,
  required_position,
  required_cursor,
  origin,
  correlation_id,
  metadata,
  created_at,
  expires_at,
  satisfied_at
`;

export function createPostgresWorkSignalStore(
  db: PgQueryable | PgTransactionalPool,
  options: WorkSignalStoreOptions = {},
): PostgresWorkSignalStore {
  const now = options.now ?? (() => new Date());
  const defaultWakeTtlMs = options.defaultWakeTtlMs ?? DEFAULT_WAKE_TTL_MS;
  const defaultReadinessTtlMs = options.defaultReadinessTtlMs ?? DEFAULT_READINESS_TTL_MS;
  const defaultWaiterTtlMs = options.defaultWaiterTtlMs ?? DEFAULT_WAITER_TTL_MS;

  return {
    async enqueueProjectionWakeIntent(input) {
      const createdAt = now();
      const expiresAt = input.expiresAt ?? addMs(createdAt, defaultWakeTtlMs);
      const nextEligibleAt = input.nextEligibleAt ?? createdAt;
      const priorityLane = input.priorityLane ?? "standard";
      const requiredPosition = toPostgresInteger(input.requiredPosition);
      const coalescingKey =
        input.coalescingKey ??
        createProjectionWakeIntentCoalescingKey({
          sourceContextName: input.sourceContextName,
          targetContextName: input.targetContextName,
          projectionName: input.projectionName,
          checkpointKey: input.checkpointKey,
          priorityLane,
        });

      const result = await query<ProjectionWakeIntentRow>(
        db,
        `
        INSERT INTO platform_projection_wake_intents (
          wake_intent_id,
          coalescing_key,
          source_context_name,
          target_context_name,
          projection_name,
          checkpoint_key,
          required_position,
          required_cursor,
          priority_lane,
          origin,
          schema_version,
          payload_version,
          correlation_id,
          metadata,
          state,
          next_eligible_at,
          expires_at,
          created_at,
          updated_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7::bigint,
          $8,
          $9,
          $10,
          $11,
          $12,
          $13,
          $14::jsonb,
          'queued',
          $15::timestamptz,
          $16::timestamptz,
          $17::timestamptz,
          $17::timestamptz
        )
        ON CONFLICT (coalescing_key)
        DO UPDATE SET
          required_position = GREATEST(platform_projection_wake_intents.required_position, EXCLUDED.required_position),
          required_cursor = CASE
            WHEN EXCLUDED.required_position >= platform_projection_wake_intents.required_position
              THEN EXCLUDED.required_cursor
            ELSE platform_projection_wake_intents.required_cursor
          END,
          schema_version = GREATEST(platform_projection_wake_intents.schema_version, EXCLUDED.schema_version),
          payload_version = GREATEST(platform_projection_wake_intents.payload_version, EXCLUDED.payload_version),
          correlation_id = COALESCE(EXCLUDED.correlation_id, platform_projection_wake_intents.correlation_id),
          metadata = platform_projection_wake_intents.metadata || EXCLUDED.metadata,
          state = CASE
            WHEN platform_projection_wake_intents.state IN ('completed', 'expired') THEN 'queued'
            ELSE platform_projection_wake_intents.state
          END,
          claim_owner_id = CASE
            WHEN platform_projection_wake_intents.state IN ('completed', 'expired') THEN NULL
            ELSE platform_projection_wake_intents.claim_owner_id
          END,
          claimed_until = CASE
            WHEN platform_projection_wake_intents.state IN ('completed', 'expired') THEN NULL
            ELSE platform_projection_wake_intents.claimed_until
          END,
          claimed_required_position = CASE
            WHEN platform_projection_wake_intents.state IN ('completed', 'expired') THEN NULL
            ELSE platform_projection_wake_intents.claimed_required_position
          END,
          claimed_required_cursor = CASE
            WHEN platform_projection_wake_intents.state IN ('completed', 'expired') THEN NULL
            ELSE platform_projection_wake_intents.claimed_required_cursor
          END,
          next_eligible_at = LEAST(platform_projection_wake_intents.next_eligible_at, EXCLUDED.next_eligible_at),
          expires_at = GREATEST(platform_projection_wake_intents.expires_at, EXCLUDED.expires_at),
          completed_at = CASE
            WHEN platform_projection_wake_intents.state IN ('completed', 'expired') THEN NULL
            ELSE platform_projection_wake_intents.completed_at
          END,
          updated_at = EXCLUDED.updated_at
        RETURNING ${WAKE_INTENT_COLUMNS}
        `,
        [
          `projection-wake-${randomUUID()}`,
          coalescingKey,
          input.sourceContextName,
          input.targetContextName,
          input.projectionName,
          input.checkpointKey,
          requiredPosition,
          input.requiredCursor ?? null,
          priorityLane,
          input.origin,
          input.schemaVersion ?? CURRENT_SCHEMA_VERSION,
          input.payloadVersion ?? CURRENT_PAYLOAD_VERSION,
          input.correlationId ?? null,
          JSON.stringify(input.metadata ?? {}),
          formatTimestamp(nextEligibleAt),
          formatTimestamp(expiresAt),
          formatTimestamp(createdAt),
        ],
      );

      return mapProjectionWakeIntentRow(requireSingleRow(result.rows));
    },

    async claimNextProjectionWakeIntent(input) {
      if (input.targetContextNames && input.targetContextNames.length === 0) {
        return null;
      }

      const claimedUntil = addMs(now(), Math.max(1, input.claimTtlMs));
      const lanes = input.priorityLanes?.length ? [...input.priorityLanes] : ["hot", "standard", "bulk"];
      const targetContextNames = input.targetContextNames?.length ? [...input.targetContextNames] : null;
      const result = await query<ProjectionWakeIntentRow>(
        db,
        `
        WITH claimable AS (
          SELECT wake_intent_id
          FROM platform_projection_wake_intents
          WHERE (
              (state IN ('queued', 'failed') AND next_eligible_at <= now())
              OR (state = 'claimed' AND claimed_until <= now())
            )
            AND expires_at > now()
            AND priority_lane = ANY($3::text[])
            AND ($4::text[] IS NULL OR target_context_name = ANY($4::text[]))
          ORDER BY
            CASE priority_lane
              WHEN 'hot' THEN 0
              WHEN 'standard' THEN 1
              ELSE 2
            END,
            next_eligible_at,
            created_at
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE platform_projection_wake_intents wake
        SET
          state = 'claimed',
          claim_owner_id = $1,
          claim_fencing_token = COALESCE(wake.claim_fencing_token, 0) + 1,
          claimed_required_position = wake.required_position,
          claimed_required_cursor = wake.required_cursor,
          claimed_until = $2::timestamptz,
          attempt_count = wake.attempt_count + 1,
          updated_at = now()
        FROM claimable
        WHERE wake.wake_intent_id = claimable.wake_intent_id
        RETURNING ${prefixColumns("wake", WAKE_INTENT_COLUMNS)}
        `,
        [input.claimOwnerId, formatTimestamp(claimedUntil), lanes, targetContextNames],
      );

      const row = result.rows[0];
      return row ? mapProjectionWakeIntentRow(row) : null;
    },

    async completeProjectionWakeIntent(input) {
      const result = await query<Readonly<{ state: ProjectionWakeIntentState }>>(
        db,
        `
        UPDATE platform_projection_wake_intents
        SET
          state = CASE
            WHEN required_position > COALESCE(claimed_required_position, required_position) THEN 'queued'
            ELSE 'completed'
          END,
          claim_owner_id = NULL,
          claimed_until = NULL,
          claimed_required_position = NULL,
          claimed_required_cursor = NULL,
          next_eligible_at = CASE
            WHEN required_position > COALESCE(claimed_required_position, required_position) THEN now()
            ELSE next_eligible_at
          END,
          completed_at = CASE
            WHEN required_position > COALESCE(claimed_required_position, required_position) THEN NULL
            ELSE now()
          END,
          updated_at = now()
        WHERE wake_intent_id = $1
          AND state = 'claimed'
          AND claim_owner_id = $2
          AND claim_fencing_token = $3::bigint
          AND claimed_until > now()
        RETURNING state
        `,
        [input.wakeIntentId, input.claimOwnerId, toPostgresInteger(input.claimFencingToken)],
      );

      const row = result.rows[0];
      if (!row) {
        return "lost";
      }

      return row.state === "queued" ? "requeued" : "completed";
    },

    async failProjectionWakeIntent(input) {
      const retryAt = addMs(now(), Math.max(0, input.retryAfterMs));
      const result = await query(
        db,
        `
        UPDATE platform_projection_wake_intents
        SET
          state = 'failed',
          claim_owner_id = NULL,
          claimed_until = NULL,
          claimed_required_position = NULL,
          claimed_required_cursor = NULL,
          next_eligible_at = $4::timestamptz,
          last_error = $5::jsonb,
          updated_at = now()
        WHERE wake_intent_id = $1
          AND state = 'claimed'
          AND claim_owner_id = $2
          AND claim_fencing_token = $3::bigint
          AND claimed_until > now()
        `,
        [
          input.wakeIntentId,
          input.claimOwnerId,
          toPostgresInteger(input.claimFencingToken),
          formatTimestamp(retryAt),
          JSON.stringify(input.error ?? {}),
        ],
      );

      return (result.rowCount ?? 0) > 0;
    },

    async recordCheckpointReady(input) {
      const recordedAt = now();
      const expiresAt = input.expiresAt ?? addMs(recordedAt, defaultReadinessTtlMs);
      const readyPosition = toPostgresInteger(input.readyPosition);

      return runWorkSignalWrite(db, async (client) => {
        const result = await query<CheckpointReadinessRow>(
          client,
          `
          INSERT INTO platform_projection_checkpoint_readiness (
            checkpoint_key,
            source_context_name,
            target_context_name,
            projection_name,
            ready_position,
            ready_cursor,
            schema_version,
            payload_version,
            correlation_id,
            metadata,
            recorded_at,
            expires_at
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5::bigint,
            $6,
            $7,
            $8,
            $9,
            $10::jsonb,
            $11::timestamptz,
            $12::timestamptz
          )
          ON CONFLICT (checkpoint_key, source_context_name)
          DO UPDATE SET
            target_context_name = EXCLUDED.target_context_name,
            projection_name = EXCLUDED.projection_name,
            ready_position = GREATEST(
              platform_projection_checkpoint_readiness.ready_position,
              EXCLUDED.ready_position
            ),
            ready_cursor = CASE
              WHEN EXCLUDED.ready_position >= platform_projection_checkpoint_readiness.ready_position
                THEN EXCLUDED.ready_cursor
              ELSE platform_projection_checkpoint_readiness.ready_cursor
            END,
            schema_version = GREATEST(
              platform_projection_checkpoint_readiness.schema_version,
              EXCLUDED.schema_version
            ),
            payload_version = GREATEST(
              platform_projection_checkpoint_readiness.payload_version,
              EXCLUDED.payload_version
            ),
            correlation_id = COALESCE(EXCLUDED.correlation_id, platform_projection_checkpoint_readiness.correlation_id),
            metadata = platform_projection_checkpoint_readiness.metadata || EXCLUDED.metadata,
            recorded_at = EXCLUDED.recorded_at,
            expires_at = GREATEST(platform_projection_checkpoint_readiness.expires_at, EXCLUDED.expires_at)
          RETURNING ${CHECKPOINT_READINESS_COLUMNS}
          `,
          [
            input.checkpointKey,
            input.sourceContextName,
            input.targetContextName,
            input.projectionName,
            readyPosition,
            input.readyCursor ?? null,
            input.schemaVersion ?? CURRENT_SCHEMA_VERSION,
            input.payloadVersion ?? CURRENT_PAYLOAD_VERSION,
            input.correlationId ?? null,
            JSON.stringify(input.metadata ?? {}),
            formatTimestamp(recordedAt),
            formatTimestamp(expiresAt),
          ],
        );

        await query(
          client,
          `
          UPDATE platform_projection_checkpoint_waiters
          SET satisfied_at = COALESCE(satisfied_at, now())
          WHERE checkpoint_key = $1
            AND source_context_name = $2
            AND required_position <= $3::bigint
            AND expires_at > now()
            AND satisfied_at IS NULL
          `,
          [input.checkpointKey, input.sourceContextName, readyPosition],
        );

        return mapCheckpointReadinessRow(requireSingleRow(result.rows));
      });
    },

    async addCheckpointWaiter(input) {
      const createdAt = now();
      const expiresAt = input.expiresAt ?? addMs(createdAt, defaultWaiterTtlMs);
      const waiterId = input.waiterId ?? `projection-checkpoint-waiter-${randomUUID()}`;
      const requiredPosition = toPostgresInteger(input.requiredPosition);

      return runWorkSignalWrite(db, async (client) => {
        await query(
          client,
          `
          INSERT INTO platform_projection_checkpoint_waiters (
            waiter_id,
            checkpoint_key,
            source_context_name,
            target_context_name,
            projection_name,
            required_position,
            required_cursor,
            origin,
            correlation_id,
            metadata,
            created_at,
            expires_at
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6::bigint,
            $7,
            $8,
            $9,
            $10::jsonb,
            $11::timestamptz,
            $12::timestamptz
          )
          ON CONFLICT (waiter_id)
          DO UPDATE SET
            required_position = GREATEST(
              platform_projection_checkpoint_waiters.required_position,
              EXCLUDED.required_position
            ),
            required_cursor = CASE
              WHEN EXCLUDED.required_position >= platform_projection_checkpoint_waiters.required_position
                THEN EXCLUDED.required_cursor
              ELSE platform_projection_checkpoint_waiters.required_cursor
            END,
            correlation_id = COALESCE(EXCLUDED.correlation_id, platform_projection_checkpoint_waiters.correlation_id),
            metadata = platform_projection_checkpoint_waiters.metadata || EXCLUDED.metadata,
            expires_at = GREATEST(platform_projection_checkpoint_waiters.expires_at, EXCLUDED.expires_at)
          `,
          [
            waiterId,
            input.checkpointKey,
            input.sourceContextName,
            input.targetContextName,
            input.projectionName,
            requiredPosition,
            input.requiredCursor ?? null,
            input.origin,
            input.correlationId ?? null,
            JSON.stringify(input.metadata ?? {}),
            formatTimestamp(createdAt),
            formatTimestamp(expiresAt),
          ],
        );

        await query(
          client,
          `
          UPDATE platform_projection_checkpoint_waiters waiters
          SET satisfied_at = COALESCE(waiters.satisfied_at, now())
          FROM platform_projection_checkpoint_readiness readiness
          WHERE waiters.waiter_id = $1
            AND readiness.checkpoint_key = waiters.checkpoint_key
            AND readiness.source_context_name = waiters.source_context_name
            AND readiness.ready_position >= waiters.required_position
            AND readiness.expires_at > now()
          `,
          [waiterId],
        );

        const result = await query<CheckpointWaiterRow>(
          client,
          `
          SELECT ${CHECKPOINT_WAITER_COLUMNS}
          FROM platform_projection_checkpoint_waiters
          WHERE waiter_id = $1
          `,
          [waiterId],
        );

        return mapCheckpointWaiterRow(requireSingleRow(result.rows));
      });
    },

    async cleanupExpiredWorkSignals(input = {}) {
      const before = input.before ?? now();
      const limit = Math.max(1, Math.min(input.limit ?? DEFAULT_CLEANUP_LIMIT, 10_000));

      const expiredWakeIntents = await query(
        db,
        `
        WITH expired AS (
          SELECT wake_intent_id
          FROM platform_projection_wake_intents
          WHERE state IN ('queued', 'claimed', 'failed')
            AND expires_at <= $1::timestamptz
          ORDER BY expires_at
          LIMIT $2
          FOR UPDATE SKIP LOCKED
        )
        UPDATE platform_projection_wake_intents wake
        SET
          state = 'expired',
          claim_owner_id = NULL,
          claimed_until = NULL,
          claimed_required_position = NULL,
          claimed_required_cursor = NULL,
          updated_at = now()
        FROM expired
        WHERE wake.wake_intent_id = expired.wake_intent_id
        `,
        [formatTimestamp(before), limit],
      );

      const prunedWakeIntents = await query(
        db,
        `
        WITH doomed AS (
          SELECT ctid
          FROM platform_projection_wake_intents
          WHERE state IN ('completed', 'expired')
            AND expires_at <= $1::timestamptz
          ORDER BY expires_at
          LIMIT $2
        )
        DELETE FROM platform_projection_wake_intents wake
        USING doomed
        WHERE wake.ctid = doomed.ctid
        `,
        [formatTimestamp(before), limit],
      );

      const prunedCheckpointReadiness = await query(
        db,
        `
        WITH doomed AS (
          SELECT ctid
          FROM platform_projection_checkpoint_readiness
          WHERE expires_at <= $1::timestamptz
          ORDER BY expires_at
          LIMIT $2
        )
        DELETE FROM platform_projection_checkpoint_readiness readiness
        USING doomed
        WHERE readiness.ctid = doomed.ctid
        `,
        [formatTimestamp(before), limit],
      );

      const prunedCheckpointWaiters = await query(
        db,
        `
        WITH doomed AS (
          SELECT ctid
          FROM platform_projection_checkpoint_waiters
          WHERE expires_at <= $1::timestamptz
            OR satisfied_at <= $1::timestamptz
          ORDER BY expires_at
          LIMIT $2
        )
        DELETE FROM platform_projection_checkpoint_waiters waiters
        USING doomed
        WHERE waiters.ctid = doomed.ctid
        `,
        [formatTimestamp(before), limit],
      );

      return {
        expiredWakeIntents: expiredWakeIntents.rowCount ?? 0,
        prunedWakeIntents: prunedWakeIntents.rowCount ?? 0,
        prunedCheckpointReadiness: prunedCheckpointReadiness.rowCount ?? 0,
        prunedCheckpointWaiters: prunedCheckpointWaiters.rowCount ?? 0,
      };
    },

    async summarizeProjectionWakeIntents() {
      const result = await query<ProjectionWakeIntentSummaryRow>(
        db,
        `
        SELECT
          COUNT(*) FILTER (WHERE state = 'queued')::integer AS queued_count,
          COUNT(*) FILTER (WHERE state = 'claimed')::integer AS claimed_count,
          COUNT(*) FILTER (WHERE state = 'failed')::integer AS failed_count,
          COUNT(*) FILTER (WHERE state = 'expired')::integer AS expired_count,
          COUNT(*) FILTER (WHERE state = 'claimed' AND claimed_until <= now())::integer AS stale_claim_count,
          MIN(created_at) FILTER (WHERE state = 'queued') AS oldest_queued_at,
          MIN(claimed_until) FILTER (WHERE state = 'claimed') AS oldest_claimed_at
        FROM platform_projection_wake_intents
        `,
      );

      const row = requireSingleRow(result.rows);
      return {
        queuedCount: Number(row.queued_count),
        claimedCount: Number(row.claimed_count),
        failedCount: Number(row.failed_count),
        expiredCount: Number(row.expired_count),
        staleClaimCount: Number(row.stale_claim_count),
        oldestQueuedAt: toNullableDate(row.oldest_queued_at),
        oldestClaimedAt: toNullableDate(row.oldest_claimed_at),
      };
    },
  };
}

export function createProjectionWakeIntentCoalescingKey(input: {
  sourceContextName: string;
  targetContextName: string;
  projectionName: string;
  checkpointKey: string;
  priorityLane: WorkSignalPriorityLane;
}): string {
  return [
    "projection-wake",
    input.sourceContextName,
    input.targetContextName,
    input.projectionName,
    input.checkpointKey,
    input.priorityLane,
  ].join(":");
}

async function runWorkSignalWrite<T>(
  db: PgQueryable | PgTransactionalPool,
  operation: (client: PgQueryable) => Promise<T>,
): Promise<T> {
  if (!isTransactionalPool(db)) {
    return operation(db);
  }

  return withPgTransaction(db, operation);
}

function isTransactionalPool(db: PgQueryable | PgTransactionalPool): db is PgTransactionalPool {
  return typeof (db as PgTransactionalPool).connect === "function";
}

async function query<T extends object = Record<string, unknown>>(
  db: PgQueryable,
  sql: string,
  params: readonly unknown[] = [],
): Promise<{ rows: T[]; rowCount?: number | null }> {
  return db.query<T>(sql, params);
}

function addMs(value: Date, ms: number): Date {
  return new Date(value.getTime() + ms);
}

function formatTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toPostgresInteger(value: bigint | number | string): string {
  return value.toString();
}

function toBigInt(value: bigint | number | string): bigint {
  return typeof value === "bigint" ? value : BigInt(value);
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toNullableDate(value: Date | string | null): Date | null {
  return value === null ? null : toDate(value);
}

function readJsonRecord(value: unknown): JsonRecord {
  if (typeof value === "string") {
    const parsed = JSON.parse(value) as unknown;
    return isJsonRecord(parsed) ? parsed : {};
  }

  return isJsonRecord(value) ? value : {};
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireSingleRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (!row) {
    throw new Error("Expected work signal store query to return a row.");
  }

  return row;
}

function prefixColumns(alias: string, columns: string): string {
  return columns
    .split(",")
    .map((column) => column.trim())
    .filter(Boolean)
    .map((column) => `${alias}.${column}`)
    .join(",\n          ");
}

type ProjectionWakeIntentRow = {
  wake_intent_id: string;
  coalescing_key: string;
  source_context_name: string;
  target_context_name: string;
  projection_name: string;
  checkpoint_key: string;
  required_position: string | number | bigint;
  required_cursor: string | null;
  priority_lane: WorkSignalPriorityLane;
  origin: WorkSignalWakeOrigin;
  schema_version: number;
  payload_version: number;
  correlation_id: string | null;
  metadata: unknown;
  state: ProjectionWakeIntentState;
  claim_owner_id: string | null;
  claim_fencing_token: string | number | bigint | null;
  claimed_required_position: string | number | bigint | null;
  claimed_required_cursor: string | null;
  claimed_until: Date | string | null;
  next_eligible_at: Date | string;
  attempt_count: number;
  last_error: unknown;
  created_at: Date | string;
  updated_at: Date | string;
  expires_at: Date | string;
  completed_at: Date | string | null;
};

type CheckpointReadinessRow = {
  checkpoint_key: string;
  source_context_name: string;
  target_context_name: string;
  projection_name: string;
  ready_position: string | number | bigint;
  ready_cursor: string | null;
  schema_version: number;
  payload_version: number;
  correlation_id: string | null;
  metadata: unknown;
  recorded_at: Date | string;
  expires_at: Date | string;
};

type CheckpointWaiterRow = {
  waiter_id: string;
  checkpoint_key: string;
  source_context_name: string;
  target_context_name: string;
  projection_name: string;
  required_position: string | number | bigint;
  required_cursor: string | null;
  origin: WorkSignalWakeOrigin;
  correlation_id: string | null;
  metadata: unknown;
  created_at: Date | string;
  expires_at: Date | string;
  satisfied_at: Date | string | null;
};

type ProjectionWakeIntentSummaryRow = {
  queued_count: number | string;
  claimed_count: number | string;
  failed_count: number | string;
  expired_count: number | string;
  stale_claim_count: number | string;
  oldest_queued_at: Date | string | null;
  oldest_claimed_at: Date | string | null;
};

function mapProjectionWakeIntentRow(row: ProjectionWakeIntentRow): ProjectionWakeIntentRecord {
  return {
    wakeIntentId: row.wake_intent_id,
    coalescingKey: row.coalescing_key,
    sourceContextName: row.source_context_name,
    targetContextName: row.target_context_name,
    projectionName: row.projection_name,
    checkpointKey: row.checkpoint_key,
    requiredPosition: toBigInt(row.required_position),
    requiredCursor: row.required_cursor,
    priorityLane: row.priority_lane,
    origin: row.origin,
    schemaVersion: row.schema_version,
    payloadVersion: row.payload_version,
    correlationId: row.correlation_id,
    metadata: readJsonRecord(row.metadata),
    state: row.state,
    claimOwnerId: row.claim_owner_id,
    claimFencingToken: row.claim_fencing_token === null ? null : toBigInt(row.claim_fencing_token),
    claimedRequiredPosition: row.claimed_required_position === null ? null : toBigInt(row.claimed_required_position),
    claimedRequiredCursor: row.claimed_required_cursor,
    claimedUntil: toNullableDate(row.claimed_until),
    nextEligibleAt: toDate(row.next_eligible_at),
    attemptCount: row.attempt_count,
    lastError: row.last_error === null ? null : readJsonRecord(row.last_error),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    expiresAt: toDate(row.expires_at),
    completedAt: toNullableDate(row.completed_at),
  };
}

function mapCheckpointReadinessRow(row: CheckpointReadinessRow): CheckpointReadinessRecord {
  return {
    checkpointKey: row.checkpoint_key,
    sourceContextName: row.source_context_name,
    targetContextName: row.target_context_name,
    projectionName: row.projection_name,
    readyPosition: toBigInt(row.ready_position),
    readyCursor: row.ready_cursor,
    schemaVersion: row.schema_version,
    payloadVersion: row.payload_version,
    correlationId: row.correlation_id,
    metadata: readJsonRecord(row.metadata),
    recordedAt: toDate(row.recorded_at),
    expiresAt: toDate(row.expires_at),
  };
}

function mapCheckpointWaiterRow(row: CheckpointWaiterRow): CheckpointWaiterRecord {
  return {
    waiterId: row.waiter_id,
    checkpointKey: row.checkpoint_key,
    sourceContextName: row.source_context_name,
    targetContextName: row.target_context_name,
    projectionName: row.projection_name,
    requiredPosition: toBigInt(row.required_position),
    requiredCursor: row.required_cursor,
    origin: row.origin,
    correlationId: row.correlation_id,
    metadata: readJsonRecord(row.metadata),
    createdAt: toDate(row.created_at),
    expiresAt: toDate(row.expires_at),
    satisfiedAt: toNullableDate(row.satisfied_at),
  };
}
