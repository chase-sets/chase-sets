import type { BcEventSubscription } from "@chase-sets/bounded-context-module";
import { ZERO_GLOBAL_POSITION, toTransportEvent } from "@chase-sets/event-core";
import type {
  ProjectionBlockedStream,
  ProjectionErrorSummary,
  ProjectionRunContext,
} from "@chase-sets/event-core/projector";
import { parseGlobalPosition, type GlobalPosition, type StreamVersion } from "@chase-sets/event-core/storage";
import {
  buildStreamPrefixFilterSql,
  readGapSafeEventStoreHead,
  type PgQueryable,
  type PgTransactionalPool,
  type ProjectionCascadeController,
  type ProjectionCascadeCursor,
} from "@chase-sets/event-core-postgres";
import { SUBSCRIPTION_CHECKPOINTS_TABLE } from "./schema";
import { withProjectionTransaction } from "./projection-transactions";

const CASCADE_PROGRESS_TABLE = "event_projection_cascade_progress";
const PROJECTION_RECOVERY_MARKERS_TABLE = "event_projection_recovery_markers";

export async function loadCascadeCursor(
  db: PgQueryable,
  projectionKey: string,
  eventId: string,
  ordinal: number,
): Promise<ProjectionCascadeCursor> {
  const result = await db.query<Readonly<{ cursor_id: string | null; completed: boolean }>>(
    `SELECT cursor_id, completed
     FROM ${CASCADE_PROGRESS_TABLE}
     WHERE projection_key = $1 AND event_id = $2 AND cascade_ordinal = $3`,
    [projectionKey, eventId, ordinal],
  );
  const row = result.rows[0];
  return { cursorId: row?.cursor_id ?? null, completed: row?.completed ?? false };
}

export async function saveCascadeCursor(
  db: PgQueryable,
  projectionKey: string,
  eventId: string,
  ordinal: number,
  cursorId: string | null,
  completed: boolean,
): Promise<void> {
  await db.query(
    `INSERT INTO ${CASCADE_PROGRESS_TABLE} (projection_key, event_id, cascade_ordinal, cursor_id, completed, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (projection_key, event_id, cascade_ordinal)
     DO UPDATE SET cursor_id = EXCLUDED.cursor_id, completed = EXCLUDED.completed, updated_at = now()`,
    [projectionKey, eventId, ordinal, cursorId, completed],
  );
}

export async function clearCascadeProgress(db: PgQueryable, projectionKey: string, eventId?: string): Promise<void> {
  if (eventId === undefined) {
    await db.query(`DELETE FROM ${CASCADE_PROGRESS_TABLE} WHERE projection_key = $1`, [projectionKey]);
    return;
  }
  await db.query(`DELETE FROM ${CASCADE_PROGRESS_TABLE} WHERE projection_key = $1 AND event_id = $2`, [
    projectionKey,
    eventId,
  ]);
}

/**
 * Concrete per-event cascade controller backed by the cascade-progress table on the
 * current projection transaction. The runner installs it around the handler; cascade
 * choke points drive it through `runBoundedProjectionCascade`. `refreshedCount()`
 * lets the runner report forward progress even when the checkpoint stays pinned.
 */
export function createDbProjectionCascadeController(
  db: PgQueryable,
  input: Readonly<{ projectionKey: string; eventId: string; budget: number }>,
): ProjectionCascadeController & Readonly<{ refreshedCount: () => number }> {
  let ordinal = -1;
  let remaining = Math.max(0, Math.floor(input.budget));
  let exhausted = false;
  let refreshed = 0;

  return {
    nextOrdinal: () => (ordinal += 1),
    budgetRemaining: () => remaining,
    isExhausted: () => exhausted,
    consume: (count: number) => {
      remaining -= count;
      refreshed += count;
    },
    markExhausted: () => {
      exhausted = true;
    },
    refreshedCount: () => refreshed,
    loadCursor: (cursorOrdinal: number) => loadCascadeCursor(db, input.projectionKey, input.eventId, cursorOrdinal),
    saveCursor: (cursorOrdinal: number, cursorId: string | null, completed: boolean) =>
      saveCascadeCursor(db, input.projectionKey, input.eventId, cursorOrdinal, cursorId, completed),
  };
}

