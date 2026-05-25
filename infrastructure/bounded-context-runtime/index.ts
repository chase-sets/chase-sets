import type {
  BcApiModule,
  BcApiMount,
  BcEventSubscription,
  BcSeedOptions,
  EnvironmentDataProfile,
  BcProjectionGroup,
  BcProjector,
} from "@chase-sets/bounded-context-module";
import type {
  ProjectionBlockedStream,
  ProjectionErrorSummary,
  ProjectionPoisonEvent,
  ProjectionRunContext,
  ProjectorHandler,
  ProjectorRunResult,
} from "@chase-sets/event-core/projector";
import {
  getEventCommitMetadata,
  isTransientProjectionError,
  runWithEventCommitMetadata,
  ZERO_GLOBAL_POSITION,
  toTransportEvent,
} from "@chase-sets/event-core";
import { parseGlobalPosition, type GlobalPosition, type StreamVersion } from "@chase-sets/event-core/storage";
import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  eventCorePostgresSchemaSql,
  withPgTransaction,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";

const RETRY_DELAY_MS = 1_000;
const MAX_RETRIES = 30;
const PROJECTION_STATUS_REFRESH_CONCURRENCY = 4;
const SUBSCRIPTION_APPLICATION_LEDGER_RETAIN_APPLIED_EVENTS = 10_000n;
const SUBSCRIPTION_CHECKPOINTS_TABLE = "event_subscription_checkpoints";
const PROJECTION_GROUP_REVISIONS_TABLE = "event_projection_group_revisions";
const SQL_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const allEnvironmentDataProfiles: readonly EnvironmentDataProfile[] = [
  "critical-bootstrap",
  "catalog-integration-bootstrap",
  "scenario-seed",
];

export const defaultSeedOptions: BcSeedOptions = {
  enabledDataProfiles: allEnvironmentDataProfiles,
  environmentName: null,
};

export function seedProfileEnabled(options: BcSeedOptions | undefined, profile: EnvironmentDataProfile): boolean {
  return (options ?? defaultSeedOptions).enabledDataProfiles.includes(profile);
}

export function seedProfilesOverlap(
  moduleProfiles: readonly EnvironmentDataProfile[] | undefined,
  options: BcSeedOptions | undefined,
): boolean {
  const profiles = moduleProfiles ?? ["scenario-seed"];
  const enabledProfiles = (options ?? defaultSeedOptions).enabledDataProfiles;

  return profiles.some((profile) => enabledProfiles.includes(profile));
}

export const eventSubscriptionSchemaSql = `CREATE TABLE IF NOT EXISTS ${SUBSCRIPTION_CHECKPOINTS_TABLE} (
  checkpoint_key text PRIMARY KEY,
  projection_name text NOT NULL,
  source_context_name text NOT NULL,
  subscription_version integer NOT NULL CHECK (subscription_version >= 1),
  last_global_position bigint NOT NULL CHECK (last_global_position >= 0),
  updated_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ${SUBSCRIPTION_CHECKPOINTS_TABLE}_projection_source_version_idx
  ON ${SUBSCRIPTION_CHECKPOINTS_TABLE} (projection_name, source_context_name, subscription_version);

CREATE TABLE IF NOT EXISTS ${PROJECTION_GROUP_REVISIONS_TABLE} (
  target_context_name text NOT NULL,
  projection_name text NOT NULL,
  projection_revision integer NOT NULL CHECK (projection_revision >= 1),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (target_context_name, projection_name)
);

CREATE TABLE IF NOT EXISTS event_subscription_applications (
  projection_key text NOT NULL,
  event_id text NOT NULL,
  stream_id text NOT NULL,
  stream_version bigint NOT NULL CHECK (stream_version > 0),
  global_position bigint NOT NULL CHECK (global_position >= 0),
  event_type text NOT NULL,
  status text NOT NULL CHECK (status IN ('started', 'applied', 'poison', 'transient')),
  error_message text NULL,
  started_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (projection_key, event_id)
);

CREATE INDEX IF NOT EXISTS event_subscription_applications_projection_position_idx
  ON event_subscription_applications (projection_key, global_position);

CREATE INDEX IF NOT EXISTS event_subscription_applications_projection_status_updated_idx
  ON event_subscription_applications (projection_key, status, updated_at);

CREATE INDEX IF NOT EXISTS event_subscription_applications_status_position_idx
  ON event_subscription_applications (status, global_position);`;

export type SubscriptionReplayState = "idle" | "behind" | "running" | "caught-up" | "degraded" | "error";

export type ContextSubscriptionStatus = Readonly<{
  checkpointKey: string;
  subscriptionName: string;
  projectionName: string;
  sourceContextName: string;
  targetContextName: string;
  subscriptionVersion: number;
  initialized: boolean;
  lastGlobalPosition: GlobalPosition;
  sourceHeadGlobalPosition: GlobalPosition;
  outstandingEventCount: string;
  processedEvents: number;
  state: SubscriptionReplayState;
  lastError: string | null;
  blockedStreamCount: number;
  poisonEventCount: number;
  updatedAt: string;
}>;

export type ContextProjectionGroupStatus = Readonly<{
  projectionName: string;
  projectionRevision: number;
  storedProjectionRevision: number | null;
  revisionStale: boolean;
  targetContextName: string;
  sourceContextNames: readonly string[];
  ownedTables: readonly string[];
  requiredDuringBootstrap: boolean;
  initialized: boolean;
  caughtUp: boolean;
  state: SubscriptionReplayState;
  lastError: string | null;
  outstandingEventCount: string;
  blockedStreamCount: number;
  poisonEventCount: number;
  updatedAt: string;
  subscriptions: readonly ContextSubscriptionStatus[];
}>;

export type ProjectionReplayContextSummary = Readonly<{
  contextName: string;
  totalGroups: number;
  requiredGroups: number;
  initializedGroups: number;
  caughtUpGroups: number;
  behindGroups: number;
  staleGroups: number;
  runningGroups: number;
  errorGroups: number;
  outstandingEventCount: string;
}>;

export type ProjectionReplaySummary = Readonly<{
  status: "ok" | "degraded";
  totalGroups: number;
  requiredGroups: number;
  initializedGroups: number;
  caughtUpGroups: number;
  behindGroups: number;
  staleGroups: number;
  runningGroups: number;
  errorGroups: number;
  outstandingEventCount: string;
  contexts: readonly ProjectionReplayContextSummary[];
}>;

export type ProjectionBlockedStreamDetails = Readonly<{
  projectionKey: string;
  blockedStreams: readonly ProjectionBlockedStream[];
  poisonEvents: readonly ProjectionPoisonEvent[];
}>;

export type ProjectionStreamRetryResult = Readonly<{
  projectionKey: string;
  streamId: string;
  state: "resolved" | "still-blocked" | "already-resolved";
  inspectedEvents: number;
  appliedEvents: number;
  errorMessage: string | null;
}>;

type SubscriptionCheckpointRow = Readonly<{
  last_global_position: string | number | bigint;
}>;

type ProjectionGroupRevisionRow = Readonly<{
  projection_revision: string | number | bigint;
}>;

type SubscriptionApplicationRow = Readonly<{
  status: string;
}>;

type SubscriptionApplicationClaimResult = "claimed" | "already-applied";

function assertSqlIdentifier(identifier: string): string {
  if (!SQL_IDENTIFIER_RE.test(identifier)) {
    throw new Error(`Invalid SQL identifier "${identifier}". Use letters, numbers, and underscores only.`);
  }

  return identifier;
}

function assertProjectionRevision(value: number | undefined): number {
  const revision = value ?? 1;

  if (!Number.isInteger(revision) || revision < 1) {
    throw new Error("projectionRevision must be a positive integer.");
  }

  return revision;
}

function createCheckpointKey(
  subscription: Pick<BcEventSubscription, "projectionName" | "sourceContextName" | "subscriptionVersion">,
): string {
  return [subscription.projectionName, subscription.sourceContextName, `v${subscription.subscriptionVersion}`].join(
    ":",
  );
}

async function loadSubscriptionCheckpoint(
  db: PgTransactionalPool,
  checkpointKey: string,
): Promise<GlobalPosition | null> {
  const result = await db.query<SubscriptionCheckpointRow>(
    `SELECT last_global_position
     FROM ${SUBSCRIPTION_CHECKPOINTS_TABLE}
     WHERE checkpoint_key = $1`,
    [checkpointKey],
  );

  const row = result.rows[0];
  return row ? parseGlobalPosition(String(row.last_global_position)) : null;
}

async function saveSubscriptionCheckpoint(
  db: PgTransactionalPool,
  subscription: Pick<BcEventSubscription, "projectionName" | "sourceContextName" | "subscriptionVersion">,
  lastGlobalPosition: GlobalPosition,
): Promise<void> {
  await db.query(
    `INSERT INTO ${SUBSCRIPTION_CHECKPOINTS_TABLE} (
       checkpoint_key,
       projection_name,
       source_context_name,
       subscription_version,
       last_global_position,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5::bigint, now())
     ON CONFLICT (checkpoint_key)
     DO UPDATE SET
       last_global_position = GREATEST(
         ${SUBSCRIPTION_CHECKPOINTS_TABLE}.last_global_position,
         EXCLUDED.last_global_position
       ),
       updated_at = EXCLUDED.updated_at`,
    [
      createCheckpointKey(subscription),
      subscription.projectionName,
      subscription.sourceContextName,
      subscription.subscriptionVersion,
      lastGlobalPosition,
    ],
  );
}

async function loadSubscriptionApplicationStatus(
  db: PgQueryable,
  projectionKey: string,
  eventId: string,
  options: Readonly<{ lock?: boolean }> = {},
): Promise<"started" | "applied" | "poison" | "transient" | null> {
  const result = await db.query<SubscriptionApplicationRow>(
    `SELECT status
     FROM event_subscription_applications
     WHERE projection_key = $1
       AND event_id = $2${options.lock ? "\n     FOR UPDATE" : ""}`,
    [projectionKey, eventId],
  );
  const status = result.rows[0]?.status;

  return status === "started" || status === "applied" || status === "poison" || status === "transient" ? status : null;
}

async function loadSubscriptionApplicationStatuses(
  db: PgQueryable,
  projectionKey: string,
  eventIds: readonly string[],
): Promise<ReadonlyMap<string, "started" | "applied" | "poison" | "transient">> {
  if (eventIds.length === 0) {
    return new Map();
  }

  const result = await db.query<Readonly<{ event_id: string; status: string }>>(
    `SELECT event_id, status
     FROM event_subscription_applications
     WHERE projection_key = $1
       AND event_id = ANY($2::text[])`,
    [projectionKey, eventIds],
  );

  return new Map(
    result.rows.flatMap((row) => {
      const status = row.status;
      return status === "started" || status === "applied" || status === "poison" || status === "transient"
        ? [[String(row.event_id), status] as const]
        : [];
    }),
  );
}

