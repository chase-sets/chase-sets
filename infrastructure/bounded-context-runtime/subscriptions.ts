import type {
  BcApiModule,
  BcEventSubscription,
  BcProjectionHandlerSet,
  BcSubscriptionHandlerKind,
} from "@chase-sets/bounded-context-module";
import { isTransientProjectionError, ZERO_GLOBAL_POSITION, toTransportEvent } from "@chase-sets/event-core";
import type {
  ProjectionBlockedStream,
  ProjectionPoisonEvent,
  ProjectionRunContext,
  ProjectorHandler,
  ProjectorRunResult,
} from "@chase-sets/event-core/projector";
import type { GlobalPosition } from "@chase-sets/event-core/storage";
import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  isPgRetryableTransientError,
  type PgTransactionalPool,
  type PgQueryable,
} from "@chase-sets/event-core-postgres";
import { runInProjectionDbContext, withProjectionTransaction } from "./projection-transactions";
import {
  applyLagMetrics,
  calculateOutstandingEventCount,
  claimSubscriptionApplication,
  compactSubscriptionApplicationLedger,
  createCheckpointKey,
  deleteSubscriptionCheckpoint,
  deriveSubscriptionReplayState,
  isGlobalPositionGreater,
  loadProjectionBlockedStream,
  loadProjectionErrorSummary,
  loadSubscriptionApplicationStatuses,
  loadSubscriptionCheckpoint,
  markProjectionBlockedStreamBlocked,
  markProjectionBlockedStreamRetrying,
  readSourceHeadGlobalPosition,
  recordProjectionDeferredBlockedStreamEvent,
  recordProjectionPoisonEvent,
  recordSubscriptionApplicationCompleted,
  recordSubscriptionApplicationFailure,
  refreshSubscriptionStatus,
  resolveProjectionBlockedStream,
  saveSubscriptionCheckpoint,
} from "./subscription-store";

export type SubscriptionReplayState = "idle" | "behind" | "running" | "caught-up" | "degraded" | "error";

export type ContextSubscriptionStatus = Readonly<{
  checkpointKey: string;
  subscriptionName: string;
  handlerKind?: BcSubscriptionHandlerKind;
  projectionName: string;
  sourceContextName: string;
  targetContextName: string;
  subscriptionVersion: number;
  initialized: boolean;
  lastGlobalPosition: GlobalPosition;
  sourceHeadGlobalPosition: GlobalPosition;
  sourceLagEventCount?: string;
  applicableLagEstimate?: string | null;
  outstandingEventCount: string;
  processedEvents: number;
  state: SubscriptionReplayState;
  lastError: string | null;
  blockedStreamCount: number;
  poisonEventCount: number;
  updatedAt: string;
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

export type SubscriptionLedgerMetrics = Readonly<{
  projectionKey: string;
  targetContextName: string;
  appliedRows: string;
  startedRows: string;
  poisonRows: string;
  transientRows: string;
  oldestStartedAt: string | null;
}>;

const IDLE_CHECKPOINT_FAST_FORWARD_MIN_GAP = 100n;
const IDLE_CHECKPOINT_FAST_FORWARD_HEARTBEAT_MS = 60_000;
const REACTION_CHECKPOINT_BATCH_SIZE = 1;

export type ContextSubscriptionRunner = Readonly<{
  subscriptionName: string;
  handlerKind?: BcSubscriptionHandlerKind;
  projectionName: string;
  sourceContextName: string;
  targetContextName: string;
  subscriptionVersion: number;
  checkpointKey: string;
  eventTypes?: readonly string[];
  streamPrefixes?: readonly string[];
  order: number;
  runOnce: (context?: ProjectionRunContext) => Promise<ProjectorRunResult>;
  getStatus: () => ContextSubscriptionStatus;
  refreshStatus: () => Promise<ContextSubscriptionStatus>;
  reset: (context?: ProjectionRunContext, options?: SubscriptionResetOptions) => Promise<void>;
  retryBlockedStream: (streamId: string, context?: ProjectionRunContext) => Promise<ProjectionStreamRetryResult>;
}>;

type SubscriptionResetOptions = Readonly<{
  db?: PgQueryable;
}>;

type ProjectionRunContextWithSourceHeadCache = ProjectionRunContext &
  Readonly<{
    sourceHeadGlobalPositionCache?: Map<string, Promise<GlobalPosition>>;
  }>;

function projectionRunContextForSubscription(
  subscription: Pick<BcEventSubscription, "projectionStatementTimeoutMs" | "projectionTransactionTimeoutMs">,
  context: ProjectionRunContext | undefined,
): ProjectionRunContext | undefined {
  if (
    subscription.projectionTransactionTimeoutMs === undefined &&
    subscription.projectionStatementTimeoutMs === undefined
  ) {
    return context;
  }

  return {
    ...context,
    ...(subscription.projectionTransactionTimeoutMs !== undefined
      ? { transactionTimeoutMs: subscription.projectionTransactionTimeoutMs }
      : {}),
    ...(subscription.projectionStatementTimeoutMs !== undefined
      ? { statementTimeoutMs: subscription.projectionStatementTimeoutMs }
      : {}),
  };
}

function isTransientSubscriptionApplyError(
  error: unknown,
  errorPolicy: BcEventSubscription["errorPolicy"] | undefined,
): boolean {
  return (
    errorPolicy === "global-strict" ||
    isTransientProjectionError(error) ||
    isPgRetryableTransientError(error) ||
    isRetryableEventStoreAppendFailure(error)
  );
}

function isRetryableEventStoreAppendFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as Readonly<{
    code?: unknown;
    details?: unknown;
    message?: unknown;
  }>;
  if (candidate.message === "Failed to append events to Postgres event store.") {
    return true;
  }

  if (
    candidate.code !== "concurrency_conflict" ||
    typeof candidate.details !== "object" ||
    candidate.details === null
  ) {
    return false;
  }

  const postgresCode = (candidate.details as Readonly<{ postgresCode?: unknown }>).postgresCode;
  return typeof postgresCode === "string" && isPgRetryableTransientError({ code: postgresCode });
}

