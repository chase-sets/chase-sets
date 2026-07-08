import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import type { ReadConsistencyWakeRequest, ReadConsistencyWorkSignalGateway } from "@chase-sets/bounded-context-runtime";
import { withPgTransaction, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  createPostgresWorkSignalWaiter,
  emitPostgresWorkSignalNotification,
  type PostgresWorkSignalWaiter,
} from "./work-signal-composite";

export const PROJECTION_WAKE_INTENT_WORK_SIGNAL_CHANNEL = "platform_projection_wake_intents";
const PROJECTION_WAKE_INTENT_WORK_SIGNAL_SOURCE = "platform-runtime.work-signal-store";

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
export type ProjectionWakeIntentEnqueueOutcome =
  | "created"
  | "coalesced"
  | "requeued_completed"
  | "requeued_expired"
  /**
   * The coalescing-key row is pinned by another transaction's row lock and the
   * bounded enqueue lock wait expired. The enqueue is skipped without error:
   * durable events remain the source of truth and fallback polling still
   * drains the projection, so a lost coalesce extension is safe — but the
   * enqueuer (the relay fan-out loop) must never wedge behind a hung or
   * orphaned lock holder (issue #4649 shape: zombie rows pinned through a
   * deploy-churn window starve claims and cleanup via SKIP LOCKED).
   */
  | "blocked";
export type ProjectionWakeRoutingMode = "safe_over_wake" | "unspecified";

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

export type ProjectionWakeIntentWorkSignalPayload = Readonly<{
  outcome: ProjectionWakeIntentEnqueueOutcome;
  wakeIntentId: string;
  sourceContextName: string;
  targetContextName: string;
  projectionName: string;
  checkpointKey: string;
  requiredPosition: string;
  requiredCursor: string | null;
  priorityLane: WorkSignalPriorityLane;
  origin: WorkSignalWakeOrigin;
  state: ProjectionWakeIntentState;
  nextEligibleAt: string;
}>;