async function claimSubscriptionApplication(
  db: PgQueryable,
  projectionKey: string,
  event: Readonly<ReturnType<typeof toTransportEvent>>,
): Promise<SubscriptionApplicationClaimResult> {
  const eventId = String(event.id);
  const insertResult = await db.query<SubscriptionApplicationRow>(
    `INSERT INTO event_subscription_applications (
       projection_key,
       event_id,
       stream_id,
       stream_version,
       global_position,
       event_type,
       status,
       error_message,
       started_at,
       updated_at
     ) VALUES ($1, $2, $3, $4::bigint, $5::bigint, $6, 'started', NULL, now(), now())
     ON CONFLICT (projection_key, event_id)
     DO NOTHING
     RETURNING status`,
    [projectionKey, eventId, event.streamId, event.streamVersion, event.globalPosition, event.type],
  );

  if (insertResult.rows[0]) {
    return "claimed";
  }

  const existingStatus = await loadSubscriptionApplicationStatus(db, projectionKey, eventId, { lock: true });
  if (existingStatus === "applied") {
    return "already-applied";
  }

  if (!existingStatus) {
    throw new Error(`Projection application '${projectionKey}:${eventId}' disappeared before it could be claimed.`);
  }

  await db.query(
    `UPDATE event_subscription_applications
     SET status = 'started',
         error_message = NULL,
         updated_at = now()
     WHERE projection_key = $1
       AND event_id = $2
       AND status <> 'applied'`,
    [projectionKey, eventId],
  );

  return "claimed";
}

async function recordSubscriptionApplicationCompleted(
  db: PgQueryable,
  projectionKey: string,
  eventId: string,
  status: "applied" | "poison" | "transient",
  error: unknown = null,
): Promise<void> {
  const result = await db.query(
    `UPDATE event_subscription_applications
     SET status = $3,
         error_message = $4,
         updated_at = now()
     WHERE projection_key = $1
       AND event_id = $2`,
    [projectionKey, eventId, status, error instanceof Error ? error.message : error === null ? null : String(error)],
  );
  if (result.rowCount !== null && result.rowCount < 1) {
    throw new Error(`Projection application '${projectionKey}:${eventId}' was not claimed before completion.`);
  }
}

async function recordSubscriptionApplicationFailure(
  db: PgTransactionalPool,
  projectionKey: string,
  event: Readonly<ReturnType<typeof toTransportEvent>>,
  status: "poison" | "transient",
  error: unknown,
): Promise<SubscriptionApplicationClaimResult> {
  return withPgTransaction(db, async (client) => {
    const claimResult = await claimSubscriptionApplication(client, projectionKey, event);
    if (claimResult === "already-applied") {
      return claimResult;
    }

    await recordSubscriptionApplicationCompleted(client, projectionKey, String(event.id), status, error);
    return "claimed";
  });
}

async function compactSubscriptionApplicationLedger(
  db: PgQueryable,
  projectionKey: string,
  checkpoint: GlobalPosition,
): Promise<void> {
  const compactThrough = BigInt(checkpoint) - SUBSCRIPTION_APPLICATION_LEDGER_RETAIN_APPLIED_EVENTS;
  if (compactThrough <= 0n) {
    return;
  }

  await db.query(
    `DELETE FROM event_subscription_applications
     WHERE projection_key = $1
       AND status = 'applied'
       AND global_position <= $2::bigint`,
    [projectionKey, compactThrough.toString()],
  );
}

async function loadProjectionGroupRevision(
  db: PgTransactionalPool,
  targetContextName: string,
  projectionName: string,
): Promise<number | null> {
  const result = await db.query<ProjectionGroupRevisionRow>(
    `SELECT projection_revision
     FROM ${PROJECTION_GROUP_REVISIONS_TABLE}
     WHERE target_context_name = $1
       AND projection_name = $2`,
    [targetContextName, projectionName],
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  const revision = Number(row.projection_revision);
  return assertProjectionRevision(revision);
}

async function saveProjectionGroupRevision(
  db: PgTransactionalPool,
  targetContextName: string,
  projectionName: string,
  projectionRevision: number,
): Promise<void> {
  await db.query(
    `INSERT INTO ${PROJECTION_GROUP_REVISIONS_TABLE} (
       target_context_name,
       projection_name,
       projection_revision,
       updated_at
     ) VALUES ($1, $2, $3, now())
     ON CONFLICT (target_context_name, projection_name)
     DO UPDATE SET
       projection_revision = EXCLUDED.projection_revision,
       updated_at = EXCLUDED.updated_at`,
    [targetContextName, projectionName, assertProjectionRevision(projectionRevision)],
  );
}

async function deleteSubscriptionCheckpoint(db: PgTransactionalPool, checkpointKey: string): Promise<void> {
  await db.query(
    `DELETE FROM ${SUBSCRIPTION_CHECKPOINTS_TABLE}
     WHERE checkpoint_key = $1`,
    [checkpointKey],
  );
  await db.query(
    `DELETE FROM event_subscription_applications
     WHERE projection_key = $1`,
    [checkpointKey],
  );
  await clearProjectionErrors(db, checkpointKey);
}

async function clearProjectionErrors(db: PgTransactionalPool, projectionKey: string): Promise<void> {
  await db.query(
    `UPDATE event_projection_blocked_streams
     SET state = 'resolved',
         updated_at = now()
     WHERE projection_key = $1
       AND state IN ('blocked', 'retrying')`,
    [projectionKey],
  );
  await db.query(
    `UPDATE event_projection_poison_events
     SET state = 'resolved',
         resolved_at = now(),
         last_seen_at = now()
     WHERE projection_key = $1
       AND state IN ('blocked', 'retrying')`,
    [projectionKey],
  );
}

async function markProjectionBlockedStreamRetrying(
  db: PgTransactionalPool,
  projectionKey: string,
  streamId: string,
): Promise<void> {
  await db.query(
    `UPDATE event_projection_blocked_streams
     SET state = 'retrying',
         updated_at = now()
     WHERE projection_key = $1
       AND stream_id = $2
       AND state IN ('blocked', 'retrying')`,
    [projectionKey, streamId],
  );
  await db.query(
    `UPDATE event_projection_poison_events
     SET state = 'retrying',
         retry_count = retry_count + 1,
         last_seen_at = now()
     WHERE projection_key = $1
       AND stream_id = $2
       AND state IN ('blocked', 'retrying')`,
    [projectionKey, streamId],
  );
}

async function markProjectionBlockedStreamBlocked(
  db: PgTransactionalPool,
  projectionKey: string,
  streamId: string,
): Promise<void> {
  await db.query(
    `UPDATE event_projection_blocked_streams
     SET state = 'blocked',
         updated_at = now()
     WHERE projection_key = $1
       AND stream_id = $2
       AND state = 'retrying'`,
    [projectionKey, streamId],
  );
  await db.query(
    `UPDATE event_projection_poison_events
     SET state = 'blocked',
         last_seen_at = now()
     WHERE projection_key = $1
       AND stream_id = $2
       AND state = 'retrying'`,
    [projectionKey, streamId],
  );
}

async function resolveProjectionBlockedStream(
  db: PgTransactionalPool,
  projectionKey: string,
  streamId: string,
): Promise<void> {
  await db.query(
    `UPDATE event_projection_blocked_streams
     SET state = 'resolved',
         updated_at = now()
     WHERE projection_key = $1
       AND stream_id = $2`,
    [projectionKey, streamId],
  );
  await db.query(
    `UPDATE event_projection_poison_events
     SET state = 'resolved',
         resolved_at = now(),
         last_seen_at = now()
     WHERE projection_key = $1
       AND stream_id = $2
       AND state IN ('blocked', 'retrying')`,
    [projectionKey, streamId],
  );
}

async function loadProjectionBlockedStream(
  db: PgTransactionalPool,
  projectionKey: string,
  streamId: string,
): Promise<ProjectionBlockedStream | null> {
  const result = await db.query<
    Readonly<{
      projection_key: string;
      stream_id: string;
      first_blocked_global_position: string | number | bigint;
      first_blocked_stream_version: string | number | bigint;
      last_seen_global_position: string | number | bigint;
      deferred_event_count: string | number | bigint;
      state: string;
    }>
  >(
    `SELECT
       projection_key,
       stream_id,
       first_blocked_global_position,
       first_blocked_stream_version,
       last_seen_global_position,
       deferred_event_count,
       state
     FROM event_projection_blocked_streams
     WHERE projection_key = $1
       AND stream_id = $2
       AND state IN ('blocked', 'retrying')`,
    [projectionKey, streamId],
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    projectionKey: row.projection_key,
    streamId: row.stream_id,
    firstBlockedGlobalPosition: parseGlobalPosition(String(row.first_blocked_global_position)),
    firstBlockedStreamVersion: coerceStreamVersion(row.first_blocked_stream_version, "first_blocked_stream_version"),
    lastSeenGlobalPosition: parseGlobalPosition(String(row.last_seen_global_position)),
    deferredEventCount: coerceNonNegativeInteger(row.deferred_event_count, "deferred_event_count"),
    state: row.state === "retrying" ? "retrying" : "blocked",
  };
}

async function recordProjectionPoisonEvent(
  db: PgTransactionalPool,
  input: Readonly<{
    projectionKey: string;
    projectionName: string;
    targetContextName: string;
    sourceContextName: string;
    subscriptionVersion: number;
    streamId: string;
    streamVersion: StreamVersion;
    eventId: string;
    eventType: string;
    globalPosition: GlobalPosition;
    error: unknown;
  }>,
): Promise<void> {
  const errorMessage = input.error instanceof Error ? input.error.message : String(input.error);
  const errorStack = input.error instanceof Error ? (input.error.stack ?? null) : null;

  await db.query(
    `INSERT INTO event_projection_poison_events (
       projection_key,
       event_id,
       projection_name,
       projection_kind,
       target_context_name,
       source_context_name,
       projection_revision,
       subscription_version,
       stream_id,
       stream_version,
       event_type,
       global_position,
       failure_kind,
       error_message,
       error_stack,
       state,
       retry_count,
       first_seen_at,
       last_seen_at,
       resolved_at
     ) VALUES (
       $1, $2, $3, 'subscription', $4, $5, NULL, $6, $7, $8::bigint, $9, $10::bigint,
       'poison', $11, $12, 'blocked', 0, now(), now(), NULL
     )
     ON CONFLICT (projection_key, event_id)
     DO UPDATE SET
       projection_name = EXCLUDED.projection_name,
       target_context_name = EXCLUDED.target_context_name,
       source_context_name = EXCLUDED.source_context_name,
       subscription_version = EXCLUDED.subscription_version,
       stream_id = EXCLUDED.stream_id,
       stream_version = EXCLUDED.stream_version,
       event_type = EXCLUDED.event_type,
       global_position = EXCLUDED.global_position,
       error_message = EXCLUDED.error_message,
       error_stack = EXCLUDED.error_stack,
       state = 'blocked',
       last_seen_at = EXCLUDED.last_seen_at,
       resolved_at = NULL`,
    [
      input.projectionKey,
      input.eventId,
      input.projectionName,
      input.targetContextName,
      input.sourceContextName,
      input.subscriptionVersion,
      input.streamId,
      input.streamVersion,
      input.eventType,
      input.globalPosition,
      errorMessage,
      errorStack,
    ],
  );

  await db.query(
    `INSERT INTO event_projection_blocked_streams (
       projection_key,
       stream_id,
       first_blocked_global_position,
       first_blocked_stream_version,
       last_seen_global_position,
       deferred_event_count,
       state,
       updated_at
     ) VALUES ($1, $2, $3::bigint, $4::bigint, $3::bigint, 0, 'blocked', now())
     ON CONFLICT (projection_key, stream_id)
     DO UPDATE SET
       first_blocked_global_position = LEAST(
         event_projection_blocked_streams.first_blocked_global_position,
         EXCLUDED.first_blocked_global_position
       ),
       first_blocked_stream_version = LEAST(
         event_projection_blocked_streams.first_blocked_stream_version,
         EXCLUDED.first_blocked_stream_version
       ),
       last_seen_global_position = GREATEST(
         event_projection_blocked_streams.last_seen_global_position,
         EXCLUDED.last_seen_global_position
       ),
       state = 'blocked',
       updated_at = EXCLUDED.updated_at`,
    [input.projectionKey, input.streamId, input.globalPosition, input.streamVersion],
  );
}

async function recordProjectionDeferredBlockedStreamEvent(
  db: PgTransactionalPool,
  input: Readonly<{
    projectionKey: string;
    streamId: string;
    streamVersion: StreamVersion;
    globalPosition: GlobalPosition;
  }>,
): Promise<void> {
  await db.query(
    `INSERT INTO event_projection_blocked_streams (
       projection_key,
       stream_id,
       first_blocked_global_position,
       first_blocked_stream_version,
       last_seen_global_position,
       deferred_event_count,
       state,
       updated_at
     ) VALUES ($1, $2, $3::bigint, $4::bigint, $3::bigint, 1, 'blocked', now())
     ON CONFLICT (projection_key, stream_id)
     DO UPDATE SET
       last_seen_global_position = GREATEST(
         event_projection_blocked_streams.last_seen_global_position,
         EXCLUDED.last_seen_global_position
       ),
       deferred_event_count = event_projection_blocked_streams.deferred_event_count + 1,
       state = 'blocked',
       updated_at = EXCLUDED.updated_at`,
    [input.projectionKey, input.streamId, input.globalPosition, input.streamVersion],
  );
}

async function loadProjectionErrorSummary(
  db: PgTransactionalPool,
  projectionKey: string,
): Promise<ProjectionErrorSummary> {
  const result = await db.query<
    Readonly<{
      blocked_stream_count: string | number | bigint;
      poison_event_count: string | number | bigint;
    }>
  >(
    `SELECT
       (
         SELECT COUNT(*)
         FROM event_projection_blocked_streams
         WHERE projection_key = $1
           AND state IN ('blocked', 'retrying')
       ) AS blocked_stream_count,
       (
         SELECT COUNT(*)
         FROM event_projection_poison_events
         WHERE projection_key = $1
           AND state IN ('blocked', 'retrying')
       ) AS poison_event_count`,
    [projectionKey],
  );

  const row = result.rows[0];
  return {
    blockedStreamCount: row ? coerceNonNegativeInteger(row.blocked_stream_count, "blocked_stream_count") : 0,
    poisonEventCount: row ? coerceNonNegativeInteger(row.poison_event_count, "poison_event_count") : 0,
  };
}

function coerceStreamVersion(value: string | number | bigint, fieldName: string): StreamVersion {
  const parsed = typeof value === "bigint" ? Number(value) : typeof value === "string" ? Number(value) : value;

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected "${fieldName}" to be a positive safe integer.`);
  }

  return parsed;
}

function coerceNonNegativeInteger(value: string | number | bigint, fieldName: string): number {
  const parsed = typeof value === "bigint" ? Number(value) : typeof value === "string" ? Number(value) : value;

  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Expected "${fieldName}" to be a non-negative safe integer.`);
  }

  return parsed;
}