const SUBSCRIPTION_APPLICATION_LEDGER_RETAIN_APPLIED_EVENTS = 10_000n;

type SubscriptionCheckpointRow = Readonly<{
  last_global_position: string | number | bigint;
}>;

export type SubscriptionCheckpointRecoveryState = Readonly<{
  checkpoint: GlobalPosition | null;
  recoveryRequired: boolean;
}>;

type ProjectionGroupRevisionRow = Readonly<{
  projection_revision: string | number | bigint;
}>;

type SubscriptionApplicationRow = Readonly<{
  status: string;
}>;

export type SubscriptionApplicationClaimResult = "claimed" | "already-applied";

export type InlineSubscriptionApplicationClaimResult =
  | "claimed"
  | "already-applied"
  | "blocked-stream"
  | "predecessor-gap"
  | "in-flight";

export function createCheckpointKey(
  subscription: Pick<BcEventSubscription, "projectionName" | "sourceContextName" | "subscriptionVersion">,
): string {
  // Checkpoint rows are currently single-tenant: this key deliberately has no tenant qualifier.
  // If the event store becomes tenant-partitioned, update checkpoint identity and migrate existing rows together.
  return [subscription.projectionName, subscription.sourceContextName, `v${subscription.subscriptionVersion}`].join(
    ":",
  );
}

function leaseFencingToken(context: ProjectionRunContext | undefined): string | null {
  return context?.fencingToken && /^\d+$/.test(context.fencingToken) ? context.fencingToken : null;
}