export type ProjectionCheckpointReadyWorkSignalPayload = Readonly<{
  checkpointKey: string;
  sourceContextName: string;
  targetContextName: string;
  projectionName: string;
  readyPosition: string;
  readyCursor: string | null;
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

export type ProjectionWakeIntentBreakdownEntry = Readonly<{
  priorityLane: WorkSignalPriorityLane;
  origin: WorkSignalWakeOrigin;
  state: ProjectionWakeIntentState;
  sourceContextName: string;
  targetContextName: string;
  projectionName: string;
  checkpointKey: string;
  intentCount: number;
  oldestCreatedAt: Date | null;
  maxAttemptCount: number;
}>;

export type CheckpointSignalSummary = Readonly<{
  readinessCount: number;
  expiredReadinessCount: number;
  latestReadyRecordedAt: Date | null;
  pendingWaiterCount: number;
  expiredPendingWaiterCount: number;
  satisfiedWaiterCount: number;
  oldestPendingWaiterAt: Date | null;
  pendingWaiterOrigins: readonly Readonly<{
    origin: WorkSignalWakeOrigin;
    waiterCount: number;
  }>[];
}>;

export type WorkSignalCleanupResult = Readonly<{
  expiredWakeIntents: number;
  prunedWakeIntents: number;
  prunedCheckpointReadiness: number;
  prunedCheckpointWaiters: number;
  /**
   * Wake intents that matched the expiry predicate but survived the expire
   * pass. The expire scan uses `FOR UPDATE SKIP LOCKED`, so a row pinned by
   * another transaction's row lock is skipped silently; a count that stays
   * nonzero across passes means zombie rows are pinned by a hung or orphaned
   * lock holder (kill it via `pg_locks`/`pg_terminate_backend` — see the
   * push-wake operations runbook). Claims skip the same locked rows, so these
   * intents also read as perpetually `queued` starvation in drill evidence.
   */
  immortalWakeIntents: number;
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
  maxAttempts?: number;
  priorityLanes?: readonly WorkSignalPriorityLane[];
  targetContextNames?: readonly string[];
}>;

export type CompleteProjectionWakeIntentInput = Readonly<{
  wakeIntentId: string;
  claimOwnerId: string;
  claimFencingToken: bigint | number | string;
}>;

export type RenewProjectionWakeIntentInput = CompleteProjectionWakeIntentInput &
  Readonly<{
    claimTtlMs: number;
  }>;

export type FailProjectionWakeIntentInput = CompleteProjectionWakeIntentInput &
  Readonly<{
    retryAfterMs: number;
    error?: JsonRecord | null;
  }>;

export type DeferProjectionWakeIntentInput = FailProjectionWakeIntentInput;

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

const DEFAULT_READ_CONSISTENCY_WAITER_TTL_SLACK_MS = 5_000;
const READ_CONSISTENCY_WORK_SIGNAL_REQUESTED_BY = "read-consistency";

export type WorkSignalReadConsistencyWakeEnqueueEvent = Readonly<{
  outcome: "completed" | "failed";
  priorityLane: WorkSignalPriorityLane;
  requestCount: number;
  enqueuedCount: number;
  durationMs: number;
  sourceContextName: string | null;
  targetContextName: string | null;
  projectionName: string | null;
  mountPath: string | null;
  routePath: string | null;
}>;

export type WorkSignalReadConsistencyGatewayObserver = Readonly<{
  wakeEnqueueCompleted?: (event: WorkSignalReadConsistencyWakeEnqueueEvent) => void;
}>;

export type WorkSignalReadConsistencyGatewayOptions = Readonly<{
  priorityLane?: WorkSignalPriorityLane;
  observer?: WorkSignalReadConsistencyGatewayObserver;
  waitForReadinessNotifications?: boolean;
  readinessListenRetryCooldownMs?: number;
  /**
   * Durable waiter rows are reserved for offline diagnostics and future
   * cross-process wait recovery. The API read path consumes checkpoint-ready
   * notifications directly when waitForReadinessNotifications is enabled, so
   * row registration stays off by default.
   */
  registerWaiters?: boolean;
  waiterTtlSlackMs?: number;
}>;

export type WorkSignalStoreOptions = Readonly<{
  defaultWakeTtlMs?: number;
  defaultReadinessTtlMs?: number;
  defaultWaiterTtlMs?: number;
  /**
   * Upper bound on how long an enqueue may wait for the coalescing-key row
   * lock before yielding a `blocked` outcome. Applied as a transaction-local
   * `lock_timeout` when the store runs over a transactional pool.
   */
  enqueueLockTimeoutMs?: number;
  readConsistencyGateway?: WorkSignalReadConsistencyGatewayOptions;
  observer?: WorkSignalStoreObserver;
  now?: () => Date;
}>;

export type ProjectionWakeIntentEnqueuedEvent = Readonly<{
  outcome: ProjectionWakeIntentEnqueueOutcome;
  sourceContextName: string;
  targetContextName: string;
  projectionName: string;
  priorityLane: WorkSignalPriorityLane;
  origin: WorkSignalWakeOrigin;
  routingMode: ProjectionWakeRoutingMode;
}>;

export type WorkSignalStoreObserver = Readonly<{
  projectionWakeIntentEnqueued?: (event: ProjectionWakeIntentEnqueuedEvent) => void;
}>;

export type ProjectionWakeIntentCompletionResult = "completed" | "requeued" | "lost";

export type PostgresWorkSignalStore = Readonly<{
  enqueueProjectionWakeIntent(input: EnqueueProjectionWakeIntentInput): Promise<ProjectionWakeIntentRecord>;
  claimNextProjectionWakeIntent(input: ClaimProjectionWakeIntentInput): Promise<ProjectionWakeIntentRecord | null>;
  renewProjectionWakeIntent(input: RenewProjectionWakeIntentInput): Promise<boolean>;
  completeProjectionWakeIntent(input: CompleteProjectionWakeIntentInput): Promise<ProjectionWakeIntentCompletionResult>;
  deferProjectionWakeIntent(input: DeferProjectionWakeIntentInput): Promise<boolean>;
  failProjectionWakeIntent(input: FailProjectionWakeIntentInput): Promise<boolean>;
  recordCheckpointReady(input: RecordCheckpointReadyInput): Promise<CheckpointReadinessRecord>;
  clearCheckpointReadiness(input: Readonly<{ checkpointKeys: readonly string[] }>): Promise<number>;
  addCheckpointWaiter(input: AddCheckpointWaiterInput): Promise<CheckpointWaiterRecord>;
  cleanupExpiredWorkSignals(input?: CleanupExpiredWorkSignalsInput): Promise<WorkSignalCleanupResult>;
  summarizeProjectionWakeIntents(): Promise<ProjectionWakeIntentSummary>;
  summarizeProjectionWakeIntentBreakdown(): Promise<readonly ProjectionWakeIntentBreakdownEntry[]>;
  summarizeCheckpointSignals(): Promise<CheckpointSignalSummary>;
  readConsistencyGateway?: ReadConsistencyWorkSignalGateway;
}>;

const DEFAULT_WAKE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_READINESS_TTL_MS = 10 * 60 * 1000;
const DEFAULT_WAITER_TTL_MS = 5 * 60 * 1000;
const DEFAULT_WAKE_ENQUEUE_LOCK_TIMEOUT_MS = 2_000;
const POSTGRES_LOCK_NOT_AVAILABLE_CODE = "55P03";
const DEFAULT_CLEANUP_LIMIT = 500;
const MAX_POSTGRES_INTEGER = 2_147_483_647;
const CURRENT_SCHEMA_VERSION = 1;
const CURRENT_PAYLOAD_VERSION = 1;
const CHECKPOINT_READY_WORK_SIGNAL_CHANNEL = "platform_projection_checkpoint_readiness";
const CHECKPOINT_READY_WORK_SIGNAL_SOURCE = "platform-runtime.work-signal-store";

// Durable wake-store rows are an ADR 0010 privacy boundary: wake intents,
// checkpoint readiness, and waiter rows must carry only identifiers, context,
// cursors/positions, versions, and correlation metadata. The relay guards its
// own metadata before enqueueing, but `api-wait`, `reconciliation`, and
// `operator` origins reach this store directly, so the store enforces the
// denylist for every writer (issue #1235). Keys are normalized from camelCase
// to snake_case before matching, so composed keys such as `paymentIntentId`
// or `guestEmailAddress` are caught too — this is a strict superset of the
// emission-side denylists (`SENSITIVE_RELAY_METADATA_KEY_PATTERN` in
// projection-wake-relay.ts, `SENSITIVE_WAKE_NOTIFICATION_KEY_PATTERN` in
// event-core-postgres) for every key those writers send today.
const SENSITIVE_WORK_SIGNAL_METADATA_KEY_PATTERN =
  /(^|_)(email|guest_email|payment|card|pan|cvc|cvv|password|secret|private_payload|provider_payload|event_payload|raw_payload|payload_json|phone|address|tenant_id|user_id|account_id|stream_id|session_id)(_|$)/;
const REDACTED_WORK_SIGNAL_VALUE = "[redacted]";

function isSensitiveWorkSignalMetadataKey(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .toLowerCase();
  return SENSITIVE_WORK_SIGNAL_METADATA_KEY_PATTERN.test(normalized);
}

function assertSafeWorkSignalStoreMetadata(value: unknown, path: readonly string[] = ["metadata"]): void {
  if (value === undefined || value === null) {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSafeWorkSignalStoreMetadata(entry, [...path, String(index)]));
    return;
  }

  if (!isJsonRecord(value)) {
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    const nextPath = [...path, key];
    if (isSensitiveWorkSignalMetadataKey(key)) {
      throw new Error(`Work signal store metadata key '${nextPath.join(".")}' is not allowed.`);
    }
    assertSafeWorkSignalStoreMetadata(nested, nextPath);
  }
}