function isGlobalPositionGreater(left: GlobalPosition, right: GlobalPosition): boolean {
  return BigInt(left) > BigInt(right);
}

function calculateOutstandingEventCount(
  lastGlobalPosition: GlobalPosition,
  sourceHeadGlobalPosition: GlobalPosition,
): string {
  const outstanding = BigInt(sourceHeadGlobalPosition) - BigInt(lastGlobalPosition);
  return outstanding > 0n ? outstanding.toString() : "0";
}

function deriveSubscriptionReplayState(
  checkpoint: GlobalPosition,
  sourceHeadGlobalPosition: GlobalPosition,
  errorSummary: Pick<ProjectionErrorSummary, "blockedStreamCount" | "poisonEventCount">,
): SubscriptionReplayState {
  if (errorSummary.blockedStreamCount > 0 || errorSummary.poisonEventCount > 0) {
    return "degraded";
  }

  return checkpoint === sourceHeadGlobalPosition ? "caught-up" : "behind";
}

function sumDecimalCounts(counts: readonly string[]): string {
  return counts.reduce((total, count) => total + BigInt(count), 0n).toString();
}

async function readSourceHeadGlobalPosition(pool: PgTransactionalPool): Promise<GlobalPosition> {
  const result = await pool.query<Readonly<{ head: string | number | bigint | null }>>(
    "SELECT COALESCE(MAX(global_position), 0) AS head FROM event_store_events",
  );

  return parseGlobalPosition(String(result.rows[0]?.head ?? ZERO_GLOBAL_POSITION));
}

async function refreshSubscriptionStatus(
  targetPool: PgTransactionalPool,
  sourcePool: PgTransactionalPool,
  checkpointKey: string,
  status: {
    initialized: boolean;
    lastGlobalPosition: GlobalPosition;
    sourceHeadGlobalPosition: GlobalPosition;
    outstandingEventCount: string;
    state: SubscriptionReplayState;
    blockedStreamCount: number;
    poisonEventCount: number;
    updatedAt: string;
  },
): Promise<void> {
  const storedCheckpoint = await loadSubscriptionCheckpoint(targetPool, checkpointKey);
  const checkpoint = storedCheckpoint ?? ZERO_GLOBAL_POSITION;
  const errorSummary = await loadProjectionErrorSummary(targetPool, checkpointKey);

  status.initialized = storedCheckpoint !== null;
  status.lastGlobalPosition = checkpoint;
  status.sourceHeadGlobalPosition = await readSourceHeadGlobalPosition(sourcePool);
  status.outstandingEventCount = calculateOutstandingEventCount(checkpoint, status.sourceHeadGlobalPosition);
  status.blockedStreamCount = errorSummary.blockedStreamCount;
  status.poisonEventCount = errorSummary.poisonEventCount;
  status.state = deriveSubscriptionReplayState(checkpoint, status.sourceHeadGlobalPosition, errorSummary);
  status.updatedAt = new Date().toISOString();
}

function createDefaultProjectionGroupReset(
  pool: PgTransactionalPool,
  ownedTables: readonly string[],
): () => Promise<void> {
  const normalizedTables = [...new Set(ownedTables.map(assertSqlIdentifier))];

  if (normalizedTables.length === 0) {
    return async () => undefined;
  }

  return async () => {
    await pool.query(`TRUNCATE TABLE ${normalizedTables.join(", ")} RESTART IDENTITY CASCADE`);
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForDatabase(
  pool: { query: (sql: string) => Promise<unknown> },
  label = "Database",
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (error) {
      if (attempt === MAX_RETRIES) {
        throw new Error(`${label} did not become ready after ${MAX_RETRIES} attempts.`, { cause: error });
      }

      await sleep(RETRY_DELAY_MS);
    }
  }
}

export async function drainProjectors(projectors: readonly BcProjector[]): Promise<void> {
  let processed = 0;

  do {
    processed = 0;

    for (const projector of projectors) {
      const result = await projector.runOnce();
      processed += result.processed;
    }
  } while (processed > 0);
}

export type ContextSubscriptionRunner = Readonly<{
  subscriptionName: string;
  projectionName: string;
  sourceContextName: string;
  targetContextName: string;
  subscriptionVersion: number;
  checkpointKey: string;
  order: number;
  runOnce: (context?: ProjectionRunContext) => Promise<ProjectorRunResult>;
  getStatus: () => ContextSubscriptionStatus;
  refreshStatus: () => Promise<ContextSubscriptionStatus>;
  reset: () => Promise<void>;
  retryBlockedStream: (streamId: string) => Promise<ProjectionStreamRetryResult>;
}>;

export type ContextProjectionGroup = Readonly<{
  projectionName: string;
  projectionRevision: number;
  targetContextName: string;
  sourceContextNames: readonly string[];
  ownedTables: readonly string[];
  requiredDuringBootstrap: boolean;
  projectors: readonly BcProjector[];
  subscriptionRunners: readonly ContextSubscriptionRunner[];
  reset: () => Promise<void>;
  getStatus: () => ContextProjectionGroupStatus;
  refreshStatus: () => Promise<ContextProjectionGroupStatus>;
  markRevisionSynced: () => Promise<void>;
}>;

export type MountedContextRuntimeEntry = Readonly<{
  contextName: string;
  mountRole?: "active" | "source-only";
  module: BcApiModule;
  services: unknown;
  pool: PgTransactionalPool;
  projectors: readonly BcProjector[];
}>;

export type ContextProcessSet = Readonly<{
  projectors: readonly BcProjector[];
  subscriptionRunners?: readonly ContextSubscriptionRunner[];
}>;

export function sortSubscriptionRunners(
  runners: readonly ContextSubscriptionRunner[],
): readonly ContextSubscriptionRunner[] {
  return [...runners].sort((left, right) => {
    if (left.order !== right.order) {
      return left.order - right.order;
    }

    if (left.sourceContextName !== right.sourceContextName) {
      return left.sourceContextName.localeCompare(right.sourceContextName);
    }

    if (left.targetContextName !== right.targetContextName) {
      return left.targetContextName.localeCompare(right.targetContextName);
    }

    if (left.projectionName !== right.projectionName) {
      return left.projectionName.localeCompare(right.projectionName);
    }

    if (left.subscriptionVersion !== right.subscriptionVersion) {
      return left.subscriptionVersion - right.subscriptionVersion;
    }

    return left.subscriptionName.localeCompare(right.subscriptionName);
  });
}

function sortProjectionGroups(groups: readonly ContextProjectionGroup[]): readonly ContextProjectionGroup[] {
  return [...groups].sort((left, right) => {
    const leftOrder = Math.min(...left.subscriptionRunners.map((runner) => runner.order), Number.MAX_SAFE_INTEGER);
    const rightOrder = Math.min(...right.subscriptionRunners.map((runner) => runner.order), Number.MAX_SAFE_INTEGER);

    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }

    if (left.targetContextName !== right.targetContextName) {
      return left.targetContextName.localeCompare(right.targetContextName);
    }

    return left.projectionName.localeCompare(right.projectionName);
  });
}