export async function loadSubscriptionCheckpoint(
  db: PgQueryable,
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

export async function loadSubscriptionCheckpointRecoveryState(
  db: PgQueryable,
  checkpointKey: string,
): Promise<SubscriptionCheckpointRecoveryState> {
  const result = await db.query<
    Readonly<{
      last_global_position: string | number | bigint;
      recovery_global_position: string | number | bigint | null;
    }>
  >(
    `SELECT checkpoint.last_global_position,
            recovery.last_global_position AS recovery_global_position
     FROM ${SUBSCRIPTION_CHECKPOINTS_TABLE} AS checkpoint
     LEFT JOIN ${PROJECTION_RECOVERY_MARKERS_TABLE} AS recovery
       ON recovery.projection_kind = 'subscription'
      AND recovery.projection_key = checkpoint.checkpoint_key
     WHERE checkpoint.checkpoint_key = $1`,
    [checkpointKey],
  );
  const row = result.rows[0];
  if (!row) {
    return { checkpoint: null, recoveryRequired: false };
  }

  const checkpoint = parseGlobalPosition(String(row.last_global_position));
  const recoveryPosition =
    row.recovery_global_position === null ? null : parseGlobalPosition(String(row.recovery_global_position));
  return {
    checkpoint,
    recoveryRequired: recoveryPosition === null || BigInt(recoveryPosition) < BigInt(checkpoint),
  };
}

export async function saveSubscriptionCheckpoint(
  db: PgTransactionalPool,
  subscription: Pick<BcEventSubscription, "projectionName" | "sourceContextName" | "subscriptionVersion">,
  lastGlobalPosition: GlobalPosition,
  context?: ProjectionRunContext,
): Promise<void> {
  const checkpointKey = createCheckpointKey(subscription);
  const fencingToken = leaseFencingToken(context);
  await withProjectionTransaction(
    db,
    context,
    async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('event_subscription_checkpoints:' || $1::text, 0))",
        [checkpointKey],
      );
      const result = await client.query(
        `WITH saved_checkpoint AS (
     INSERT INTO ${SUBSCRIPTION_CHECKPOINTS_TABLE} (
       checkpoint_key,
       projection_name,
       source_context_name,
       subscription_version,
       last_global_position,
       lease_owner_id,
       lease_fencing_token,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5::bigint, $6, $7::bigint, now())
     ON CONFLICT (checkpoint_key)
     DO UPDATE SET
        last_global_position = CASE
          WHEN NOT EXISTS (
            SELECT 1
            FROM ${PROJECTION_RECOVERY_MARKERS_TABLE} AS recovery
            WHERE recovery.projection_kind = 'subscription'
              AND recovery.projection_key = ${SUBSCRIPTION_CHECKPOINTS_TABLE}.checkpoint_key
              AND recovery.last_global_position >= ${SUBSCRIPTION_CHECKPOINTS_TABLE}.last_global_position
          ) THEN EXCLUDED.last_global_position
          ELSE GREATEST(${SUBSCRIPTION_CHECKPOINTS_TABLE}.last_global_position, EXCLUDED.last_global_position)
        END,
       lease_owner_id = EXCLUDED.lease_owner_id,
       lease_fencing_token = GREATEST(
         COALESCE(${SUBSCRIPTION_CHECKPOINTS_TABLE}.lease_fencing_token, 0),
         COALESCE(EXCLUDED.lease_fencing_token, 0)
       ),
       updated_at = EXCLUDED.updated_at
      WHERE EXCLUDED.lease_fencing_token IS NULL
         OR ${SUBSCRIPTION_CHECKPOINTS_TABLE}.lease_fencing_token IS NULL
         OR EXCLUDED.lease_fencing_token >= ${SUBSCRIPTION_CHECKPOINTS_TABLE}.lease_fencing_token
      RETURNING checkpoint_key, last_global_position, updated_at
     )
     INSERT INTO ${PROJECTION_RECOVERY_MARKERS_TABLE} (
       projection_kind,
       projection_key,
       last_global_position,
       updated_at
     )
     SELECT 'subscription', checkpoint_key, last_global_position, updated_at
     FROM saved_checkpoint
     ON CONFLICT (projection_kind, projection_key)
     DO UPDATE SET
       last_global_position = GREATEST(
         ${PROJECTION_RECOVERY_MARKERS_TABLE}.last_global_position,
         EXCLUDED.last_global_position
       ),
       updated_at = EXCLUDED.updated_at`,
        [
          checkpointKey,
          subscription.projectionName,
          subscription.sourceContextName,
          subscription.subscriptionVersion,
          lastGlobalPosition,
          context?.ownerId ?? null,
          fencingToken,
        ],
      );
      if (result.rowCount != null && result.rowCount < 1) {
        throw new Error(`Subscription checkpoint '${checkpointKey}' rejected stale lease fencing token.`);
      }
    },
    {},
    { abortSignal: context?.signal },
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