/**
 * Failure recording must never throw on unsafe error fields (it runs inside
 * failure paths that are already unwinding), so offending keys are redacted
 * instead of rejected.
 */
function redactSensitiveWorkSignalErrorFields(value: JsonRecord | null | undefined): JsonRecord {
  if (!value) {
    return {};
  }

  return redactRecord(value);
}

function redactRecord(record: JsonRecord): JsonRecord {
  return Object.fromEntries(
    Object.entries(record).map(([key, nested]) => [
      key,
      isSensitiveWorkSignalMetadataKey(key) ? REDACTED_WORK_SIGNAL_VALUE : redactValue(nested),
    ]),
  );
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }

  if (isJsonRecord(value)) {
    return redactRecord(value);
  }

  return value;
}

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
  const enqueueLockTimeoutMs = Math.max(
    1,
    Math.floor(options.enqueueLockTimeoutMs ?? DEFAULT_WAKE_ENQUEUE_LOCK_TIMEOUT_MS),
  );
  const checkpointReadyWaiter =
    options.readConsistencyGateway?.waitForReadinessNotifications && isTransactionalPool(db)
      ? createPostgresWorkSignalWaiter(db, {
          channel: CHECKPOINT_READY_WORK_SIGNAL_CHANNEL,
          listenRetryCooldownMs: options.readConsistencyGateway.readinessListenRetryCooldownMs,
        })
      : undefined;

  const store: PostgresWorkSignalStore = {
    async enqueueProjectionWakeIntent(input) {
      assertSafeWorkSignalStoreMetadata(input.metadata);
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

      const runEnqueueUpsert = async (client: PgQueryable) =>
        query<ProjectionWakeIntentEnqueueRow>(
          client,
          `
        WITH existing AS MATERIALIZED (
          SELECT state
          FROM platform_projection_wake_intents
          WHERE coalescing_key = $2
          FOR UPDATE
        ),
        upsert AS (
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
            WHEN platform_projection_wake_intents.state = 'failed'
              AND EXCLUDED.required_position > platform_projection_wake_intents.required_position THEN 'queued'
            ELSE platform_projection_wake_intents.state
          END,
          claim_owner_id = CASE
            WHEN platform_projection_wake_intents.state IN ('completed', 'expired') THEN NULL
            WHEN platform_projection_wake_intents.state = 'failed'
              AND EXCLUDED.required_position > platform_projection_wake_intents.required_position THEN NULL
            ELSE platform_projection_wake_intents.claim_owner_id
          END,
          claimed_until = CASE
            WHEN platform_projection_wake_intents.state IN ('completed', 'expired') THEN NULL
            WHEN platform_projection_wake_intents.state = 'failed'
              AND EXCLUDED.required_position > platform_projection_wake_intents.required_position THEN NULL
            ELSE platform_projection_wake_intents.claimed_until
          END,
          claimed_required_position = CASE
            WHEN platform_projection_wake_intents.state IN ('completed', 'expired') THEN NULL
            WHEN platform_projection_wake_intents.state = 'failed'
              AND EXCLUDED.required_position > platform_projection_wake_intents.required_position THEN NULL
            ELSE platform_projection_wake_intents.claimed_required_position
          END,
          claimed_required_cursor = CASE
            WHEN platform_projection_wake_intents.state IN ('completed', 'expired') THEN NULL
            WHEN platform_projection_wake_intents.state = 'failed'
              AND EXCLUDED.required_position > platform_projection_wake_intents.required_position THEN NULL
            ELSE platform_projection_wake_intents.claimed_required_cursor
          END,
          attempt_count = CASE
            WHEN platform_projection_wake_intents.state = 'failed'
              AND EXCLUDED.required_position > platform_projection_wake_intents.required_position THEN 0
            ELSE platform_projection_wake_intents.attempt_count
          END,
          last_error = CASE
            WHEN platform_projection_wake_intents.state = 'failed'
              AND EXCLUDED.required_position > platform_projection_wake_intents.required_position THEN NULL
            ELSE platform_projection_wake_intents.last_error
          END,
          next_eligible_at = LEAST(platform_projection_wake_intents.next_eligible_at, EXCLUDED.next_eligible_at),
          expires_at = GREATEST(platform_projection_wake_intents.expires_at, EXCLUDED.expires_at),
          completed_at = CASE
            WHEN platform_projection_wake_intents.state IN ('completed', 'expired') THEN NULL
            WHEN platform_projection_wake_intents.state = 'failed'
              AND EXCLUDED.required_position > platform_projection_wake_intents.required_position THEN NULL
            ELSE platform_projection_wake_intents.completed_at
          END,
          updated_at = EXCLUDED.updated_at
        -- For INSERT ... ON CONFLICT, xmax = 0 is Postgres' inserted-row signal.
        RETURNING ${WAKE_INTENT_COLUMNS}, (xmax = 0) AS inserted_by_upsert
        )
        SELECT
          ${prefixColumns("upsert", WAKE_INTENT_COLUMNS)},
          CASE
            WHEN upsert.inserted_by_upsert THEN 'created'
            WHEN existing.state = 'completed' THEN 'requeued_completed'
            WHEN existing.state = 'expired' THEN 'requeued_expired'
            ELSE 'coalesced'
          END AS enqueue_outcome
        FROM upsert
        LEFT JOIN existing ON true
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

      let row: ProjectionWakeIntentEnqueueRow;
      try {
        row = await runWorkSignalWrite(db, async (client) => {
          if (isTransactionalPool(db)) {
            // Bound every lock wait in this transaction. The coalescing-key
            // row can be pinned by a hung or orphaned transaction (deploy
            // churn, half-open connections); without a bound the enqueuer —
            // the relay fan-out loop — wedges indefinitely behind it, halting
            // fan-out for the whole source context. Transaction-local, so it
            // is PgBouncer transaction-pooling safe.
            await query(client, "SELECT set_config('lock_timeout', $1, true)", [`${enqueueLockTimeoutMs}ms`]);
          }
          return requireSingleRow((await runEnqueueUpsert(client)).rows);
        });
      } catch (error) {
        if (!isLockNotAvailableError(error)) {
          throw error;
        }

        // The pinned row already carries a queued/claimed demand for this
        // coalescing key; losing this coalesce extension is safe because
        // durable events remain the source of truth and fallback polling
        // still drains the projection. Read it without locking so the caller
        // gets the durable record plus an explicit `blocked` outcome.
        const existing = await query<ProjectionWakeIntentRow>(
          db,
          `SELECT ${WAKE_INTENT_COLUMNS} FROM platform_projection_wake_intents WHERE coalescing_key = $1`,
          [coalescingKey],
        );
        const existingRow = existing.rows[0];
        if (!existingRow) {
          throw error;
        }

        const blockedRecord = mapProjectionWakeIntentRow(existingRow);
        notifyProjectionWakeIntentEnqueued(options.observer, {
          outcome: "blocked",
          sourceContextName: blockedRecord.sourceContextName,
          targetContextName: blockedRecord.targetContextName,
          projectionName: blockedRecord.projectionName,
          priorityLane: blockedRecord.priorityLane,
          origin: blockedRecord.origin,
          routingMode: workSignalRoutingMode(input.metadata),
        });
        return blockedRecord;
      }

      const record = mapProjectionWakeIntentRow(row);
      await tryEmitProjectionWakeIntentWorkSignal(db, record, row.enqueue_outcome, now);
      notifyProjectionWakeIntentEnqueued(options.observer, {
        outcome: row.enqueue_outcome,
        sourceContextName: record.sourceContextName,
        targetContextName: record.targetContextName,
        projectionName: record.projectionName,
        priorityLane: record.priorityLane,
        origin: record.origin,
        routingMode: workSignalRoutingMode(input.metadata),
      });
      return record;
    },

    async claimNextProjectionWakeIntent(input) {
      if (input.targetContextNames && input.targetContextNames.length === 0) {
        return null;
      }

      const claimedUntil = addMs(now(), Math.max(1, input.claimTtlMs));
      const claimExpiresAt = addMs(claimedUntil, defaultWakeTtlMs);
      const lanes = input.priorityLanes?.length ? [...input.priorityLanes] : ["hot", "standard", "bulk"];
      const targetContextNames = input.targetContextNames?.length ? [...input.targetContextNames] : null;
      const maxAttempts =
        input.maxAttempts === undefined ? MAX_POSTGRES_INTEGER : Math.max(1, Math.floor(input.maxAttempts));
      const result = await query<ProjectionWakeIntentRow>(
        db,
        `
        WITH claimable AS (
          SELECT wake_intent_id
          FROM platform_projection_wake_intents
          WHERE (
              (state = 'queued' AND next_eligible_at <= now())
              OR (state = 'failed' AND attempt_count < $6::integer AND next_eligible_at <= now())
              OR (state = 'claimed' AND attempt_count < $6::integer AND claimed_until <= now())
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
          expires_at = GREATEST(wake.expires_at, $5::timestamptz),
          updated_at = now()
        FROM claimable
        WHERE wake.wake_intent_id = claimable.wake_intent_id
        RETURNING ${prefixColumns("wake", WAKE_INTENT_COLUMNS)}
        `,
        [
          input.claimOwnerId,
          formatTimestamp(claimedUntil),
          lanes,
          targetContextNames,
          formatTimestamp(claimExpiresAt),
          maxAttempts,
        ],
      );

      const row = result.rows[0];
      return row ? mapProjectionWakeIntentRow(row) : null;
    },

    async renewProjectionWakeIntent(input) {
      const claimedUntil = addMs(now(), Math.max(1, input.claimTtlMs));
      const claimExpiresAt = addMs(claimedUntil, defaultWakeTtlMs);
      const result = await query(
        db,
        `
        UPDATE platform_projection_wake_intents
        SET
          claimed_until = $4::timestamptz,
          expires_at = GREATEST(expires_at, $5::timestamptz),
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
          formatTimestamp(claimedUntil),
          formatTimestamp(claimExpiresAt),
        ],
      );

      return (result.rowCount ?? 0) > 0;
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

    async deferProjectionWakeIntent(input) {
      const retryAt = addMs(now(), Math.max(0, input.retryAfterMs));
      const retryExpiresAt = addMs(retryAt, defaultWakeTtlMs);
      const result = await query(
        db,
        `
        UPDATE platform_projection_wake_intents
        SET
          state = 'queued',
          claim_owner_id = NULL,
          claimed_until = NULL,
          claimed_required_position = NULL,
          claimed_required_cursor = NULL,
          attempt_count = GREATEST(attempt_count - 1, 0),
          next_eligible_at = $4::timestamptz,
          last_error = $5::jsonb,
          expires_at = GREATEST(expires_at, $6::timestamptz),
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
          JSON.stringify(redactSensitiveWorkSignalErrorFields(input.error)),
          formatTimestamp(retryExpiresAt),
        ],
      );

      return (result.rowCount ?? 0) > 0;
    },

    async failProjectionWakeIntent(input) {
      const retryAt = addMs(now(), Math.max(0, input.retryAfterMs));
      const retryExpiresAt = addMs(retryAt, defaultWakeTtlMs);
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
          expires_at = GREATEST(expires_at, $6::timestamptz),
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
          JSON.stringify(redactSensitiveWorkSignalErrorFields(input.error)),
          formatTimestamp(retryExpiresAt),
        ],
      );

      return (result.rowCount ?? 0) > 0;
    },

    async recordCheckpointReady(input) {
      assertSafeWorkSignalStoreMetadata(input.metadata);
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

        const record = mapCheckpointReadinessRow(requireSingleRow(result.rows));
        await tryEmitCheckpointReadyWorkSignal(client, record);

        return record;
      });
    },

    async clearCheckpointReadiness(input) {
      if (input.checkpointKeys.length === 0) {
        return 0;
      }

      const result = await query(
        db,
        `
        DELETE FROM platform_projection_checkpoint_readiness
        WHERE checkpoint_key = ANY($1::text[])
        `,
        [[...input.checkpointKeys]],
      );

      return result.rowCount ?? 0;
    },

    async addCheckpointWaiter(input) {
      assertSafeWorkSignalStoreMetadata(input.metadata);
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
            AND (state <> 'claimed' OR claimed_until <= $1::timestamptz)
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

      // Rows that still match the expiry predicate after the expire pass are
      // pinned: the expire scan's FOR UPDATE SKIP LOCKED silently skips rows
      // locked by another transaction, and claims skip the same rows, so a
      // hung or orphaned lock holder turns them into immortal zombies that
      // read as perpetually queued starvation (issue #4649). Count them
      // without locking so operators and drills can tell zombies from
      // ordinary backlog; the runbook remedy is terminating the lock holder.
      const immortalResult = await query<Readonly<{ immortal_count: number }>>(
        db,
        `
        SELECT COUNT(*)::integer AS immortal_count
        FROM platform_projection_wake_intents
        WHERE state IN ('queued', 'claimed', 'failed')
          AND expires_at <= $1::timestamptz
          AND (state <> 'claimed' OR claimed_until <= $1::timestamptz)
        `,
        [formatTimestamp(before)],
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
        immortalWakeIntents: Number(immortalResult.rows[0]?.immortal_count ?? 0),
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

    async summarizeProjectionWakeIntentBreakdown() {
      // Aggregated, structural-only operator summary (ADR 0010 privacy
      // boundary): counts, lanes, origins, states, and ages — never metadata
      // or last_error contents.
      const result = await query<ProjectionWakeIntentBreakdownRow>(
        db,
        `
        SELECT
          priority_lane,
          origin,
          state,
          source_context_name,
          target_context_name,
          projection_name,
          checkpoint_key,
          COUNT(*)::integer AS intent_count,
          MIN(created_at) AS oldest_created_at,
          MAX(attempt_count)::integer AS max_attempt_count
        FROM platform_projection_wake_intents
        GROUP BY priority_lane, origin, state, source_context_name, target_context_name, projection_name, checkpoint_key
        ORDER BY priority_lane, origin, state, source_context_name, target_context_name, projection_name, checkpoint_key
        `,
      );

      return result.rows.map((row) => ({
        priorityLane: row.priority_lane,
        origin: row.origin,
        state: row.state,
        sourceContextName: row.source_context_name,
        targetContextName: row.target_context_name,
        projectionName: row.projection_name,
        checkpointKey: row.checkpoint_key,
        intentCount: Number(row.intent_count),
        oldestCreatedAt: toNullableDate(row.oldest_created_at),
        maxAttemptCount: Number(row.max_attempt_count),
      }));
    },

    async summarizeCheckpointSignals() {
      const readinessResult = await query<CheckpointReadinessSummaryRow>(
        db,
        `
        SELECT
          COUNT(*)::integer AS readiness_count,
          COUNT(*) FILTER (WHERE expires_at <= now())::integer AS expired_readiness_count,
          MAX(recorded_at) AS latest_ready_recorded_at
        FROM platform_projection_checkpoint_readiness
        `,
      );
      const waiterResult = await query<CheckpointWaiterSummaryRow>(
        db,
        `
        SELECT
          COUNT(*) FILTER (WHERE satisfied_at IS NULL)::integer AS pending_waiter_count,
          COUNT(*) FILTER (WHERE satisfied_at IS NULL AND expires_at <= now())::integer AS expired_pending_waiter_count,
          COUNT(*) FILTER (WHERE satisfied_at IS NOT NULL)::integer AS satisfied_waiter_count,
          MIN(created_at) FILTER (WHERE satisfied_at IS NULL) AS oldest_pending_waiter_at
        FROM platform_projection_checkpoint_waiters
        `,
      );
      const waiterOriginResult = await query<CheckpointWaiterOriginRow>(
        db,
        `
        SELECT origin, COUNT(*)::integer AS waiter_count
        FROM platform_projection_checkpoint_waiters
        WHERE satisfied_at IS NULL
        GROUP BY origin
        ORDER BY origin
        `,
      );

      const readinessRow = requireSingleRow(readinessResult.rows);
      const waiterRow = requireSingleRow(waiterResult.rows);
      return {
        readinessCount: Number(readinessRow.readiness_count),
        expiredReadinessCount: Number(readinessRow.expired_readiness_count),
        latestReadyRecordedAt: toNullableDate(readinessRow.latest_ready_recorded_at),
        pendingWaiterCount: Number(waiterRow.pending_waiter_count),
        expiredPendingWaiterCount: Number(waiterRow.expired_pending_waiter_count),
        satisfiedWaiterCount: Number(waiterRow.satisfied_waiter_count),
        oldestPendingWaiterAt: toNullableDate(waiterRow.oldest_pending_waiter_at),
        pendingWaiterOrigins: waiterOriginResult.rows.map((row) => ({
          origin: row.origin,
          waiterCount: Number(row.waiter_count),
        })),
      };
    },
  };

  return options.readConsistencyGateway
    ? {
        ...store,
        readConsistencyGateway: createWorkSignalReadConsistencyGateway(store, {
          ...options.readConsistencyGateway,
          now,
          checkpointReadyWaiter,
        }),
      }
    : store;
}

type WorkSignalReadConsistencyGatewayFactoryOptions = WorkSignalReadConsistencyGatewayOptions &
  Readonly<{
    now: () => Date;
    checkpointReadyWaiter?: PostgresWorkSignalWaiter;
  }>;

/**
 * Adapts the read-consistency middleware's wake-before-wait hooks onto the
 * durable control-plane work-signal store. API processes only write wake
 * intents and waiter rows through pooled queries; they never hold listener
 * connections, and the middleware's bounded durable poll remains the
 * unconditional freshness fallback.
 */
function createWorkSignalReadConsistencyGateway(
  workSignalStore: Pick<PostgresWorkSignalStore, "enqueueProjectionWakeIntent" | "addCheckpointWaiter">,
  options: WorkSignalReadConsistencyGatewayFactoryOptions,
): ReadConsistencyWorkSignalGateway {
  const priorityLane = options.priorityLane ?? "hot";
  const waiterTtlSlackMs = Math.max(
    0,
    Math.floor(options.waiterTtlSlackMs ?? DEFAULT_READ_CONSISTENCY_WAITER_TTL_SLACK_MS),
  );

  return {
    requestWake: async (input) => {
      const startedAt = performance.now();
      let enqueuedCount = 0;
      let outcome: WorkSignalReadConsistencyWakeEnqueueEvent["outcome"] = "completed";
      try {
        for (const request of input.requests) {
          await workSignalStore.enqueueProjectionWakeIntent({
            ...wakeRequestTarget(request),
            requiredPosition: request.requiredPosition,
            priorityLane,
            origin: "api-wait",
            metadata: wakeRequestMetadata(input.metadata),
          });
          enqueuedCount += 1;
        }

        return enqueuedCount;
      } catch (error) {
        outcome = "failed";
        throw error;
      } finally {
        notifyReadConsistencyWakeEnqueueCompleted(options.observer, {
          outcome,
          priorityLane,
          requestCount: input.requests.length,
          enqueuedCount,
          durationMs: performance.now() - startedAt,
          sourceContextName: singleLowCardinalityLabel(input.requests.map((request) => request.sourceContextName)),
          targetContextName: singleLowCardinalityLabel(input.requests.map((request) => request.targetContextName)),
          projectionName: singleLowCardinalityLabel(input.requests.map((request) => request.projectionName)),
          mountPath: metadataString(input.metadata, "mountPath"),
          routePath: singleLowCardinalityLabel(metadataStringArray(input.metadata, "routePaths")),
        });
      }
    },
    ...(options.registerWaiters
      ? {
          registerWaiters: async (
            input: Readonly<{
              requests: readonly ReadConsistencyWakeRequest[];
              timeoutMs: number;
              metadata?: Readonly<Record<string, unknown>>;
            }>,
          ) => {
            const expiresAt = new Date(options.now().getTime() + Math.max(0, input.timeoutMs) + waiterTtlSlackMs);
            for (const request of input.requests) {
              await workSignalStore.addCheckpointWaiter({
                ...wakeRequestTarget(request),
                requiredPosition: request.requiredPosition,
                origin: "api-wait",
                metadata: wakeRequestMetadata(input.metadata),
                expiresAt,
              });
            }
          },
        }
      : {}),
    ...(options.checkpointReadyWaiter
      ? {
          waitForReadiness: async (
            input: Readonly<{
              requests: readonly ReadConsistencyWakeRequest[];
              timeoutMs: number;
            }>,
          ) =>
            options.checkpointReadyWaiter!.wait({
              timeoutMs: input.timeoutMs,
              matches: (notification) =>
                checkpointReadyNotificationMatches(notification.envelope?.payload, input.requests),
            }),
        }
      : {}),
  };
}

function wakeRequestTarget(request: ReadConsistencyWakeRequest) {
  return {
    sourceContextName: request.sourceContextName,
    targetContextName: request.targetContextName,
    projectionName: request.projectionName,
    checkpointKey: request.checkpointKey,
  };
}

function wakeRequestMetadata(metadata: Readonly<Record<string, unknown>> | undefined) {
  return {
    requestedBy: READ_CONSISTENCY_WORK_SIGNAL_REQUESTED_BY,
    ...metadata,
  };
}

function notifyReadConsistencyWakeEnqueueCompleted(
  observer: WorkSignalReadConsistencyGatewayObserver | undefined,
  event: WorkSignalReadConsistencyWakeEnqueueEvent,
): void {
  try {
    observer?.wakeEnqueueCompleted?.(event);
  } catch {
    // Observability must never disrupt freshness waits.
  }
}

function notifyProjectionWakeIntentEnqueued(
  observer: WorkSignalStoreObserver | undefined,
  event: ProjectionWakeIntentEnqueuedEvent,
): void {
  try {
    observer?.projectionWakeIntentEnqueued?.(event);
  } catch {
    // Observability must never disrupt wake enqueue delivery.
  }
}

async function tryEmitCheckpointReadyWorkSignal(
  db: PgQueryable | PgTransactionalPool,
  record: CheckpointReadinessRecord,
): Promise<void> {
  try {
    await emitPostgresWorkSignalNotification<ProjectionCheckpointReadyWorkSignalPayload>(db, {
      channel: CHECKPOINT_READY_WORK_SIGNAL_CHANNEL,
      envelope: {
        kind: "projection.checkpoint-ready",
        source: CHECKPOINT_READY_WORK_SIGNAL_SOURCE,
        correlationId: record.correlationId,
        payload: {
          checkpointKey: record.checkpointKey,
          sourceContextName: record.sourceContextName,
          targetContextName: record.targetContextName,
          projectionName: record.projectionName,
          readyPosition: record.readyPosition.toString(),
          readyCursor: record.readyCursor,
        },
      },
    });
  } catch {
    return;
  }
}

function checkpointReadyNotificationMatches(
  payload: Record<string, unknown> | undefined,
  requests: readonly ReadConsistencyWakeRequest[],
): boolean {
  if (!payload) {
    return false;
  }

  const checkpointKey = typeof payload.checkpointKey === "string" ? payload.checkpointKey : null;
  const sourceContextName = typeof payload.sourceContextName === "string" ? payload.sourceContextName : null;
  const readyPosition = typeof payload.readyPosition === "string" ? payload.readyPosition : null;
  if (!checkpointKey || !sourceContextName || !readyPosition) {
    return false;
  }

  const readyGlobalPosition = tryParseGlobalPosition(readyPosition);
  if (readyGlobalPosition === null) {
    return false;
  }

  return requests.some(
    (request) =>
      request.checkpointKey === checkpointKey &&
      request.sourceContextName === sourceContextName &&
      readyGlobalPosition >= BigInt(request.requiredPosition),
  );
}

function tryParseGlobalPosition(value: string): bigint | null {
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

async function tryEmitProjectionWakeIntentWorkSignal(
  db: PgQueryable | PgTransactionalPool,
  record: ProjectionWakeIntentRecord,
  outcome: ProjectionWakeIntentEnqueueOutcome,
  now: () => Date,
): Promise<void> {
  try {
    await emitPostgresWorkSignalNotification<ProjectionWakeIntentWorkSignalPayload>(db, {
      channel: PROJECTION_WAKE_INTENT_WORK_SIGNAL_CHANNEL,
      now,
      envelope: {
        kind: "projection.wake-intent",
        source: PROJECTION_WAKE_INTENT_WORK_SIGNAL_SOURCE,
        correlationId: record.correlationId,
        payload: {
          outcome,
          wakeIntentId: record.wakeIntentId,
          sourceContextName: record.sourceContextName,
          targetContextName: record.targetContextName,
          projectionName: record.projectionName,
          checkpointKey: record.checkpointKey,
          requiredPosition: record.requiredPosition.toString(),
          requiredCursor: record.requiredCursor,
          priorityLane: record.priorityLane,
          origin: record.origin,
          state: record.state,
          nextEligibleAt: record.nextEligibleAt.toISOString(),
        },
      },
    });
  } catch {
    return;
  }
}

function workSignalRoutingMode(metadata: JsonRecord | undefined): ProjectionWakeRoutingMode {
  return metadata?.projectionWakeRoutingMode === "safe_over_wake" ? "safe_over_wake" : "unspecified";
}

function singleLowCardinalityLabel(values: readonly (string | null | undefined)[]): string | null {
  const uniqueValues = [...new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])].sort(
    (left, right) => left.localeCompare(right),
  );
  if (uniqueValues.length === 0) {
    return null;
  }
  return uniqueValues.length === 1 ? uniqueValues[0] : "multiple";
}

function metadataString(metadata: Readonly<Record<string, unknown>> | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function metadataStringArray(metadata: Readonly<Record<string, unknown>> | undefined, key: string): readonly string[] {
  const value = metadata?.[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function createProjectionWakeIntentCoalescingKey(input: {
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

/**
 * Postgres `lock_not_available` (SQLSTATE 55P03): a bounded `lock_timeout`
 * expired while waiting for a row lock. For wake-intent enqueues this is the
 * pinned-row signal, not a failure — see the `blocked` enqueue outcome.
 */
function isLockNotAvailableError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    (error as Readonly<{ code?: unknown }>).code === POSTGRES_LOCK_NOT_AVAILABLE_CODE,
  );
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

type ProjectionWakeIntentEnqueueRow = ProjectionWakeIntentRow & {
  enqueue_outcome: ProjectionWakeIntentEnqueueOutcome;
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

type ProjectionWakeIntentBreakdownRow = {
  priority_lane: WorkSignalPriorityLane;
  origin: WorkSignalWakeOrigin;
  state: ProjectionWakeIntentState;
  source_context_name: string;
  target_context_name: string;
  projection_name: string;
  checkpoint_key: string;
  intent_count: number | string;
  oldest_created_at: Date | string | null;
  max_attempt_count: number | string;
};

type CheckpointReadinessSummaryRow = {
  readiness_count: number | string;
  expired_readiness_count: number | string;
  latest_ready_recorded_at: Date | string | null;
};

type CheckpointWaiterSummaryRow = {
  pending_waiter_count: number | string;
  expired_pending_waiter_count: number | string;
  satisfied_waiter_count: number | string;
  oldest_pending_waiter_at: Date | string | null;
};

type CheckpointWaiterOriginRow = {
  origin: WorkSignalWakeOrigin;
  waiter_count: number | string;
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