function matchesSubscriptionEvent(
  event: Readonly<ReturnType<typeof toTransportEvent>>,
  subscription: Pick<BcEventSubscription, "eventTypes" | "streamPrefixes">,
): boolean {
  const matchesType = !subscription.eventTypes || subscription.eventTypes.includes(event.type);
  const matchesStreamPrefix =
    !subscription.streamPrefixes || subscription.streamPrefixes.some((prefix) => event.streamId.startsWith(prefix));

  return matchesType && matchesStreamPrefix;
}

export function createSubscriptionRunner(
  targetContextName: string,
  targetPool: PgTransactionalPool,
  sourcePool: PgTransactionalPool,
  subscription: BcEventSubscription,
): ContextSubscriptionRunner {
  const sourceEventStore = createPostgresEventStore({ pool: sourcePool });
  const batchSize = subscription.batchSize ?? 100;
  const checkpointBatchSize = Math.max(1, subscription.checkpointBatchSize ?? batchSize);
  const checkpointKey = createCheckpointKey(subscription);
  const subscriptionEventTypes = subscription.eventTypes ?? Object.keys(subscription.handlers).sort();
  const status: {
    checkpointKey: string;
    subscriptionName: string;
    projectionName: string;
    sourceContextName: string;
    targetContextName: string;
    subscriptionVersion: number;
    initialized: boolean;
    lastGlobalPosition: GlobalPosition;
    sourceHeadGlobalPosition: GlobalPosition;
    outstandingEventCount: string;
    processedEvents: number;
    state: SubscriptionReplayState;
    lastError: string | null;
    blockedStreamCount: number;
    poisonEventCount: number;
    updatedAt: string;
  } = {
    checkpointKey,
    subscriptionName: subscription.subscriptionName,
    projectionName: subscription.projectionName,
    sourceContextName: subscription.sourceContextName,
    targetContextName,
    subscriptionVersion: subscription.subscriptionVersion,
    initialized: false,
    lastGlobalPosition: ZERO_GLOBAL_POSITION,
    sourceHeadGlobalPosition: ZERO_GLOBAL_POSITION,
    outstandingEventCount: "0",
    processedEvents: 0,
    state: "idle",
    lastError: null,
    blockedStreamCount: 0,
    poisonEventCount: 0,
    updatedAt: new Date().toISOString(),
  };
  const errorPolicy = subscription.errorPolicy ?? "strict-per-stream";

  return {
    subscriptionName: subscription.subscriptionName,
    projectionName: subscription.projectionName,
    sourceContextName: subscription.sourceContextName,
    targetContextName,
    subscriptionVersion: subscription.subscriptionVersion,
    checkpointKey,
    order: subscription.order ?? 0,
    getStatus: () => ({ ...status }),
    refreshStatus: async () => {
      const storedCheckpoint = await loadSubscriptionCheckpoint(targetPool, checkpointKey);
      const checkpoint = storedCheckpoint ?? ZERO_GLOBAL_POSITION;
      const errorSummary = await loadProjectionErrorSummary(targetPool, checkpointKey);
      status.initialized = storedCheckpoint !== null;
      status.lastGlobalPosition = checkpoint;
      status.sourceHeadGlobalPosition = await readSourceHeadGlobalPosition(sourcePool);
      status.outstandingEventCount = calculateOutstandingEventCount(checkpoint, status.sourceHeadGlobalPosition);
      status.blockedStreamCount = errorSummary.blockedStreamCount;
      status.poisonEventCount = errorSummary.poisonEventCount;
      if (status.state !== "running" && status.state !== "error") {
        status.state = deriveSubscriptionReplayState(checkpoint, status.sourceHeadGlobalPosition, errorSummary);
      }
      status.updatedAt = new Date().toISOString();
      return { ...status };
    },
    reset: async () => {
      await deleteSubscriptionCheckpoint(targetPool, checkpointKey);
      status.initialized = false;
      status.lastGlobalPosition = ZERO_GLOBAL_POSITION;
      status.sourceHeadGlobalPosition = ZERO_GLOBAL_POSITION;
      status.outstandingEventCount = "0";
      status.processedEvents = 0;
      status.state = "idle";
      status.lastError = null;
      status.blockedStreamCount = 0;
      status.poisonEventCount = 0;
      status.updatedAt = new Date().toISOString();
    },
    retryBlockedStream: async (streamId) => {
      const blockedStream = await loadProjectionBlockedStream(targetPool, checkpointKey, streamId);
      if (!blockedStream) {
        await refreshSubscriptionStatus(targetPool, sourcePool, checkpointKey, status);
        return {
          projectionKey: checkpointKey,
          streamId,
          state: "already-resolved",
          inspectedEvents: 0,
          appliedEvents: 0,
          errorMessage: null,
        };
      }

      await markProjectionBlockedStreamRetrying(targetPool, checkpointKey, streamId);

      let fromVersion = blockedStream.firstBlockedStreamVersion;
      let inspectedEvents = 0;
      let appliedEvents = 0;
      let lastInspectedGlobalPosition = ZERO_GLOBAL_POSITION;

      while (true) {
        const storedEvents = await sourceEventStore.readStream({
          streamId,
          fromVersion,
          limit: batchSize,
        });

        if (storedEvents.length === 0) {
          break;
        }

        for (const storedEvent of storedEvents) {
          const event = toTransportEvent(storedEvent);
          fromVersion = event.streamVersion + 1;
          inspectedEvents += 1;
          lastInspectedGlobalPosition = event.globalPosition;

          if (!matchesSubscriptionEvent(event, { ...subscription, eventTypes: subscriptionEventTypes })) {
            continue;
          }

          const handler = (subscription.handlers as Readonly<Record<string, ProjectorHandler | undefined>>)[event.type];
          if (!handler) {
            continue;
          }

          try {
            const applicationResult = await withPgTransaction(targetPool, async (client) => {
              const claimResult = await claimSubscriptionApplication(client, checkpointKey, event);
              if (claimResult === "already-applied") {
                return "already-applied" as const;
              }

              await handler(event, { db: client });
              await recordSubscriptionApplicationCompleted(client, checkpointKey, String(event.id), "applied");
              return "applied" as const;
            });
            if (applicationResult === "already-applied") {
              appliedEvents += 1;
              continue;
            }
            appliedEvents += 1;
          } catch (error) {
            const failureResult = await recordSubscriptionApplicationFailure(
              targetPool,
              checkpointKey,
              event,
              "poison",
              error,
            );
            if (failureResult === "already-applied") {
              appliedEvents += 1;
              continue;
            }

            await recordProjectionPoisonEvent(targetPool, {
              projectionKey: checkpointKey,
              projectionName: subscription.projectionName,
              targetContextName,
              sourceContextName: subscription.sourceContextName,
              subscriptionVersion: subscription.subscriptionVersion,
              streamId: event.streamId,
              streamVersion: event.streamVersion,
              eventId: String(event.id),
              eventType: event.type,
              globalPosition: event.globalPosition,
              error,
            });
            await refreshSubscriptionStatus(targetPool, sourcePool, checkpointKey, status);

            return {
              projectionKey: checkpointKey,
              streamId,
              state: "still-blocked",
              inspectedEvents,
              appliedEvents,
              errorMessage: error instanceof Error ? error.message : String(error),
            };
          }
        }

        if (storedEvents.length < batchSize) {
          break;
        }
      }

      const currentBlockedStream = await loadProjectionBlockedStream(targetPool, checkpointKey, streamId);
      if (
        currentBlockedStream &&
        isGlobalPositionGreater(currentBlockedStream.lastSeenGlobalPosition, lastInspectedGlobalPosition)
      ) {
        await markProjectionBlockedStreamBlocked(targetPool, checkpointKey, streamId);
        await refreshSubscriptionStatus(targetPool, sourcePool, checkpointKey, status);
        return {
          projectionKey: checkpointKey,
          streamId,
          state: "still-blocked",
          inspectedEvents,
          appliedEvents,
          errorMessage: "The stream received deferred events during retry. Retry again to apply the new tail.",
        };
      }

      await resolveProjectionBlockedStream(targetPool, checkpointKey, streamId);
      await refreshSubscriptionStatus(targetPool, sourcePool, checkpointKey, status);

      return {
        projectionKey: checkpointKey,
        streamId,
        state: "resolved",
        inspectedEvents,
        appliedEvents,
        errorMessage: null,
      };
    },
    runOnce: async (context) => {
      context?.throwIfLeaseLost?.();
      status.state = "running";
      status.lastError = null;
      status.updatedAt = new Date().toISOString();
      const saveLeasedSubscriptionCheckpoint = async (lastGlobalPosition: GlobalPosition) => {
        context?.throwIfLeaseLost?.();
        await saveSubscriptionCheckpoint(targetPool, subscription, lastGlobalPosition);
      };

      try {
        const storedCheckpoint = await loadSubscriptionCheckpoint(targetPool, checkpointKey);
        const checkpoint = storedCheckpoint ?? ZERO_GLOBAL_POSITION;
        status.initialized = storedCheckpoint !== null;
        status.lastGlobalPosition = checkpoint;
        status.sourceHeadGlobalPosition = await readSourceHeadGlobalPosition(sourcePool);
        status.outstandingEventCount = calculateOutstandingEventCount(checkpoint, status.sourceHeadGlobalPosition);

        const storedEvents = await sourceEventStore.readAll({
          afterGlobalPosition: checkpoint,
          eventTypes: subscriptionEventTypes,
          streamPrefixes: subscription.streamPrefixes,
          limit: batchSize,
        });

        if (storedEvents.length === 0) {
          if (checkpoint !== status.sourceHeadGlobalPosition) {
            await saveLeasedSubscriptionCheckpoint(status.sourceHeadGlobalPosition);
          }
          const errorSummary = await loadProjectionErrorSummary(targetPool, checkpointKey);
          status.blockedStreamCount = errorSummary.blockedStreamCount;
          status.poisonEventCount = errorSummary.poisonEventCount;
          status.initialized = true;
          status.lastGlobalPosition = status.sourceHeadGlobalPosition;
          status.outstandingEventCount = "0";
          status.state = deriveSubscriptionReplayState(
            status.sourceHeadGlobalPosition,
            status.sourceHeadGlobalPosition,
            errorSummary,
          );
          status.updatedAt = new Date().toISOString();

          return {
            processed: 0,
            lastGlobalPosition: status.sourceHeadGlobalPosition,
            state: status.state === "degraded" ? "degraded" : "caught-up",
            blockedStreams: status.blockedStreamCount,
            poisonEvents: status.poisonEventCount,
          };
        }

        let lastGlobalPosition = checkpoint;
        let lastCheckpointedGlobalPosition = checkpoint;
        let eventsSinceCheckpoint = 0;
        let processed = 0;
        const applicationStatuses = await loadSubscriptionApplicationStatuses(
          targetPool,
          checkpointKey,
          storedEvents.map((event) => String(event.eventId)),
        );

        for (const storedEvent of storedEvents) {
          context?.throwIfLeaseLost?.();
          const event = toTransportEvent(storedEvent);
          const handler = (subscription.handlers as Readonly<Record<string, ProjectorHandler | undefined>>)[event.type];

          if (matchesSubscriptionEvent(event, { ...subscription, eventTypes: subscriptionEventTypes }) && handler) {
            if (errorPolicy === "strict-per-stream") {
              const blockedStream = await loadProjectionBlockedStream(targetPool, checkpointKey, event.streamId);

              if (blockedStream) {
                await recordProjectionDeferredBlockedStreamEvent(targetPool, {
                  projectionKey: checkpointKey,
                  streamId: event.streamId,
                  streamVersion: event.streamVersion,
                  globalPosition: event.globalPosition,
                });

                lastGlobalPosition = event.globalPosition;
                processed += 1;
                eventsSinceCheckpoint += 1;
                if (eventsSinceCheckpoint >= checkpointBatchSize) {
                  await saveLeasedSubscriptionCheckpoint(lastGlobalPosition);
                  lastCheckpointedGlobalPosition = lastGlobalPosition;
                  eventsSinceCheckpoint = 0;
                }
                continue;
              }
            }

            if (applicationStatuses.get(String(event.id)) === "applied") {
              lastGlobalPosition = event.globalPosition;
              processed += 1;
              eventsSinceCheckpoint += 1;
              if (eventsSinceCheckpoint >= checkpointBatchSize) {
                await saveLeasedSubscriptionCheckpoint(lastGlobalPosition);
                lastCheckpointedGlobalPosition = lastGlobalPosition;
                eventsSinceCheckpoint = 0;
              }
              continue;
            }

            try {
              const applicationResult = await withPgTransaction(targetPool, async (client) => {
                const claimResult = await claimSubscriptionApplication(client, checkpointKey, event);
                if (claimResult === "already-applied") {
                  return "already-applied" as const;
                }

                await handler(event, { db: client });
                await recordSubscriptionApplicationCompleted(client, checkpointKey, String(event.id), "applied");
                return "applied" as const;
              });
              if (applicationResult === "already-applied") {
                lastGlobalPosition = event.globalPosition;
                processed += 1;
                eventsSinceCheckpoint += 1;
                if (eventsSinceCheckpoint >= checkpointBatchSize) {
                  await saveLeasedSubscriptionCheckpoint(lastGlobalPosition);
                  lastCheckpointedGlobalPosition = lastGlobalPosition;
                  eventsSinceCheckpoint = 0;
                }
                continue;
              }
            } catch (error) {
              if (errorPolicy === "global-strict" || isTransientProjectionError(error)) {
                const failureResult = await recordSubscriptionApplicationFailure(
                  targetPool,
                  checkpointKey,
                  event,
                  "transient",
                  error,
                );
                if (failureResult === "already-applied") {
                  lastGlobalPosition = event.globalPosition;
                  processed += 1;
                  eventsSinceCheckpoint += 1;
                  if (eventsSinceCheckpoint >= checkpointBatchSize) {
                    await saveLeasedSubscriptionCheckpoint(lastGlobalPosition);
                    lastCheckpointedGlobalPosition = lastGlobalPosition;
                    eventsSinceCheckpoint = 0;
                  }
                  continue;
                }

                if (lastGlobalPosition !== lastCheckpointedGlobalPosition) {
                  await saveLeasedSubscriptionCheckpoint(lastGlobalPosition);
                }
                throw error;
              }

              const failureResult = await recordSubscriptionApplicationFailure(
                targetPool,
                checkpointKey,
                event,
                "poison",
                error,
              );
              if (failureResult === "already-applied") {
                lastGlobalPosition = event.globalPosition;
                processed += 1;
                eventsSinceCheckpoint += 1;
                if (eventsSinceCheckpoint >= checkpointBatchSize) {
                  await saveLeasedSubscriptionCheckpoint(lastGlobalPosition);
                  lastCheckpointedGlobalPosition = lastGlobalPosition;
                  eventsSinceCheckpoint = 0;
                }
                continue;
              }

              await recordProjectionPoisonEvent(targetPool, {
                projectionKey: checkpointKey,
                projectionName: subscription.projectionName,
                targetContextName,
                sourceContextName: subscription.sourceContextName,
                subscriptionVersion: subscription.subscriptionVersion,
                streamId: event.streamId,
                streamVersion: event.streamVersion,
                eventId: String(event.id),
                eventType: event.type,
                globalPosition: event.globalPosition,
                error,
              });
            }
          }

          lastGlobalPosition = event.globalPosition;
          processed += 1;
          eventsSinceCheckpoint += 1;
          if (eventsSinceCheckpoint >= checkpointBatchSize) {
            await saveLeasedSubscriptionCheckpoint(lastGlobalPosition);
            lastCheckpointedGlobalPosition = lastGlobalPosition;
            eventsSinceCheckpoint = 0;
          }
        }

        if (lastGlobalPosition !== lastCheckpointedGlobalPosition) {
          await saveLeasedSubscriptionCheckpoint(lastGlobalPosition);
          lastCheckpointedGlobalPosition = lastGlobalPosition;
        }
        await compactSubscriptionApplicationLedger(targetPool, checkpointKey, lastCheckpointedGlobalPosition);

        if (storedEvents.length < batchSize) {
          const observedSourceHeadGlobalPosition = isGlobalPositionGreater(
            lastGlobalPosition,
            status.sourceHeadGlobalPosition,
          )
            ? lastGlobalPosition
            : status.sourceHeadGlobalPosition;

          status.sourceHeadGlobalPosition = observedSourceHeadGlobalPosition;
          if (lastGlobalPosition !== observedSourceHeadGlobalPosition) {
            lastGlobalPosition = observedSourceHeadGlobalPosition;
            await saveLeasedSubscriptionCheckpoint(lastGlobalPosition);
            lastCheckpointedGlobalPosition = lastGlobalPosition;
          }
        }
        await compactSubscriptionApplicationLedger(targetPool, checkpointKey, lastCheckpointedGlobalPosition);

        status.initialized = true;
        status.lastGlobalPosition = lastGlobalPosition;
        status.outstandingEventCount = calculateOutstandingEventCount(
          lastGlobalPosition,
          status.sourceHeadGlobalPosition,
        );
        status.processedEvents += processed;
        const errorSummary = await loadProjectionErrorSummary(targetPool, checkpointKey);
        status.blockedStreamCount = errorSummary.blockedStreamCount;
        status.poisonEventCount = errorSummary.poisonEventCount;
        status.state = deriveSubscriptionReplayState(lastGlobalPosition, status.sourceHeadGlobalPosition, errorSummary);
        status.updatedAt = new Date().toISOString();

        return {
          processed,
          lastGlobalPosition,
          state: status.state === "degraded" ? "degraded" : "running",
          blockedStreams: status.blockedStreamCount,
          poisonEvents: status.poisonEventCount,
        };
      } catch (error) {
        status.state = "error";
        status.lastError = error instanceof Error ? error.message : "Unknown subscription replay failure.";
        status.updatedAt = new Date().toISOString();
        throw error;
      }
    },
  };
}