export async function loadSubscriptionApplicationStatuses(
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

/**
 * Returns true only when every receipt id is a real source event and every event
 * this subscription matches has completed application. Inline Apply is limited
 * to same-context projections, so the source event rows and application ledger
 * are deliberately read in one indexed statement from the same database.
 */
export async function areSubscribedReceiptEventsApplied(
  db: PgQueryable,
  projectionKey: string,
  eventIds: readonly string[],
  eventTypes: readonly string[],
  streamPrefixes?: readonly string[],
): Promise<boolean> {
  const uniqueEventIds = [...new Set(eventIds)];
  const uniqueEventTypes = [...new Set(eventTypes)];
  if (uniqueEventIds.length === 0 || uniqueEventTypes.length === 0) {
    return false;
  }

  const params: unknown[] = [projectionKey, uniqueEventIds, uniqueEventTypes];
  const subscriptionPredicates = ["event_type = ANY($3::text[])"];
  if (streamPrefixes?.length) {
    const streamPrefixFilter = buildStreamPrefixFilterSql(streamPrefixes, params.length + 1);
    if (streamPrefixFilter) {
      params.push(...streamPrefixFilter.params);
      subscriptionPredicates.push(streamPrefixFilter.predicate);
    }
  }

  const result = await db.query<Readonly<{ fresh: boolean }>>(
    `WITH receipt_events AS MATERIALIZED (
       SELECT event_id, stream_id, stream_context_name, event_type
       FROM event_store_events
       WHERE event_id = ANY($2::text[])
     ),
     subscribed_events AS MATERIALIZED (
       SELECT event_id, stream_id
       FROM receipt_events
       WHERE ${subscriptionPredicates.join("\n         AND ")}
     )
     SELECT
       NOT EXISTS (
         SELECT 1
         FROM unnest($2::text[]) AS receipt_id(event_id)
         LEFT JOIN receipt_events AS stored_event
           ON stored_event.event_id = receipt_id.event_id
         WHERE stored_event.event_id IS NULL
       )
       AND NOT EXISTS (
         SELECT 1
         FROM subscribed_events AS event
         LEFT JOIN event_subscription_applications AS application
           ON application.projection_key = $1
          AND application.event_id = event.event_id
         LEFT JOIN event_projection_blocked_streams AS blocked_stream
           ON blocked_stream.projection_key = $1
          AND blocked_stream.stream_id = event.stream_id
          AND blocked_stream.state IN ('blocked', 'retrying')
         LEFT JOIN event_projection_poison_events AS poison_event
           ON poison_event.projection_key = $1
          AND poison_event.event_id = event.event_id
          AND poison_event.state IN ('blocked', 'retrying')
         WHERE application.status IS DISTINCT FROM 'applied'
            OR blocked_stream.projection_key IS NOT NULL
            OR poison_event.projection_key IS NOT NULL
       ) AS fresh`,
    params,
  );

  return result.rows[0]?.fresh === true;
}

/**
 * Elapsed time since a subscription application row was first claimed. `started_at`
 * is written once on the initial claim and preserved across re-claims, so it is a
 * durable "stuck since" marker for an event that keeps failing. Uses the database
 * clock to avoid app/DB clock skew. Returns `null` when the row does not exist.
 */
export async function loadSubscriptionApplicationAgeMs(
  db: PgQueryable,
  projectionKey: string,
  eventId: string,
): Promise<number | null> {
  const result = await db.query<Readonly<{ age_ms: string | number | null }>>(
    `SELECT EXTRACT(EPOCH FROM (now() - started_at)) * 1000 AS age_ms
     FROM event_subscription_applications
     WHERE projection_key = $1
       AND event_id = $2`,
    [projectionKey, eventId],
  );
  const ageMs = result.rows[0]?.age_ms;
  if (ageMs === null || ageMs === undefined) {
    return null;
  }
  const parsed = typeof ageMs === "number" ? ageMs : Number(ageMs);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : null;
}

export async function claimSubscriptionApplication(
  db: PgQueryable,
  projectionKey: string,
  event: Readonly<ReturnType<typeof toTransportEvent>>,
  context?: ProjectionRunContext,
): Promise<SubscriptionApplicationClaimResult> {
  const eventId = String(event.id);
  const fencingToken = leaseFencingToken(context);
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
       lease_owner_id,
       lease_fencing_token,
       started_at,
       updated_at
     ) VALUES ($1, $2, $3, $4::bigint, $5::bigint, $6, 'started', NULL, $7, $8::bigint, now(), now())
     ON CONFLICT (projection_key, event_id)
     DO NOTHING
     RETURNING status`,
    [
      projectionKey,
      eventId,
      event.streamId,
      event.streamVersion,
      event.globalPosition,
      event.type,
      context?.ownerId ?? null,
      fencingToken,
    ],
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

  const updateResult = await db.query(
    `UPDATE event_subscription_applications
     SET status = 'started',
         error_message = NULL,
         lease_owner_id = $3,
         lease_fencing_token = $4::bigint,
         updated_at = now()
     WHERE projection_key = $1
       AND event_id = $2
       AND status <> 'applied'
       AND (
         $4::bigint IS NULL
         OR lease_fencing_token IS NULL
         OR $4::bigint >= lease_fencing_token
       )`,
    [projectionKey, eventId, context?.ownerId ?? null, fencingToken],
  );
  if (updateResult.rowCount != null && updateResult.rowCount < 1) {
    throw new Error(`Projection application '${projectionKey}:${eventId}' rejected stale lease fencing token.`);
  }

  return "claimed";
}

/**
 * Claims an application only when inline execution cannot overtake the stream or
 * an existing applier. Unlike the runner claim, this never locks or rewrites an
 * existing ledger row; contention and every non-applied row defer to the runner.
 */
export async function claimInlineSubscriptionApplication(
  db: PgQueryable,
  projectionKey: string,
  event: Readonly<ReturnType<typeof toTransportEvent>>,
  lockTimeoutMs = 1,
): Promise<InlineSubscriptionApplicationClaimResult> {
  const result = await db.query<Readonly<{ outcome: InlineSubscriptionApplicationClaimResult }>>(
    `WITH lock_budget AS MATERIALIZED (
       SELECT set_config('lock_timeout', $7, true)
     ),
     blocked_stream AS (
       SELECT 1
       FROM event_projection_blocked_streams
       WHERE projection_key = $1
         AND stream_id = $3
         AND state IN ('blocked', 'retrying')
     ),
     predecessor AS (
       SELECT event_id, global_position
       FROM event_store_events
       WHERE stream_id = $3
         AND stream_version = $4::bigint - 1
     ),
     checkpoint AS (
       SELECT last_global_position
       FROM ${SUBSCRIPTION_CHECKPOINTS_TABLE}
       WHERE checkpoint_key = $1
     ),
     predecessor_application AS (
       SELECT application.status
       FROM event_subscription_applications AS application
       JOIN predecessor ON predecessor.event_id = application.event_id
       WHERE application.projection_key = $1
     ),
     eligibility AS (
       SELECT CASE
         WHEN EXISTS (SELECT 1 FROM blocked_stream) THEN 'blocked-stream'
         WHEN $4::bigint > 1
          AND (
            NOT EXISTS (SELECT 1 FROM predecessor)
            OR (
              COALESCE((SELECT last_global_position FROM checkpoint), 0) <
                (SELECT global_position FROM predecessor)
              AND COALESCE((SELECT status FROM predecessor_application), '') <> 'applied'
            )
          ) THEN 'predecessor-gap'
         ELSE 'eligible'
       END AS outcome
     ),
     claimed AS (
       INSERT INTO event_subscription_applications (
         projection_key,
         event_id,
         stream_id,
         stream_version,
         global_position,
         event_type,
         status,
         error_message,
         lease_owner_id,
         lease_fencing_token,
         started_at,
         updated_at
       )
       SELECT $1, $2, $3, $4::bigint, $5::bigint, $6, 'started', NULL, NULL, NULL, now(), now()
       FROM eligibility, lock_budget
       WHERE eligibility.outcome = 'eligible'
       ON CONFLICT (projection_key, event_id)
       DO NOTHING
       RETURNING status
     ),
     current_application AS (
       SELECT status
       FROM event_subscription_applications
       WHERE projection_key = $1
         AND event_id = $2
     )
     SELECT CASE
       WHEN eligibility.outcome = 'blocked-stream' THEN 'blocked-stream'
       WHEN eligibility.outcome = 'predecessor-gap' THEN 'predecessor-gap'
       WHEN EXISTS (SELECT 1 FROM claimed) THEN 'claimed'
       WHEN (SELECT status FROM current_application) = 'applied' THEN 'already-applied'
       ELSE 'in-flight'
     END AS outcome
     FROM eligibility`,
    [
      projectionKey,
      String(event.id),
      event.streamId,
      event.streamVersion,
      event.globalPosition,
      event.type,
      `${Math.max(1, Math.floor(lockTimeoutMs))}ms`,
    ],
  );

  return result.rows[0]?.outcome ?? "in-flight";
}

export async function recordSubscriptionApplicationCompleted(
  db: PgQueryable,
  projectionKey: string,
  eventId: string,
  status: "applied" | "poison" | "transient",
  error: unknown = null,
  context?: ProjectionRunContext,
): Promise<void> {
  const fencingToken = leaseFencingToken(context);
  const result = await db.query(
    `UPDATE event_subscription_applications
     SET status = $3,
         error_message = $4,
         updated_at = now()
     WHERE projection_key = $1
       AND event_id = $2
       AND ($5::bigint IS NULL OR lease_fencing_token = $5::bigint)`,
    [
      projectionKey,
      eventId,
      status,
      error instanceof Error ? error.message : error === null ? null : String(error),
      fencingToken,
    ],
  );
  if (result.rowCount != null && result.rowCount < 1) {
    throw new Error(`Projection application '${projectionKey}:${eventId}' was not claimed before completion.`);
  }
}

export async function recordSubscriptionApplicationFailure(
  db: PgTransactionalPool,
  projectionKey: string,
  event: Readonly<ReturnType<typeof toTransportEvent>>,
  status: "poison" | "transient",
  error: unknown,
  context?: ProjectionRunContext,
): Promise<SubscriptionApplicationClaimResult> {
  return withProjectionTransaction(db, context, async (client) => {
    const claimResult = await claimSubscriptionApplication(client, projectionKey, event, context);
    if (claimResult === "already-applied") {
      return claimResult;
    }

    await recordSubscriptionApplicationCompleted(client, projectionKey, String(event.id), status, error, context);
    return "claimed";
  });
}

export async function compactSubscriptionApplicationLedger(
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

export async function deleteSubscriptionCheckpoint(
  db: PgQueryable,
  checkpointKey: string,
  context?: ProjectionRunContext,
): Promise<void> {
  context?.throwIfLeaseLost?.();
  const fencingToken = leaseFencingToken(context);
  const checkpointDelete = await db.query(
    `DELETE FROM ${SUBSCRIPTION_CHECKPOINTS_TABLE}
     WHERE checkpoint_key = $1
       AND (
         $2::bigint IS NULL
         OR lease_fencing_token IS NULL
         OR $2::bigint >= lease_fencing_token
       )`,
    [checkpointKey, fencingToken],
  );
  if (checkpointDelete.rowCount === 0) {
    const currentCheckpoint = await loadSubscriptionCheckpoint(db, checkpointKey);
    if (currentCheckpoint !== null) {
      throw new Error(`Subscription checkpoint '${checkpointKey}' rejected stale reset fencing token.`);
    }
  }
  context?.throwIfLeaseLost?.();
  await db.query(
    `DELETE FROM event_subscription_applications
     WHERE projection_key = $1
       AND (
         $2::bigint IS NULL
         OR lease_fencing_token IS NULL
         OR $2::bigint >= lease_fencing_token
       )`,
    [checkpointKey, fencingToken],
  );
  await db.query(
    `DELETE FROM ${PROJECTION_RECOVERY_MARKERS_TABLE}
     WHERE projection_kind = 'subscription'
       AND projection_key = $1`,
    [checkpointKey],
  );
  context?.throwIfLeaseLost?.();
  await clearCascadeProgress(db, checkpointKey);
  await clearProjectionErrors(db, checkpointKey);
}

async function clearProjectionErrors(db: PgQueryable, projectionKey: string): Promise<void> {
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

export async function markProjectionBlockedStreamRetrying(
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

export async function markProjectionBlockedStreamBlocked(
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

export async function resolveProjectionBlockedStream(
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

export async function loadProjectionBlockedStream(
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

export async function recordProjectionPoisonEvent(
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

export async function recordProjectionDeferredBlockedStreamEvent(
  db: PgQueryable,
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

export async function loadProjectionErrorSummary(
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

export function isGlobalPositionGreater(left: GlobalPosition, right: GlobalPosition): boolean {
  return BigInt(left) > BigInt(right);
}

export function calculateOutstandingEventCount(
  lastGlobalPosition: GlobalPosition,
  sourceHeadGlobalPosition: GlobalPosition,
): string {
  const outstanding = BigInt(sourceHeadGlobalPosition) - BigInt(lastGlobalPosition);
  return outstanding > 0n ? outstanding.toString() : "0";
}

export function applyLagMetrics(
  status: {
    outstandingEventCount: string;
    sourceLagEventCount?: string;
    applicableLagEstimate?: string | null;
  },
  applicableLagEstimate: string | null = null,
): void {
  status.sourceLagEventCount = status.outstandingEventCount;
  status.applicableLagEstimate = applicableLagEstimate;
}

export function deriveSubscriptionReplayState(
  checkpoint: GlobalPosition,
  sourceHeadGlobalPosition: GlobalPosition,
  errorSummary: Pick<ProjectionErrorSummary, "blockedStreamCount" | "poisonEventCount">,
): "behind" | "caught-up" | "degraded" {
  if (errorSummary.blockedStreamCount > 0 || errorSummary.poisonEventCount > 0) {
    return "degraded";
  }

  return checkpoint === sourceHeadGlobalPosition ? "caught-up" : "behind";
}

function sumDecimalCounts(counts: readonly string[]): string {
  return counts.reduce((total, count) => total + BigInt(count), 0n).toString();
}

export async function readSourceHeadGlobalPosition(pool: PgTransactionalPool): Promise<GlobalPosition> {
  return readGapSafeEventStoreHead(pool);
}

export async function estimateApplicableLag(
  pool: PgTransactionalPool,
  afterGlobalPosition: GlobalPosition,
  eventTypes: readonly string[],
  streamPrefixes: readonly string[] | undefined,
): Promise<string | null> {
  if (eventTypes.length === 0) {
    return null;
  }

  const predicates = ["global_position > $1::bigint", "event_type = ANY($2::text[])"];
  const params: unknown[] = [afterGlobalPosition, [...new Set(eventTypes)]];

  if (streamPrefixes?.length) {
    const streamPrefixFilter = buildStreamPrefixFilterSql(streamPrefixes, params.length + 1);
    if (streamPrefixFilter) {
      params.push(...streamPrefixFilter.params);
      predicates.push(streamPrefixFilter.predicate);
    }
  }

  try {
    const result = await pool.query<Readonly<{ count: string | number | bigint }>>(
      `SELECT COUNT(*) AS count
       FROM event_store_events
       WHERE ${predicates.join("\n         AND ")}`,
      params,
    );

    return String(result.rows[0]?.count ?? "0");
  } catch {
    return null;
  }
}

export async function refreshSubscriptionStatus(
  targetPool: PgTransactionalPool,
  sourcePool: PgTransactionalPool,
  checkpointKey: string,
  status: {
    initialized: boolean;
    lastGlobalPosition: GlobalPosition;
    sourceHeadGlobalPosition: GlobalPosition;
    outstandingEventCount: string;
    state: "idle" | "behind" | "running" | "caught-up" | "degraded" | "error";
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
  applyLagMetrics(status);
  status.blockedStreamCount = errorSummary.blockedStreamCount;
  status.poisonEventCount = errorSummary.poisonEventCount;
  status.state = deriveSubscriptionReplayState(checkpoint, status.sourceHeadGlobalPosition, errorSummary);
  status.updatedAt = new Date().toISOString();
}