export type MountedContextRuntimeEntry = Readonly<{
  contextName: string;
  mountRole?: "active" | "source-only";
  module: BcApiModule;
  services: unknown;
  pool: PgTransactionalPool;
  notificationWaiterPool?: PgTransactionalPool;
  projectionHandlerSets: readonly BcProjectionHandlerSet[];
}>;

export type ContextProcessSet = Readonly<{
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

function matchesSubscriptionEvent(
  event: Readonly<ReturnType<typeof toTransportEvent>>,
  subscription: Pick<BcEventSubscription, "eventTypes" | "streamPrefixes">,
): boolean {
  const matchesType = !subscription.eventTypes || subscription.eventTypes.includes(event.type);
  const matchesStreamPrefix =
    !subscription.streamPrefixes || subscription.streamPrefixes.some((prefix) => event.streamId.startsWith(prefix));

  return matchesType && matchesStreamPrefix;
}

type SubscriptionTransportEvent = Readonly<ReturnType<typeof toTransportEvent>>;

type SubscriptionBatchProgress = {
  lastGlobalPosition: GlobalPosition;
  lastCheckpointedGlobalPosition: GlobalPosition;
  eventsSinceCheckpoint: number;
  processed: number;
};

class BatchEventApplyError extends Error {
  readonly eventId: string;
  readonly originalError: unknown;

  constructor(eventId: string, error: unknown) {
    super(error instanceof Error ? error.message : String(error));
    this.name = "BatchEventApplyError";
    this.eventId = eventId;
    this.originalError = error;
  }
}

function leaseFencingToken(context: ProjectionRunContext | undefined): string | null {
  return context?.fencingToken && /^\d+$/.test(context.fencingToken) ? context.fencingToken : null;
}

async function loadProjectionBlockedStreamsForBatch(
  db: PgQueryable,
  projectionKey: string,
  streamIds: readonly string[],
): Promise<ReadonlySet<string>> {
  const uniqueStreamIds = [...new Set(streamIds)];
  if (uniqueStreamIds.length === 0) {
    return new Set();
  }

  const result = await db.query<Readonly<{ stream_id: string }>>(
    `SELECT stream_id
     FROM event_projection_blocked_streams
     WHERE projection_key = $1
       AND stream_id = ANY($2::text[])
       AND state IN ('blocked', 'retrying')`,
    [projectionKey, uniqueStreamIds],
  );

  return new Set(result.rows.map((row) => row.stream_id));
}

async function claimSubscriptionApplicationsForBatch(
  db: PgQueryable,
  projectionKey: string,
  events: readonly SubscriptionTransportEvent[],
  context?: ProjectionRunContext,
): Promise<ReadonlySet<string>> {
  if (events.length === 0) {
    return new Set();
  }

  const eventIds = events.map((event) => String(event.id));
  const fencingToken = leaseFencingToken(context);
  await db.query(
    `WITH event_input AS (
       SELECT *
       FROM unnest(
         $2::text[],
         $3::text[],
         $4::bigint[],
         $5::bigint[],
         $6::text[]
       ) AS input(event_id, stream_id, stream_version, global_position, event_type)
     )
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
     SELECT
       $1,
       event_id,
       stream_id,
       stream_version,
       global_position,
       event_type,
       'started',
       NULL,
       $7,
       $8::bigint,
       now(),
       now()
     FROM event_input
     ON CONFLICT (projection_key, event_id)
     DO NOTHING`,
    [
      projectionKey,
      eventIds,
      events.map((event) => event.streamId),
      events.map((event) => String(event.streamVersion)),
      events.map((event) => event.globalPosition),
      events.map((event) => event.type),
      context?.ownerId ?? null,
      fencingToken,
    ],
  );

  const statusResult = await db.query<Readonly<{ event_id: string; status: string }>>(
    `SELECT event_id, status
     FROM event_subscription_applications
     WHERE projection_key = $1
       AND event_id = ANY($2::text[])
     FOR UPDATE`,
    [projectionKey, eventIds],
  );
  if (statusResult.rows.length !== eventIds.length) {
    throw new Error(`Projection application batch '${projectionKey}' disappeared before it could be claimed.`);
  }

  const alreadyAppliedEventIds = new Set(
    statusResult.rows.flatMap((row) => (row.status === "applied" ? [String(row.event_id)] : [])),
  );
  const claimableEventIds = eventIds.filter((eventId) => !alreadyAppliedEventIds.has(eventId));
  if (claimableEventIds.length === 0) {
    return alreadyAppliedEventIds;
  }

  const updateResult = await db.query(
    `UPDATE event_subscription_applications
     SET status = 'started',
         error_message = NULL,
         lease_owner_id = $3,
         lease_fencing_token = $4::bigint,
         updated_at = now()
     WHERE projection_key = $1
       AND event_id = ANY($2::text[])
       AND status <> 'applied'
       AND (
         $4::bigint IS NULL
         OR lease_fencing_token IS NULL
         OR $4::bigint >= lease_fencing_token
       )`,
    [projectionKey, claimableEventIds, context?.ownerId ?? null, fencingToken],
  );
  if (updateResult.rowCount != null && updateResult.rowCount < claimableEventIds.length) {
    throw new Error(`Projection application batch '${projectionKey}' rejected stale lease fencing token.`);
  }

  return alreadyAppliedEventIds;
}

async function recordSubscriptionApplicationsCompletedForBatch(
  db: PgQueryable,
  projectionKey: string,
  eventIds: readonly string[],
  context?: ProjectionRunContext,
): Promise<void> {
  const uniqueEventIds = [...new Set(eventIds)];
  if (uniqueEventIds.length === 0) {
    return;
  }

  const fencingToken = leaseFencingToken(context);
  const result = await db.query(
    `UPDATE event_subscription_applications
     SET status = 'applied',
         error_message = NULL,
         updated_at = now()
     WHERE projection_key = $1
       AND event_id = ANY($2::text[])
       AND ($3::bigint IS NULL OR lease_fencing_token = $3::bigint)`,
    [projectionKey, uniqueEventIds, fencingToken],
  );
  if (result.rowCount != null && result.rowCount < uniqueEventIds.length) {
    throw new Error(`Projection application batch '${projectionKey}' was not claimed before completion.`);
  }
}

export function createSubscriptionRunner(
  targetContextName: string,
  targetPool: PgTransactionalPool,
  sourcePool: PgTransactionalPool,
  subscription: BcEventSubscription,
): ContextSubscriptionRunner {
  const sourceEventStore = createPostgresEventStore({ pool: sourcePool });
  const batchSize = subscription.batchSize ?? 100;
  const handlerKind = subscription.handlerKind ?? "projection";
  const configuredCheckpointBatchSize = Math.max(1, subscription.checkpointBatchSize ?? batchSize);
  const checkpointBatchSize =
    handlerKind === "reaction"
      ? Math.min(configuredCheckpointBatchSize, REACTION_CHECKPOINT_BATCH_SIZE)
      : configuredCheckpointBatchSize;
  const checkpointKey = createCheckpointKey(subscription);
  const subscriptionEventTypes = subscription.eventTypes ?? Object.keys(subscription.handlers).sort();
  const status: {
    checkpointKey: string;
    subscriptionName: string;
    handlerKind: BcSubscriptionHandlerKind;
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
    handlerKind,
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
  const transactionTelemetry = {
    handlerKind,
    targetContextName,
    sourceContextName: subscription.sourceContextName,
    projectionName: subscription.projectionName,
    subscriptionName: subscription.subscriptionName,
  };
  let lastIdleCheckpointFastForwardAtMs = 0;

  const readSourceHeadForRun = (context: ProjectionRunContext | undefined): Promise<GlobalPosition> => {
    const sourceHeadCache = (context as ProjectionRunContextWithSourceHeadCache | undefined)
      ?.sourceHeadGlobalPositionCache;
    if (!sourceHeadCache) {
      return readSourceHeadGlobalPosition(sourcePool);
    }

    let sourceHead = sourceHeadCache.get(subscription.sourceContextName);
    if (!sourceHead) {
      sourceHead = readSourceHeadGlobalPosition(sourcePool);
      sourceHeadCache.set(subscription.sourceContextName, sourceHead);
    }

    return sourceHead;
  };
  const shouldPersistIdleCheckpointFastForward = (
    fromGlobalPosition: GlobalPosition,
    toGlobalPosition: GlobalPosition,
  ): boolean => {
    const gap = BigInt(toGlobalPosition) - BigInt(fromGlobalPosition);
    if (gap <= 0n) {
      return false;
    }
    if (gap >= IDLE_CHECKPOINT_FAST_FORWARD_MIN_GAP) {
      return true;
    }

    return Date.now() - lastIdleCheckpointFastForwardAtMs >= IDLE_CHECKPOINT_FAST_FORWARD_HEARTBEAT_MS;
  };
  const persistIdleCheckpointFastForward = async (
    fromGlobalPosition: GlobalPosition,
    toGlobalPosition: GlobalPosition,
    saveCheckpoint: (lastGlobalPosition: GlobalPosition) => Promise<void>,
  ): Promise<boolean> => {
    // Fast-forward is safe only because source appends are serialized by the global append advisory lock.
    if (!shouldPersistIdleCheckpointFastForward(fromGlobalPosition, toGlobalPosition)) {
      return false;
    }

    await saveCheckpoint(toGlobalPosition);
    lastIdleCheckpointFastForwardAtMs = Date.now();
    return true;
  };
  const errorPolicy = subscription.errorPolicy ?? "strict-per-stream";

  return {
    subscriptionName: subscription.subscriptionName,
    handlerKind,
    projectionName: subscription.projectionName,
    sourceContextName: subscription.sourceContextName,
    targetContextName,
    subscriptionVersion: subscription.subscriptionVersion,
    checkpointKey,
    eventTypes: subscriptionEventTypes,
    streamPrefixes: subscription.streamPrefixes,
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
      applyLagMetrics(status);
      status.blockedStreamCount = errorSummary.blockedStreamCount;
      status.poisonEventCount = errorSummary.poisonEventCount;
      if (status.state !== "running" && status.state !== "error") {
        status.state = deriveSubscriptionReplayState(checkpoint, status.sourceHeadGlobalPosition, errorSummary);
      }
      status.updatedAt = new Date().toISOString();
      return { ...status };
    },
    reset: async (context, options) => {
      await deleteSubscriptionCheckpoint(options?.db ?? targetPool, checkpointKey, context);
      status.initialized = false;
      status.lastGlobalPosition = ZERO_GLOBAL_POSITION;
      status.sourceHeadGlobalPosition = ZERO_GLOBAL_POSITION;
      status.outstandingEventCount = "0";
      applyLagMetrics(status);
      status.processedEvents = 0;
      status.state = "idle";
      status.lastError = null;
      status.blockedStreamCount = 0;
      status.poisonEventCount = 0;
      status.updatedAt = new Date().toISOString();
    },
    retryBlockedStream: async (streamId, context) => {
      const projectionRunContext = projectionRunContextForSubscription(subscription, context);
      context?.throwIfLeaseLost?.();
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

      context?.throwIfLeaseLost?.();
      await markProjectionBlockedStreamRetrying(targetPool, checkpointKey, streamId);

      let fromVersion = blockedStream.firstBlockedStreamVersion;
      let inspectedEvents = 0;
      let appliedEvents = 0;
      let lastInspectedGlobalPosition = ZERO_GLOBAL_POSITION;

      while (true) {
        context?.throwIfLeaseLost?.();
        const storedEvents = await sourceEventStore.readStream({
          streamId,
          fromVersion,
          limit: batchSize,
        });

        if (storedEvents.length === 0) {
          break;
        }

        for (const storedEvent of storedEvents) {
          context?.throwIfLeaseLost?.();
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
            const applicationResult = await withProjectionTransaction(
              targetPool,
              projectionRunContext,
              async (client) => {
                const claimResult = await claimSubscriptionApplication(client, checkpointKey, event, context);
                if (claimResult === "already-applied") {
                  return "already-applied" as const;
                }

                await runInProjectionDbContext(client, () =>
                  handler(event, { db: client, throwIfLeaseLost: context?.throwIfLeaseLost }),
                );
                context?.throwIfLeaseLost?.();
                await recordSubscriptionApplicationCompleted(
                  client,
                  checkpointKey,
                  String(event.id),
                  "applied",
                  null,
                  context,
                );
                return "applied" as const;
              },
              transactionTelemetry,
            );
            if (applicationResult === "already-applied") {
              appliedEvents += 1;
              continue;
            }
            appliedEvents += 1;
          } catch (error) {
            const failureStatus = isTransientSubscriptionApplyError(error, errorPolicy) ? "transient" : "poison";
            const failureResult = await recordSubscriptionApplicationFailure(
              targetPool,
              checkpointKey,
              event,
              failureStatus,
              error,
              context,
            );
            if (failureResult === "already-applied") {
              appliedEvents += 1;
              continue;
            }

            if (failureStatus === "transient") {
              await markProjectionBlockedStreamBlocked(targetPool, checkpointKey, streamId);
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
      const projectionRunContext = projectionRunContextForSubscription(subscription, context);
      context?.throwIfLeaseLost?.();
      status.state = "running";
      status.lastError = null;
      status.updatedAt = new Date().toISOString();
      const saveLeasedSubscriptionCheckpoint = async (lastGlobalPosition: GlobalPosition) => {
        context?.throwIfLeaseLost?.();
        await saveSubscriptionCheckpoint(targetPool, subscription, lastGlobalPosition, context);
      };

      try {
        const storedCheckpoint = await loadSubscriptionCheckpoint(targetPool, checkpointKey);
        const checkpoint = storedCheckpoint ?? ZERO_GLOBAL_POSITION;
        status.initialized = storedCheckpoint !== null;
        status.lastGlobalPosition = checkpoint;
        status.sourceHeadGlobalPosition = await readSourceHeadForRun(context);
        status.outstandingEventCount = calculateOutstandingEventCount(checkpoint, status.sourceHeadGlobalPosition);
        applyLagMetrics(status);

        const storedEvents = await sourceEventStore.readAll({
          afterGlobalPosition: checkpoint,
          eventTypes: subscriptionEventTypes,
          streamPrefixes: subscription.streamPrefixes,
          limit: batchSize,
        });

        if (storedEvents.length === 0) {
          await persistIdleCheckpointFastForward(
            checkpoint,
            status.sourceHeadGlobalPosition,
            saveLeasedSubscriptionCheckpoint,
          );
          const errorSummary = await loadProjectionErrorSummary(targetPool, checkpointKey);
          status.blockedStreamCount = errorSummary.blockedStreamCount;
          status.poisonEventCount = errorSummary.poisonEventCount;
          status.initialized = true;
          status.lastGlobalPosition = status.sourceHeadGlobalPosition;
          status.outstandingEventCount = "0";
          applyLagMetrics(status, "0");
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

        const initialProgress = (): SubscriptionBatchProgress => ({
          lastGlobalPosition: checkpoint,
          lastCheckpointedGlobalPosition: checkpoint,
          eventsSinceCheckpoint: 0,
          processed: 0,
        });
        const advanceProgress = async (
          progress: SubscriptionBatchProgress,
          event: SubscriptionTransportEvent,
        ): Promise<void> => {
          progress.lastGlobalPosition = event.globalPosition;
          progress.processed += 1;
          progress.eventsSinceCheckpoint += 1;
          if (progress.eventsSinceCheckpoint >= checkpointBatchSize) {
            await saveLeasedSubscriptionCheckpoint(progress.lastGlobalPosition);
            progress.lastCheckpointedGlobalPosition = progress.lastGlobalPosition;
            progress.eventsSinceCheckpoint = 0;
          }
        };
        const applyStoredEventsIndividually = async (
          events: readonly SubscriptionTransportEvent[],
          knownFailure?: Readonly<{ eventId: string; error: unknown }>,
        ): Promise<SubscriptionBatchProgress> => {
          const progress = initialProgress();
          const applicationStatuses = await loadSubscriptionApplicationStatuses(
            targetPool,
            checkpointKey,
            events.map((event) => String(event.id)),
          );

          for (const event of events) {
            context?.throwIfLeaseLost?.();
            const handler = (subscription.handlers as Readonly<Record<string, ProjectorHandler | undefined>>)[
              event.type
            ];

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

                  await advanceProgress(progress, event);
                  continue;
                }
              }

              if (applicationStatuses.get(String(event.id)) === "applied") {
                await advanceProgress(progress, event);
                continue;
              }

              try {
                if (knownFailure?.eventId === String(event.id)) {
                  throw knownFailure.error;
                }

                const applicationResult = await withProjectionTransaction(
                  targetPool,
                  projectionRunContext,
                  async (client) => {
                    const claimResult = await claimSubscriptionApplication(client, checkpointKey, event, context);
                    if (claimResult === "already-applied") {
                      return "already-applied" as const;
                    }

                    await runInProjectionDbContext(client, () =>
                      handler(event, { db: client, throwIfLeaseLost: context?.throwIfLeaseLost }),
                    );
                    context?.throwIfLeaseLost?.();
                    await recordSubscriptionApplicationCompleted(
                      client,
                      checkpointKey,
                      String(event.id),
                      "applied",
                      null,
                      context,
                    );
                    return "applied" as const;
                  },
                  transactionTelemetry,
                );
                if (applicationResult === "already-applied") {
                  await advanceProgress(progress, event);
                  continue;
                }
              } catch (error) {
                if (isTransientSubscriptionApplyError(error, errorPolicy)) {
                  const failureResult = await recordSubscriptionApplicationFailure(
                    targetPool,
                    checkpointKey,
                    event,
                    "transient",
                    error,
                    context,
                  );
                  if (failureResult === "already-applied") {
                    await advanceProgress(progress, event);
                    continue;
                  }

                  if (progress.lastGlobalPosition !== progress.lastCheckpointedGlobalPosition) {
                    await saveLeasedSubscriptionCheckpoint(progress.lastGlobalPosition);
                    progress.lastCheckpointedGlobalPosition = progress.lastGlobalPosition;
                  }
                  throw error;
                }

                const failureResult = await recordSubscriptionApplicationFailure(
                  targetPool,
                  checkpointKey,
                  event,
                  "poison",
                  error,
                  context,
                );
                if (failureResult === "already-applied") {
                  await advanceProgress(progress, event);
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

            await advanceProgress(progress, event);
          }

          return progress;
        };
        const applyStoredEventsAsBatch = async (
          events: readonly SubscriptionTransportEvent[],
        ): Promise<SubscriptionBatchProgress> => {
          const progress = initialProgress();
          await withProjectionTransaction(
            targetPool,
            projectionRunContext,
            async (client) => {
              context?.throwIfLeaseLost?.();
              const applicableEvents = events.flatMap((event) => {
                const handler = (subscription.handlers as Readonly<Record<string, ProjectorHandler | undefined>>)[
                  event.type
                ];
                return matchesSubscriptionEvent(event, { ...subscription, eventTypes: subscriptionEventTypes }) &&
                  handler
                  ? [{ event, handler }]
                  : [];
              });
              const blockedStreams =
                errorPolicy === "strict-per-stream"
                  ? await loadProjectionBlockedStreamsForBatch(
                      client,
                      checkpointKey,
                      applicableEvents.map(({ event }) => event.streamId),
                    )
                  : new Set<string>();
              const claimCandidates: Array<Readonly<{ event: SubscriptionTransportEvent; handler: ProjectorHandler }>> =
                [];

              for (const { event, handler } of applicableEvents) {
                if (blockedStreams.has(event.streamId)) {
                  await recordProjectionDeferredBlockedStreamEvent(client, {
                    projectionKey: checkpointKey,
                    streamId: event.streamId,
                    streamVersion: event.streamVersion,
                    globalPosition: event.globalPosition,
                  });
                  continue;
                }

                claimCandidates.push({ event, handler });
              }

              const alreadyAppliedEventIds = await claimSubscriptionApplicationsForBatch(
                client,
                checkpointKey,
                claimCandidates.map(({ event }) => event),
                context,
              );
              const completedEventIds: string[] = [];
              for (const { event, handler } of claimCandidates) {
                context?.throwIfLeaseLost?.();
                const eventId = String(event.id);
                if (alreadyAppliedEventIds.has(eventId)) {
                  continue;
                }

                try {
                  await runInProjectionDbContext(client, () =>
                    handler(event, { db: client, throwIfLeaseLost: context?.throwIfLeaseLost }),
                  );
                } catch (error) {
                  throw new BatchEventApplyError(String(event.id), error);
                }
                context?.throwIfLeaseLost?.();
                completedEventIds.push(eventId);
              }

              await recordSubscriptionApplicationsCompletedForBatch(client, checkpointKey, completedEventIds, context);
            },
            transactionTelemetry,
          );

          if (events.length > 0) {
            progress.lastGlobalPosition = events[events.length - 1]!.globalPosition;
            progress.eventsSinceCheckpoint = events.length;
            progress.processed = events.length;
          }

          return progress;
        };
        const events = storedEvents.map((storedEvent) => toTransportEvent(storedEvent));
        const progress =
          storedEvents.length <= checkpointBatchSize
            ? await applyStoredEventsAsBatch(events).catch((error: unknown) => {
                if (!(error instanceof BatchEventApplyError)) {
                  throw error;
                }

                return applyStoredEventsIndividually(events, {
                  eventId: error.eventId,
                  error: error.originalError,
                });
              })
            : await applyStoredEventsIndividually(events);
        let lastGlobalPosition = progress.lastGlobalPosition;
        let lastCheckpointedGlobalPosition = progress.lastCheckpointedGlobalPosition;
        const processed = progress.processed;

        if (lastGlobalPosition !== lastCheckpointedGlobalPosition) {
          await saveLeasedSubscriptionCheckpoint(lastGlobalPosition);
          lastCheckpointedGlobalPosition = lastGlobalPosition;
        }
        if (storedEvents.length < batchSize) {
          const observedSourceHeadGlobalPosition = isGlobalPositionGreater(
            lastGlobalPosition,
            status.sourceHeadGlobalPosition,
          )
            ? lastGlobalPosition
            : status.sourceHeadGlobalPosition;

          status.sourceHeadGlobalPosition = observedSourceHeadGlobalPosition;
          if (lastGlobalPosition !== observedSourceHeadGlobalPosition) {
            const checkpointBeforeTailFastForward = lastGlobalPosition;
            lastGlobalPosition = observedSourceHeadGlobalPosition;
            const persistedTailFastForward = await persistIdleCheckpointFastForward(
              checkpointBeforeTailFastForward,
              lastGlobalPosition,
              saveLeasedSubscriptionCheckpoint,
            );
            if (persistedTailFastForward) {
              lastCheckpointedGlobalPosition = lastGlobalPosition;
            }
          }
        }
        status.initialized = true;
        status.lastGlobalPosition = lastGlobalPosition;
        status.outstandingEventCount = calculateOutstandingEventCount(
          lastGlobalPosition,
          status.sourceHeadGlobalPosition,
        );
        applyLagMetrics(status, processed > 0 ? null : "0");
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

    const declaredSubscriptions = entry.module.buildSubscriptions?.(entry.services) ?? [];
    const declaredProjectionNames = new Set(declaredSubscriptions.map((subscription) => subscription.projectionName));
    const subscriptions = [
      ...declaredSubscriptions,
      ...(entry.projectionHandlerSets ?? [])
        .map((set, index) => ({ set, index }))
        .filter(({ set }) => !declaredProjectionNames.has(set.projectionName))
        .map(({ set, index }) => createLocalProjectionSubscription(entry.contextName, set, index)),
    ];

    for (const subscription of subscriptions) {
      validateSubscriptionEventFilters(entry.contextName, subscription);
      const sourceEntry = contextsByName.get(subscription.sourceContextName);
      if (!sourceEntry) {
        if (subscription.sourceContextMount === "when-mounted") {
          continue;
        }

        throw new Error(
          `Context '${entry.contextName}' declared subscription '${subscription.subscriptionName}' for '${subscription.sourceContextName}', but that source context is not mounted in the runtime.`,
        );
      }

      runners.push(createSubscriptionRunner(entry.contextName, entry.pool, sourceEntry.pool, subscription));
    }
  }

  return sortSubscriptionRunners(runners);
}

function createLocalProjectionSubscription(
  contextName: string,
  projection: BcProjectionHandlerSet,
  order: number,
): BcEventSubscription {
  return {
    subscriptionName: `${contextName}.${projection.projectionName}`,
    handlerKind: "projection",
    sourceContextName: contextName,
    projectionName: projection.projectionName,
    subscriptionVersion: 1,
    handlers: projection.handlers,
    eventTypes: projection.eventTypes,
    streamPrefixes: projection.streamPrefixes ?? [`${contextName}.`],
    errorPolicy: projection.errorPolicy,
    batchSize: projection.batchSize,
    checkpointBatchSize: projection.checkpointBatchSize,
    order,
  };
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

export async function drainSubscriptionRunners(
  runners: readonly ContextSubscriptionRunner[],
  context?: ProjectionRunContext,
): Promise<void> {
  let processed = 0;

  do {
    processed = 0;

    for (const runner of sortSubscriptionRunners(runners)) {
      context?.throwIfLeaseLost?.();
      const result = await runner.runOnce(context);
      processed += result.processed;
    }
  } while (processed > 0);
}

export async function drainContextProcesses(
  processSet: ContextProcessSet,
  context?: ProjectionRunContext,
): Promise<void> {
  let processed = 0;

  do {
    processed = 0;

    for (const runner of sortSubscriptionRunners(processSet.subscriptionRunners ?? [])) {
      context?.throwIfLeaseLost?.();
      const result = await runner.runOnce(context);
      processed += result.processed;
    }
  } while (processed > 0);
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
    subscriptionRunners: runtime.subscriptionRunners.filter((runner) => runner.targetContextName === contextName),
  });
}

function getProjectionOperationTargets(
  runtime: Readonly<{
    mountedContexts: readonly MountedContextRuntimeEntry[];
    subscriptionRunners: readonly ContextSubscriptionRunner[];
  }>,
  projectionKey: string,
): readonly Readonly<{ projectionKey: string; pool: PgTransactionalPool }>[] {
  const poolsByContextName = new Map(runtime.mountedContexts.map((entry) => [entry.contextName, entry.pool]));
  const exactRunner = runtime.subscriptionRunners.find((runner) => runner.checkpointKey === projectionKey);
  const runners = exactRunner
    ? [exactRunner]
    : runtime.subscriptionRunners.filter(
        (runner) => `${runner.targetContextName}.${runner.projectionName}` === projectionKey,
      );

  if (runners.length === 0) {
    throw new Error(`Runtime is missing projection operations storage for '${projectionKey}'.`);
  }

  return runners.map((runner) => {
    const pool = poolsByContextName.get(runner.targetContextName);
    if (!pool) {
      throw new Error(`Runtime is missing projection operations storage for '${runner.checkpointKey}'.`);
    }

    return { projectionKey: runner.checkpointKey, pool };
  });
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
  const targets = getProjectionOperationTargets(runtime, projectionKey);
  const storesByPool = new Map<PgTransactionalPool, ReturnType<typeof createPostgresProjectionStore>>();
  const blockedStreams: ProjectionBlockedStream[] = [];
  const poisonEvents: ProjectionPoisonEvent[] = [];

  for (const target of targets) {
    let store = storesByPool.get(target.pool);
    if (!store) {
      store = createPostgresProjectionStore({ db: target.pool });
      storesByPool.set(target.pool, store);
    }

    blockedStreams.push(...((await store.listBlockedStreams?.(target.projectionKey)) ?? []));
    poisonEvents.push(
      ...((await store.listPoisonEvents?.(target.projectionKey, options.poisonEventLimit ?? 50)) ?? []),
    );
  }

  return {
    projectionKey,
    blockedStreams,
    poisonEvents,
  };
}

export async function retryProjectionBlockedStream(
  runtime: Readonly<{
    subscriptionRunners: readonly ContextSubscriptionRunner[];
  }>,
  projectionKey: string,
  streamId: string,
  context?: ProjectionRunContext,
): Promise<ProjectionStreamRetryResult> {
  const runner = runtime.subscriptionRunners.find((candidate) => candidate.checkpointKey === projectionKey);
  if (!runner) {
    throw new Error(
      `Runtime is missing subscription runner '${projectionKey}'. Local projector stream retry is not available through this operation yet.`,
    );
  }

  return runner.retryBlockedStream(streamId, context);
}

export async function drainContextRuntime(
  runtime: Readonly<{
    subscriptionRunners?: readonly ContextSubscriptionRunner[];
  }>,
): Promise<void> {
  await drainContextProcesses({ subscriptionRunners: runtime.subscriptionRunners });
}

export async function compactRuntimeSubscriptionLedgers(
  runtime: Readonly<{
    mountedContexts: readonly MountedContextRuntimeEntry[];
    subscriptionRunners: readonly ContextSubscriptionRunner[];
  }>,
): Promise<number> {
  const poolsByContextName = new Map(runtime.mountedContexts.map((entry) => [entry.contextName, entry.pool]));
  let compacted = 0;

  for (const runner of runtime.subscriptionRunners) {
    const pool = poolsByContextName.get(runner.targetContextName);
    if (!pool) {
      continue;
    }
    const checkpoint = await loadSubscriptionCheckpoint(pool, runner.checkpointKey);
    if (!checkpoint) {
      continue;
    }
    await compactSubscriptionApplicationLedger(pool, runner.checkpointKey, checkpoint);
    compacted += 1;
  }

  return compacted;
}

export async function summarizeRuntimeSubscriptionLedgers(
  runtime: Readonly<{
    mountedContexts: readonly MountedContextRuntimeEntry[];
    subscriptionRunners: readonly ContextSubscriptionRunner[];
  }>,
): Promise<readonly SubscriptionLedgerMetrics[]> {
  const poolsByContextName = new Map(runtime.mountedContexts.map((entry) => [entry.contextName, entry.pool]));
  const metrics: SubscriptionLedgerMetrics[] = [];

  for (const runner of runtime.subscriptionRunners) {
    const pool = poolsByContextName.get(runner.targetContextName);
    if (!pool) {
      continue;
    }

    const result = await pool.query<
      Readonly<{
        applied_rows: string | number | bigint;
        started_rows: string | number | bigint;
        poison_rows: string | number | bigint;
        transient_rows: string | number | bigint;
        oldest_started_at: string | Date | null;
      }>
    >(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'applied') AS applied_rows,
         COUNT(*) FILTER (WHERE status = 'started') AS started_rows,
         COUNT(*) FILTER (WHERE status = 'poison') AS poison_rows,
         COUNT(*) FILTER (WHERE status = 'transient') AS transient_rows,
         MIN(started_at) FILTER (WHERE status = 'started') AS oldest_started_at
       FROM event_subscription_applications
       WHERE projection_key = $1`,
      [runner.checkpointKey],
    );
    const row = result.rows[0];
    metrics.push({
      projectionKey: runner.checkpointKey,
      targetContextName: runner.targetContextName,
      appliedRows: String(row?.applied_rows ?? "0"),
      startedRows: String(row?.started_rows ?? "0"),
      poisonRows: String(row?.poison_rows ?? "0"),
      transientRows: String(row?.transient_rows ?? "0"),
      oldestStartedAt: row?.oldest_started_at ? new Date(row.oldest_started_at).toISOString() : null,
    });
  }

  return metrics;
}