export function resolveModuleSubscriptions(
  mountedContexts: readonly MountedContextRuntimeEntry[],
): readonly ContextSubscriptionRunner[] {
  const contextsByName = new Map(mountedContexts.map((entry) => [entry.contextName, entry]));
  const runners: ContextSubscriptionRunner[] = [];

  for (const entry of mountedContexts) {
    if (entry.mountRole === "source-only") {
      continue;
    }

    const subscriptions = entry.module.buildSubscriptions?.(entry.services) ?? [];

    for (const subscription of subscriptions) {
      validateSubscriptionEventFilters(entry.contextName, subscription);
      const sourceEntry = contextsByName.get(subscription.sourceContextName);
      if (!sourceEntry) {
        throw new Error(
          `Context '${entry.contextName}' declared subscription '${subscription.subscriptionName}' for '${subscription.sourceContextName}', but that source context is not mounted in the runtime.`,
        );
      }

      runners.push(createSubscriptionRunner(entry.contextName, entry.pool, sourceEntry.pool, subscription));
    }
  }

  return sortSubscriptionRunners(runners);
}

function validateSubscriptionEventFilters(contextName: string, subscription: BcEventSubscription): void {
  if (!subscription.eventTypes) {
    return;
  }

  const declaredEventTypes = new Set(subscription.eventTypes);
  const missingEventTypes = Object.keys(subscription.handlers)
    .filter((eventType) => !declaredEventTypes.has(eventType))
    .sort();

  if (missingEventTypes.length > 0) {
    throw new Error(
      `Context '${contextName}' subscription '${subscription.subscriptionName}' for projection '${subscription.projectionName}' declares eventTypes that do not cover handler event types. Missing: [${missingEventTypes.join(", ")}]. Add the missing event type(s) to the bounded context manifest or remove the handler.`,
    );
  }
}

