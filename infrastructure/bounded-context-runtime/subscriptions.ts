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
  type PgTransactionalPool,
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
  estimateApplicableLag,
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
  reset: (context?: ProjectionRunContext) => Promise<void>;
  retryBlockedStream: (streamId: string, context?: ProjectionRunContext) => Promise<ProjectionStreamRetryResult>;
}>;

export type MountedContextRuntimeEntry = Readonly<{
  contextName: string;
  mountRole?: "active" | "source-only";
  module: BcApiModule;
  services: unknown;
  pool: PgTransactionalPool;
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
  const handlerKind = subscription.handlerKind ?? "projection";
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
      applyLagMetrics(
        status,
        await estimateApplicableLag(sourcePool, checkpoint, subscriptionEventTypes, subscription.streamPrefixes),
      );
      status.blockedStreamCount = errorSummary.blockedStreamCount;
      status.poisonEventCount = errorSummary.poisonEventCount;
      if (status.state !== "running" && status.state !== "error") {
        status.state = deriveSubscriptionReplayState(checkpoint, status.sourceHeadGlobalPosition, errorSummary);
      }
      status.updatedAt = new Date().toISOString();
      return { ...status };
    },
    reset: async (context) => {
      await deleteSubscriptionCheckpoint(targetPool, checkpointKey, context);
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
            const applicationResult = await withProjectionTransaction(targetPool, context, async (client) => {
              const claimResult = await claimSubscriptionApplication(client, checkpointKey, event, context);
              if (claimResult === "already-applied") {
                return "already-applied" as const;
              }

              await runInProjectionDbContext(client, () => handler(event, { db: client }));
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
              context,
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
        await saveSubscriptionCheckpoint(targetPool, subscription, lastGlobalPosition, context);
      };

      try {
        const storedCheckpoint = await loadSubscriptionCheckpoint(targetPool, checkpointKey);
        const checkpoint = storedCheckpoint ?? ZERO_GLOBAL_POSITION;
        status.initialized = storedCheckpoint !== null;
        status.lastGlobalPosition = checkpoint;
        status.sourceHeadGlobalPosition = await readSourceHeadGlobalPosition(sourcePool);
        status.outstandingEventCount = calculateOutstandingEventCount(checkpoint, status.sourceHeadGlobalPosition);
        applyLagMetrics(status);

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
              const applicationResult = await withProjectionTransaction(targetPool, context, async (client) => {
                const claimResult = await claimSubscriptionApplication(client, checkpointKey, event, context);
                if (claimResult === "already-applied") {
                  return "already-applied" as const;
                }

                await runInProjectionDbContext(client, () => handler(event, { db: client }));
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
                  context,
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
                context,
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