function resolveContextProjectionGroups(entry: MountedContextRuntimeEntry): readonly ContextProjectionGroup[] {
  const runtimeGroups: readonly BcProjectionGroup[] =
    entry.module.buildProjectionGroups?.(entry.services) ??
    (entry.module.projectionGroups ?? []).map((group) => ({ ...group }));

  const seenProjectionNames = new Set<string>();

  return runtimeGroups.map((group) => {
    if (seenProjectionNames.has(group.projectionName)) {
      throw new Error(`Context '${entry.contextName}' declared duplicate projection group '${group.projectionName}'.`);
    }
    seenProjectionNames.add(group.projectionName);

    const sourceContextNames = [...new Set(group.sourceContextNames)];
    const ownedTables = [...new Set(group.ownedTables)];
    const projectionRevision = assertProjectionRevision(group.projectionRevision);
    const revisionState: {
      storedProjectionRevision: number | null;
      updatedAt: string;
    } = {
      storedProjectionRevision: null,
      updatedAt: new Date(0).toISOString(),
    };
    const revisionStale = () =>
      revisionState.storedProjectionRevision !== null && revisionState.storedProjectionRevision !== projectionRevision;

    return {
      projectionName: group.projectionName,
      projectionRevision,
      targetContextName: entry.contextName,
      sourceContextNames,
      ownedTables,
      requiredDuringBootstrap: group.requiredDuringBootstrap ?? false,
      projectors: entry.projectors,
      subscriptionRunners: [],
      reset: group.reset ?? createDefaultProjectionGroupReset(entry.pool, ownedTables),
      getStatus: () => ({
        projectionName: group.projectionName,
        projectionRevision,
        storedProjectionRevision: revisionState.storedProjectionRevision,
        revisionStale: revisionStale(),
        targetContextName: entry.contextName,
        sourceContextNames,
        ownedTables,
        requiredDuringBootstrap: group.requiredDuringBootstrap ?? false,
        initialized: sourceContextNames.length === 0,
        caughtUp: sourceContextNames.length === 0,
        state: "caught-up",
        lastError: null,
        outstandingEventCount: "0",
        blockedStreamCount: 0,
        poisonEventCount: 0,
        updatedAt: revisionState.updatedAt,
        subscriptions: [],
      }),
      refreshStatus: async () => {
        revisionState.storedProjectionRevision = await loadProjectionGroupRevision(
          entry.pool,
          entry.contextName,
          group.projectionName,
        );
        revisionState.updatedAt = new Date().toISOString();
        return {
          projectionName: group.projectionName,
          projectionRevision,
          storedProjectionRevision: revisionState.storedProjectionRevision,
          revisionStale: revisionStale(),
          targetContextName: entry.contextName,
          sourceContextNames,
          ownedTables,
          requiredDuringBootstrap: group.requiredDuringBootstrap ?? false,
          initialized: sourceContextNames.length === 0,
          caughtUp: sourceContextNames.length === 0,
          state: "caught-up",
          lastError: null,
          outstandingEventCount: "0",
          blockedStreamCount: 0,
          poisonEventCount: 0,
          updatedAt: revisionState.updatedAt,
          subscriptions: [],
        };
      },
      markRevisionSynced: async () => {
        await saveProjectionGroupRevision(entry.pool, entry.contextName, group.projectionName, projectionRevision);
        revisionState.storedProjectionRevision = projectionRevision;
        revisionState.updatedAt = new Date().toISOString();
      },
    };
  });
}

export function resolveModuleProjectionGroups(
  mountedContexts: readonly MountedContextRuntimeEntry[],
  subscriptionRunners: readonly ContextSubscriptionRunner[],
): readonly ContextProjectionGroup[] {
  const groups: ContextProjectionGroup[] = [];
  const consumedCheckpointKeys = new Set<string>();

  for (const entry of mountedContexts) {
    if (entry.mountRole === "source-only") {
      continue;
    }

    const contextGroups = resolveContextProjectionGroups(entry);

    for (const group of contextGroups) {
      const groupRunners = sortSubscriptionRunners(
        subscriptionRunners.filter(
          (runner) => runner.targetContextName === entry.contextName && runner.projectionName === group.projectionName,
        ),
      );
      const actualSources = [...new Set(groupRunners.map((runner) => runner.sourceContextName))];

      if (group.sourceContextNames.length === 0) {
        throw new Error(
          `Context '${entry.contextName}' projection group '${group.projectionName}' must declare at least one source context.`,
        );
      }

      if (groupRunners.length === 0) {
        throw new Error(
          `Context '${entry.contextName}' projection group '${group.projectionName}' does not have any matching subscriptions.`,
        );
      }

      const missingSources = group.sourceContextNames.filter(
        (sourceContextName) => !actualSources.includes(sourceContextName),
      );
      const unexpectedSources = actualSources.filter(
        (sourceContextName) => !group.sourceContextNames.includes(sourceContextName),
      );

      if (missingSources.length > 0 || unexpectedSources.length > 0) {
        throw new Error(
          `Context '${entry.contextName}' projection group '${group.projectionName}' sources do not match subscriptions. Missing: [${missingSources.join(", ")}]. Unexpected: [${unexpectedSources.join(", ")}].`,
        );
      }

      for (const runner of groupRunners) {
        consumedCheckpointKeys.add(runner.checkpointKey);
      }

      groups.push({
        ...group,
        subscriptionRunners: groupRunners,
        getStatus: () => {
          const baseStatus = group.getStatus();
          const subscriptions = groupRunners.map((runner) => runner.getStatus());
          const initialized =
            subscriptions.length > 0 && subscriptions.every((subscription) => subscription.initialized);
          const caughtUp =
            subscriptions.length > 0 &&
            subscriptions.every(
              (subscription) =>
                subscription.lastGlobalPosition === subscription.sourceHeadGlobalPosition &&
                subscription.blockedStreamCount === 0,
            );
          const blockedStreamCount = subscriptions.reduce(
            (total, subscription) => total + subscription.blockedStreamCount,
            0,
          );
          const poisonEventCount = subscriptions.reduce(
            (total, subscription) => total + subscription.poisonEventCount,
            0,
          );
          const outstandingEventCount = sumDecimalCounts(
            subscriptions.map((subscription) => subscription.outstandingEventCount),
          );
          const state: SubscriptionReplayState = subscriptions.some((subscription) => subscription.state === "error")
            ? "error"
            : subscriptions.some((subscription) => subscription.state === "running")
              ? "running"
              : blockedStreamCount > 0 || subscriptions.some((subscription) => subscription.state === "degraded")
                ? "degraded"
                : caughtUp
                  ? "caught-up"
                  : "behind";
          const updatedAt = subscriptions.reduce(
            (latest, subscription) => (latest > subscription.updatedAt ? latest : subscription.updatedAt),
            new Date(0).toISOString(),
          );
          const lastError = subscriptions.find((subscription) => subscription.lastError)?.lastError ?? null;

          return {
            projectionName: group.projectionName,
            projectionRevision: group.projectionRevision,
            storedProjectionRevision: baseStatus.storedProjectionRevision,
            revisionStale: baseStatus.revisionStale,
            targetContextName: entry.contextName,
            sourceContextNames: group.sourceContextNames,
            ownedTables: group.ownedTables,
            requiredDuringBootstrap: group.requiredDuringBootstrap,
            initialized,
            caughtUp,
            state,
            lastError,
            outstandingEventCount,
            blockedStreamCount,
            poisonEventCount,
            updatedAt: updatedAt > baseStatus.updatedAt ? updatedAt : baseStatus.updatedAt,
            subscriptions,
          };
        },
      });
    }
  }

  for (const runner of subscriptionRunners) {
    if (consumedCheckpointKeys.has(runner.checkpointKey)) {
      continue;
    }

    throw new Error(
      `Subscription '${runner.subscriptionName}' for context '${runner.targetContextName}' is missing a declared projection group for '${runner.projectionName}'.`,
    );
  }

  return sortProjectionGroups(groups);
}

export async function drainSubscriptionRunners(runners: readonly ContextSubscriptionRunner[]): Promise<void> {
  let processed = 0;

  do {
    processed = 0;

    for (const runner of sortSubscriptionRunners(runners)) {
      const result = await runner.runOnce();
      processed += result.processed;
    }
  } while (processed > 0);
}

export async function drainContextProcesses(processSet: ContextProcessSet): Promise<void> {
  let processed = 0;

  do {
    processed = 0;

    for (const runner of sortSubscriptionRunners(processSet.subscriptionRunners ?? [])) {
      const result = await runner.runOnce();
      processed += result.processed;
    }

    for (const projector of processSet.projectors) {
      const result = await projector.runOnce();
      processed += result.processed;
    }
  } while (processed > 0);
}

export async function syncProjectionGroup(group: ContextProjectionGroup): Promise<void> {
  const status = await group.refreshStatus();

  if (status.revisionStale) {
    await rebuildProjectionGroup(group);
    return;
  }

  await drainContextProcesses({
    projectors: group.projectors,
    subscriptionRunners: group.subscriptionRunners,
  });
  await group.markRevisionSynced();
}

export async function resetProjectionGroup(group: ContextProjectionGroup): Promise<void> {
  await group.reset();

  for (const runner of sortSubscriptionRunners(group.subscriptionRunners)) {
    await runner.reset();
  }
}

export async function rebuildProjectionGroup(group: ContextProjectionGroup): Promise<void> {
  await resetProjectionGroup(group);
  await drainContextProcesses({
    projectors: group.projectors,
    subscriptionRunners: group.subscriptionRunners,
  });
  await group.markRevisionSynced();
}

export async function bootstrapContextDatabase(
  module: Pick<BcApiModule, "contextName" | "schemaSql">,
  pool: PgTransactionalPool,
): Promise<void> {
  await waitForDatabase(pool, module.contextName);
  await pool.query(composeModuleSchemaSql(module));
}

export function composeModuleSchemaSql(module: Pick<BcApiModule, "schemaSql">): string {
  const eventCoreSchemaSql = eventCorePostgresSchemaSql.trim();
  const moduleSchemaSql = module.schemaSql.trim();
  const normalizedModuleSchemaSql = moduleSchemaSql.startsWith(eventCoreSchemaSql)
    ? moduleSchemaSql.slice(eventCoreSchemaSql.length).trim()
    : moduleSchemaSql;

  return [eventCoreSchemaSql, eventSubscriptionSchemaSql.trim(), normalizedModuleSchemaSql]
    .filter((schemaSql) => schemaSql.length > 0)
    .join("\n\n");
}

export async function syncContextSubscriptions(
  runtime: Readonly<{
    mountedContexts: readonly MountedContextRuntimeEntry[];
    subscriptionRunners: readonly ContextSubscriptionRunner[];
  }>,
  contextName: string,
): Promise<void> {
  const targetContext = runtime.mountedContexts.find((entry) => entry.contextName === contextName);
  if (!targetContext) {
    throw new Error(`Runtime is missing mounted context '${contextName}'.`);
  }

  await drainContextProcesses({
    projectors: targetContext.projectors,
    subscriptionRunners: runtime.subscriptionRunners.filter((runner) => runner.targetContextName === contextName),
  });
}

export async function syncContextProjectionGroups(
  runtime: Readonly<{
    mountedContexts: readonly MountedContextRuntimeEntry[];
    projectionGroups: readonly ContextProjectionGroup[];
  }>,
  contextName: string,
  options: Readonly<{
    requiredOnly?: boolean;
  }> = {},
): Promise<void> {
  const targetContext = runtime.mountedContexts.find((entry) => entry.contextName === contextName);
  if (!targetContext) {
    throw new Error(`Runtime is missing mounted context '${contextName}'.`);
  }

  const groups = sortProjectionGroups(
    runtime.projectionGroups.filter(
      (group) => group.targetContextName === contextName && (!options.requiredOnly || group.requiredDuringBootstrap),
    ),
  );

  if (groups.length === 0) {
    await drainContextProcesses({
      projectors: targetContext.projectors,
    });
    return;
  }

  for (const group of groups) {
    await syncProjectionGroup(group);
  }
}

export function getProjectionGroup(
  runtime: Readonly<{
    projectionGroups: readonly ContextProjectionGroup[];
  }>,
  contextName: string,
  projectionName: string,
): ContextProjectionGroup {
  const group = runtime.projectionGroups.find(
    (candidate) => candidate.targetContextName === contextName && candidate.projectionName === projectionName,
  );

  if (!group) {
    throw new Error(`Runtime is missing projection group '${projectionName}' for context '${contextName}'.`);
  }

  return group;
}

export async function rebuildContextProjectionGroup(
  runtime: Readonly<{
    projectionGroups: readonly ContextProjectionGroup[];
  }>,
  contextName: string,
  projectionName: string,
): Promise<void> {
  await rebuildProjectionGroup(getProjectionGroup(runtime, contextName, projectionName));
}

function getProjectionOperationsPool(
  runtime: Readonly<{
    mountedContexts: readonly MountedContextRuntimeEntry[];
    subscriptionRunners: readonly ContextSubscriptionRunner[];
  }>,
  projectionKey: string,
): PgTransactionalPool {
  const subscriptionRunner = runtime.subscriptionRunners.find((runner) => runner.checkpointKey === projectionKey);
  const subscriptionTarget = subscriptionRunner
    ? runtime.mountedContexts.find((entry) => entry.contextName === subscriptionRunner.targetContextName)
    : null;
  if (subscriptionTarget) {
    return subscriptionTarget.pool;
  }

  const projectorContext = runtime.mountedContexts.find((entry) =>
    entry.projectors.some((projector) => projector.projectorName === projectionKey),
  );
  if (projectorContext) {
    return projectorContext.pool;
  }

  throw new Error(`Runtime is missing projection operations storage for '${projectionKey}'.`);
}

export async function listProjectionBlockedStreamDetails(
  runtime: Readonly<{
    mountedContexts: readonly MountedContextRuntimeEntry[];
    subscriptionRunners: readonly ContextSubscriptionRunner[];
  }>,
  projectionKey: string,
  options: Readonly<{
    poisonEventLimit?: number;
  }> = {},
): Promise<ProjectionBlockedStreamDetails> {
  const pool = getProjectionOperationsPool(runtime, projectionKey);
  const store = createPostgresProjectionStore({ db: pool });

  return {
    projectionKey,
    blockedStreams: (await store.listBlockedStreams?.(projectionKey)) ?? [],
    poisonEvents: (await store.listPoisonEvents?.(projectionKey, options.poisonEventLimit ?? 50)) ?? [],
  };
}

export async function retryProjectionBlockedStream(
  runtime: Readonly<{
    subscriptionRunners: readonly ContextSubscriptionRunner[];
  }>,
  projectionKey: string,
  streamId: string,
): Promise<ProjectionStreamRetryResult> {
  const runner = runtime.subscriptionRunners.find((candidate) => candidate.checkpointKey === projectionKey);
  if (!runner) {
    throw new Error(
      `Runtime is missing subscription runner '${projectionKey}'. Local projector stream retry is not available through this operation yet.`,
    );
  }

  return runner.retryBlockedStream(streamId);
}

export function listProjectionGroupStatuses(
  runtime: Readonly<{
    projectionGroups: readonly ContextProjectionGroup[];
  }>,
  options: Readonly<{
    contextName?: string;
    requiredOnly?: boolean;
  }> = {},
): readonly ContextProjectionGroupStatus[] {
  return sortProjectionGroups(
    runtime.projectionGroups.filter(
      (group) =>
        (!options.contextName || group.targetContextName === options.contextName) &&
        (!options.requiredOnly || group.requiredDuringBootstrap),
    ),
  ).map((group) => group.getStatus());
}

export async function refreshProjectionGroupStatuses(
  runtime: Readonly<{
    projectionGroups: readonly ContextProjectionGroup[];
  }>,
  options: Readonly<{
    contextName?: string;
    requiredOnly?: boolean;
  }> = {},
): Promise<readonly ContextProjectionGroupStatus[]> {
  const groups = sortProjectionGroups(
    runtime.projectionGroups.filter(
      (group) =>
        (!options.contextName || group.targetContextName === options.contextName) &&
        (!options.requiredOnly || group.requiredDuringBootstrap),
    ),
  );

  await mapWithConcurrency(groups, PROJECTION_STATUS_REFRESH_CONCURRENCY, async (group) => {
    await group.refreshStatus();

    await mapWithConcurrency(
      sortSubscriptionRunners(group.subscriptionRunners),
      PROJECTION_STATUS_REFRESH_CONCURRENCY,
      (runner) => runner.refreshStatus(),
    );
  });

  return groups.map((group) => group.getStatus());
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex] as T);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));

  return results;
}

export function summarizeProjectionReplayStatuses(
  statuses: readonly ContextProjectionGroupStatus[],
): ProjectionReplaySummary {
  const contexts = [...new Set(statuses.map((status) => status.targetContextName))]
    .sort((left, right) => left.localeCompare(right))
    .map((contextName) => {
      const contextStatuses = statuses.filter((status) => status.targetContextName === contextName);

      return {
        contextName,
        totalGroups: contextStatuses.length,
        requiredGroups: contextStatuses.filter((status) => status.requiredDuringBootstrap).length,
        initializedGroups: contextStatuses.filter((status) => status.initialized).length,
        caughtUpGroups: contextStatuses.filter((status) => status.caughtUp).length,
        behindGroups: contextStatuses.filter((status) => !status.caughtUp).length,
        staleGroups: contextStatuses.filter((status) => status.revisionStale).length,
        runningGroups: contextStatuses.filter((status) => status.state === "running").length,
        errorGroups: contextStatuses.filter((status) => status.state === "error").length,
        outstandingEventCount: sumDecimalCounts(contextStatuses.map((status) => status.outstandingEventCount)),
      } satisfies ProjectionReplayContextSummary;
    });

  const totalGroups = statuses.length;
  const requiredGroups = statuses.filter((status) => status.requiredDuringBootstrap).length;
  const initializedGroups = statuses.filter((status) => status.initialized).length;
  const caughtUpGroups = statuses.filter((status) => status.caughtUp).length;
  const behindGroups = statuses.filter((status) => !status.caughtUp).length;
  const staleGroups = statuses.filter((status) => status.revisionStale).length;
  const runningGroups = statuses.filter((status) => status.state === "running").length;
  const errorGroups = statuses.filter((status) => status.state === "error").length;
  const outstandingEventCount = sumDecimalCounts(statuses.map((status) => status.outstandingEventCount));
  const requiredStatuses = statuses.filter((status) => status.requiredDuringBootstrap);
  const status = requiredStatuses.some((entry) => !entry.caughtUp || entry.revisionStale || entry.state === "error")
    ? "degraded"
    : "ok";

  return {
    status,
    totalGroups,
    requiredGroups,
    initializedGroups,
    caughtUpGroups,
    behindGroups,
    staleGroups,
    runningGroups,
    errorGroups,
    outstandingEventCount,
    contexts,
  };
}

export function getProjectionReplaySummary(
  runtime: Readonly<{
    projectionGroups: readonly ContextProjectionGroup[];
  }>,
  options: Readonly<{
    contextName?: string;
    requiredOnly?: boolean;
  }> = {},
): ProjectionReplaySummary {
  return summarizeProjectionReplayStatuses(listProjectionGroupStatuses(runtime, options));
}

export async function refreshProjectionReplaySummary(
  runtime: Readonly<{
    projectionGroups: readonly ContextProjectionGroup[];
  }>,
  options: Readonly<{
    contextName?: string;
    requiredOnly?: boolean;
  }> = {},
): Promise<ProjectionReplaySummary> {
  return summarizeProjectionReplayStatuses(await refreshProjectionGroupStatuses(runtime, options));
}

export async function rebuildAllContextProjectionGroups(
  runtime: Readonly<{
    projectionGroups: readonly ContextProjectionGroup[];
  }>,
  contextName: string,
  options: Readonly<{
    requiredOnly?: boolean;
  }> = {},
): Promise<void> {
  const groups = sortProjectionGroups(
    runtime.projectionGroups.filter(
      (group) => group.targetContextName === contextName && (!options.requiredOnly || group.requiredDuringBootstrap),
    ),
  );

  if (groups.length === 0) {
    throw new Error(`Runtime is missing projection groups for context '${contextName}'.`);
  }

  for (const group of groups) {
    await rebuildProjectionGroup(group);
  }
}

export async function drainContextRuntime(
  runtime: Readonly<{
    projectors: readonly BcProjector[];
    subscriptionRunners?: readonly ContextSubscriptionRunner[];
  }>,
): Promise<void> {
  await drainContextProcesses({
    projectors: runtime.projectors,
    subscriptionRunners: runtime.subscriptionRunners,
  });
}

export function collectProjectors<
  TServices extends {
    projectors: readonly BcProjector[];
  },
>(servicesList: readonly TServices[]): readonly BcProjector[] {
  return servicesList.flatMap((services) => services.projectors);
}

export function createContextServices<TServices, TPool, TPorts>(
  module: BcApiModule<TServices, TPool, TPorts>,
  pool: TPool,
  ports: TPorts,
): TServices {
  return module.createServices(pool, ports);
}

export function composeSchemaSql(modules: readonly Pick<BcApiModule, "schemaSql">[]): string {
  const eventCoreSchemaSql = eventCorePostgresSchemaSql.trim();
  let eventCoreIncluded = false;

  const schemaParts = modules
    .map((module) => module.schemaSql.trim())
    .map((schemaSql) => {
      if (!schemaSql.startsWith(eventCoreSchemaSql)) {
        return schemaSql;
      }

      if (!eventCoreIncluded) {
        eventCoreIncluded = true;
        return schemaSql;
      }

      return schemaSql.slice(eventCoreSchemaSql.length).trim();
    })
    .filter((schemaSql) => schemaSql.length > 0);

  return schemaParts.join("\n\n");
}

export function composeApiModules<
  TPool,
  TModules extends readonly Readonly<{
    module: BcApiModule<unknown, TPool, unknown>;
    ports: unknown;
  }>[],
>(
  pool: TPool,
  modules: TModules,
): {
  [K in keyof TModules]: TModules[K] extends Readonly<{
    module: BcApiModule<infer TServices, TPool, infer _TPorts>;
    ports: infer _TProvidedPorts;
  }>
    ? Readonly<{
        module: TModules[K]["module"];
        services: TServices;
      }>
    : never;
} {
  return modules.map(({ module, ports }) => ({
    module,
    services: module.createServices(pool, ports),
  })) as {
    [K in keyof TModules]: TModules[K] extends Readonly<{
      module: BcApiModule<infer TServices, TPool, infer _TPorts>;
      ports: infer _TProvidedPorts;
    }>
      ? Readonly<{
          module: TModules[K]["module"];
          services: TServices;
        }>
      : never;
  };
}

export type ResolvedApiMount<TRouter = unknown> = BcApiMount &
  Readonly<{
    contextName: string;
    router: TRouter;
  }>;

export function createResolvedApiMount<TRouter>(
  contextName: string,
  mount: Readonly<{
    mountPath: string;
    kind: string;
    requiresAuth: boolean;
    drainProjectorsOnWrite: boolean;
  }>,
  router: TRouter,
): ResolvedApiMount<TRouter> {
  if (mount.kind !== "primary" && mount.kind !== "additional") {
    throw new Error(`Invalid API mount kind '${mount.kind}' for context '${contextName}'.`);
  }

  return {
    contextName,
    mountPath: mount.mountPath,
    kind: mount.kind,
    requiresAuth: mount.requiresAuth,
    drainProjectorsOnWrite: mount.drainProjectorsOnWrite,
    router,
  };
}

export function resolveContextApiMounts<TRouter>(
  contextName: string,
  mounts: readonly Readonly<{
    mountPath: string;
    kind: string;
    requiresAuth: boolean;
    drainProjectorsOnWrite: boolean;
  }>[],
  routers: readonly TRouter[],
): readonly ResolvedApiMount<TRouter>[] {
  if (mounts.length !== routers.length) {
    throw new Error(
      `Context '${contextName}' declared ${mounts.length} API mounts but provided ${routers.length} routers.`,
    );
  }

  return mounts.map((mount, index) => createResolvedApiMount(contextName, mount, routers[index]));
}

export function resolveModuleApiMounts<TServices, TPool, TPorts, TRouter>(
  module: Pick<BcApiModule<TServices, TPool, TPorts, TRouter>, "contextName" | "apiMounts" | "buildApis">,
  services: TServices,
): readonly ResolvedApiMount<TRouter>[] {
  return resolveContextApiMounts(module.contextName, module.apiMounts, module.buildApis(services));
}

function normalizeMountWildcard(mountPath: string) {
  return mountPath.endsWith("/*") ? mountPath : `${mountPath}/*`;
}

function uniqueMountPaths(paths: readonly string[]) {
  return [...new Set(paths)];
}

export function attachApiMountMiddleware(
  app: Readonly<{
    use(path: string, middleware: unknown): unknown;
  }>,
  mountPaths: readonly string[],
  middleware: unknown,
): void {
  for (const mountPath of uniqueMountPaths(mountPaths)) {
    app.use(normalizeMountWildcard(mountPath), middleware);
  }
}

export function attachWriteDrainMiddleware(
  app: Readonly<{
    use(path: string, middleware: (context: unknown, next: () => Promise<void>) => Promise<void>): unknown;
  }>,
  mounts: readonly Pick<ResolvedApiMount, "mountPath" | "drainProjectorsOnWrite">[],
  drain: () => Promise<void>,
): void {
  const writeDrainPaths = mounts.filter((mount) => mount.drainProjectorsOnWrite).map((mount) => mount.mountPath);

  for (const mountPath of uniqueMountPaths(writeDrainPaths)) {
    app.use(normalizeMountWildcard(mountPath), async (context: unknown, next) => {
      await next();

      const req = (context as { req?: { method?: string } }).req;
      const method = req?.method?.toUpperCase() ?? "GET";

      if (method !== "GET" && method !== "HEAD") {
        await drain();
      }
    });
  }
}

export function attachWriteConsistencyMiddleware(
  app: Readonly<{
    use(path: string, middleware: (context: unknown, next: () => Promise<void>) => Promise<void>): unknown;
  }>,
  mounts: readonly Pick<ResolvedApiMount, "mountPath">[],
): void {
  for (const mountPath of uniqueMountPaths(mounts.map((mount) => mount.mountPath))) {
    app.use(normalizeMountWildcard(mountPath), async (context: unknown, next) => {
      await runWithEventCommitMetadata(next);

      const req = (context as { req?: { method?: string } }).req;
      const method = req?.method?.toUpperCase() ?? "GET";
      if (method === "GET" || method === "HEAD") {
        return;
      }

      const metadata = getEventCommitMetadata();
      if (metadata.eventIds.length === 0) {
        return;
      }

      const header = (context as { header?: (name: string, value: string) => void }).header;
      if (!header) {
        return;
      }

      header("Chase-Sets-Consistency", "eventual");
      if (metadata.maxGlobalPosition) {
        header("Chase-Sets-Commit-Position", metadata.maxGlobalPosition);
      }

      const compactEventIds = metadata.eventIds.join(",");
      if (compactEventIds.length <= 4_000) {
        header("Chase-Sets-Commit-Event-Ids", compactEventIds);
      }
    });
  }
}

export function mountApiRouters(
  app: Readonly<{
    route(path: string, router: unknown): unknown;
  }>,
  mounts: readonly ResolvedApiMount[],
): void {
  for (const mount of mounts) {
    app.route(mount.mountPath, mount.router);
  }
}

export function createForwardedAuthHeaders(request: Request, initHeaders?: HeadersInit): Headers {
  const headers = new Headers(initHeaders);
  const cookie = request.headers.get("cookie");
  const authorization = request.headers.get("authorization");

  if (cookie && !headers.has("cookie")) {
    headers.set("cookie", cookie);
  }

  if (authorization && !headers.has("authorization")) {
    headers.set("authorization", authorization);
  }

  return headers;
}

export function createForwardedAuthFetch(
  request: Request,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return (input, init = {}) =>
    fetchImpl(input, {
      ...init,
      credentials: init.credentials ?? "include",
      headers: createForwardedAuthHeaders(request, init.headers),
    });
}

export function resolveRequestApiBaseUrl(request: Request, apiBasePath: string): string {
  const url = new URL(request.url);
  return `${url.origin}${apiBasePath}`;
}

export async function countEventsWithPrefix(
  pool: {
    query: (
      sql: string,
      params?: readonly unknown[],
    ) => Promise<{ rows?: readonly Readonly<{ count?: string | number }>[] }>;
  },
  prefix: string,
): Promise<number> {
  const result = await pool.query("SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE $1", [
    `${prefix}%`,
  ]);

  return Number(result.rows?.[0]?.count ?? 0);
}

export async function seedApiModuleIfEmpty<TPool>(
  module: Pick<BcApiModule<unknown, TPool, unknown>, "contextName" | "streamPrefix" | "seed" | "seedProfiles">,
  pool: TPool & {
    query: (
      sql: string,
      params?: readonly unknown[],
    ) => Promise<{ rows?: readonly Readonly<{ count?: string | number }>[] }>;
  },
  services?: unknown,
  options: BcSeedOptions = defaultSeedOptions,
): Promise<void> {
  if (!module.seed) {
    return;
  }
  if (!seedProfilesOverlap(module.seedProfiles, options)) {
    console.log(`${module.contextName} seed skipped for data profiles: ${options.enabledDataProfiles.join(", ")}.`);
    return;
  }

  const eventCount = await countEventsWithPrefix(pool, module.streamPrefix);

  if (eventCount === 0) {
    console.log(`Seeding ${module.contextName} data...`);
  } else {
    console.log(`${module.contextName} events already exist. Running seed reconciliation.`);
  }

  await module.seed(pool, services, options);
}

export async function seedApiModulesIfEmpty<TPool>(
  modules: readonly Pick<
    BcApiModule<unknown, TPool, unknown>,
    "contextName" | "streamPrefix" | "seed" | "seedProfiles"
  >[],
  pool: TPool & {
    query: (
      sql: string,
      params?: readonly unknown[],
    ) => Promise<{ rows?: readonly Readonly<{ count?: string | number }>[] }>;
  },
  options: BcSeedOptions = defaultSeedOptions,
): Promise<void> {
  for (const module of modules) {
    await seedApiModuleIfEmpty(module, pool, undefined, options);
  }
}

export async function bootstrapApiModule<TServices, TPool, TPorts>(
  module: BcApiModule<TServices, TPool, TPorts>,
  pool: TPool & {
    query: (
      sql: string,
      params?: readonly unknown[],
    ) => Promise<{ rows?: readonly Readonly<{ count?: string | number }>[] }>;
  },
  ports: TPorts,
  options: Readonly<{
    databaseLabel?: string;
    completionLabel?: string;
  }> = {},
): Promise<TServices> {
  const completionLabel = options.completionLabel ?? module.contextName;
  await waitForDatabase(pool, options.databaseLabel ?? completionLabel);
  await pool.query(composeModuleSchemaSql(module));
  await seedApiModuleIfEmpty(module, pool);
  const services = module.createServices(pool, ports);
  await drainProjectors(module.projectors(services));
  console.log(`${completionLabel} projections are up to date.`);
  console.log(`${completionLabel} bootstrap complete.`);
  return services;
}

export function buildOpenGraphMeta({
  title,
  description = title,
  siteName = "Chase Sets",
  imageUrl,
  type = "website",
}: Readonly<{
  title: string;
  description?: string;
  siteName?: string;
  imageUrl?: string;
  type?: "website" | "product";
}>) {
  const meta = [
    { title },
    { name: "description", content: description },
    { property: "og:site_name", content: siteName },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { property: "og:type", content: type },
    {
      name: "twitter:card",
      content: imageUrl ? "summary_large_image" : "summary",
    },
  ];

  if (imageUrl) {
    meta.push({ property: "og:image", content: imageUrl });
  }

  return meta;
}
