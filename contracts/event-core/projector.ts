import type { GlobalPosition, StreamId, StreamVersion } from "./storage";
import type { TransportEvent, TransportEventPayload, TypedTransportEvent } from "./transport";

export type ProjectionErrorPolicy = "strict-per-stream" | "global-strict";

export type ProjectionFailureKind = "poison" | "transient";

export type ProjectionRunState = "running" | "caught-up" | "degraded";

export type ProjectionPoisonState = "blocked" | "retrying" | "resolved" | "ignored";

export type ProjectionBlockedStreamState = "blocked" | "retrying" | "resolved";

export type ProjectionErrorSummary = Readonly<{
  blockedStreamCount: number;
  poisonEventCount: number;
}>;

export type ProjectionBlockedStream = Readonly<{
  projectionKey: string;
  streamId: StreamId;
  firstBlockedGlobalPosition: GlobalPosition;
  firstBlockedStreamVersion: StreamVersion;
  lastSeenGlobalPosition: GlobalPosition;
  deferredEventCount: number;
  state: ProjectionBlockedStreamState;
}>;

export type ProjectionPoisonEvent = Readonly<{
  projectionKey: string;
  eventId: string;
  projectionName: string;
  projectionKind: "projector" | "subscription";
  targetContextName: string | null;
  sourceContextName: string | null;
  projectionRevision: number | null;
  subscriptionVersion: number | null;
  streamId: StreamId;
  streamVersion: StreamVersion;
  eventType: string;
  globalPosition: GlobalPosition;
  failureKind: ProjectionFailureKind;
  errorMessage: string;
  errorStack: string | null;
  state: ProjectionPoisonState;
  retryCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
}>;

export type RecordProjectionPoisonEventInput = Readonly<{
  projectionKey: string;
  projectionName: string;
  projectionKind: "projector" | "subscription";
  targetContextName?: string | null;
  sourceContextName?: string | null;
  projectionRevision?: number | null;
  subscriptionVersion?: number | null;
  streamId: StreamId;
  streamVersion: StreamVersion;
  eventId: string;
  eventType: string;
  globalPosition: GlobalPosition;
  failureKind: ProjectionFailureKind;
  errorMessage: string;
  errorStack?: string | null;
}>;

export type RecordProjectionDeferredEventInput = Readonly<{
  projectionKey: string;
  streamId: StreamId;
  streamVersion: StreamVersion;
  globalPosition: GlobalPosition;
}>;

export type ProjectionCheckpointStore = Readonly<{
  loadCheckpoint: (projectionName: string) => Promise<GlobalPosition>;
  saveCheckpoint: (projectionName: string, globalPosition: GlobalPosition) => Promise<void>;
  loadBlockedStream?: (projectionKey: string, streamId: StreamId) => Promise<ProjectionBlockedStream | null>;
  recordPoisonEvent?: (input: RecordProjectionPoisonEventInput) => Promise<void>;
  recordDeferredBlockedStreamEvent?: (input: RecordProjectionDeferredEventInput) => Promise<void>;
  loadProjectionErrorSummary?: (projectionKey: string) => Promise<ProjectionErrorSummary>;
  listBlockedStreams?: (projectionKey: string) => Promise<readonly ProjectionBlockedStream[]>;
  listPoisonEvents?: (projectionKey: string, limit?: number) => Promise<readonly ProjectionPoisonEvent[]>;
  markBlockedStreamRetrying?: (projectionKey: string, streamId: StreamId) => Promise<void>;
  resolveBlockedStream?: (projectionKey: string, streamId: StreamId) => Promise<void>;
  clearProjectionErrors?: (projectionKey: string) => Promise<void>;
}>;

export type ProjectorHandlerContext = Readonly<{
  db?: {
    query: <Row = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ) => Promise<Readonly<{ rows: readonly Row[]; rowCount?: number | null }>>;
  };
  throwIfLeaseLost?: () => void;
}>;

export type EventPayloadMap = Readonly<Record<string, TransportEventPayload>>;

export type ProjectorHandler<
  TPayload extends TransportEventPayload = TransportEventPayload,
  TEventType extends string = string,
> = (event: Readonly<TypedTransportEvent<TPayload, TEventType>>, context?: ProjectorHandlerContext) => Promise<void>;

export type ProjectorHandlerMap = Readonly<Record<string, ProjectorHandler>>;

export type TypedProjectorHandlerMap<TEventPayloads extends EventPayloadMap> = Readonly<{
  [TEventType in keyof TEventPayloads & string]?: ProjectorHandler<TEventPayloads[TEventType], TEventType>;
}>;

export function defineProjectorHandlers<TEventPayloads extends EventPayloadMap>(
  handlers: TypedProjectorHandlerMap<TEventPayloads>,
): ProjectorHandlerMap {
  const untypedHandlers: Record<string, ProjectorHandler> = {};
  for (const [eventType, handler] of Object.entries(handlers)) {
    if (handler) {
      untypedHandlers[eventType] = handler as ProjectorHandler;
    }
  }
  return untypedHandlers;
}

export type TransactionalProjectorHandlerContext = Readonly<
  ProjectorHandlerContext & {
    db: NonNullable<ProjectorHandlerContext["db"]>;
  }
>;

export type TransactionalProjectorHandler<
  TPayload extends TransportEventPayload = TransportEventPayload,
  TEventType extends string = string,
> = (
  event: Readonly<TypedTransportEvent<TPayload, TEventType>>,
  context: TransactionalProjectorHandlerContext,
) => Promise<void>;

export type TransactionalProjectorHandlerMap<TEventPayloads extends EventPayloadMap = EventPayloadMap> = Readonly<{
  [TEventType in keyof TEventPayloads & string]?: TransactionalProjectorHandler<TEventPayloads[TEventType], TEventType>;
}>;

export function createTransactionalProjectorHandlerMap<TEventPayloads extends EventPayloadMap = EventPayloadMap>(
  handlers: TransactionalProjectorHandlerMap<TEventPayloads>,
): ProjectorHandlerMap {
  return Object.fromEntries(
    Object.entries(handlers).map(([eventType, handler]) => [
      eventType,
      async (event, context) => {
        if (!context?.db) {
          throw new Error(
            `Projection handler for event '${eventType}' requires the transaction-scoped projection database.`,
          );
        }

        await handler(event, { ...context, db: context.db });
      },
    ]),
  );
}

export function resolveProjectionDb<TDb>(context: ProjectorHandlerContext | undefined, fallbackDb: TDb): TDb {
  return (context?.db as TDb | undefined) ?? fallbackDb;
}

export type ProjectorRunResult = Readonly<{
  processed: number;
  lastGlobalPosition: GlobalPosition;
  state?: ProjectionRunState;
  blockedStreams?: number;
  poisonEvents?: number;
}>;

export type ProjectionRunContext = Readonly<{
  ownerId?: string;
  fencingToken?: string;
  operationId?: string;
  signal?: AbortSignal;
  idleInTransactionSessionTimeoutMs?: number;
  transactionTimeoutMs?: number;
  statementTimeoutMs?: number;
  throwIfLeaseLost?: () => void;
  /**
   * Force idle checkpoint fast-forwards to persist immediately, bypassing the
   * steady-state gap/heartbeat throttle. Used by one-time drains (for example
   * host bootstrap seeding) that must leave every subscription fully settled at
   * its source head, even when only a small tail of non-subscribed source events
   * remains.
   */
  settleIdleCheckpoints?: boolean;
}>;

export type ProjectionHandlerSet = Readonly<{
  projectionName: string;
  handlers: ProjectorHandlerMap;
  batchSize?: number;
  checkpointBatchSize?: number;
  eventTypes?: readonly string[];
  streamPrefixes?: readonly string[];
  errorPolicy?: ProjectionErrorPolicy;
}>;

export type ProjectionHandlerSetConfig = Omit<ProjectionHandlerSet, "projectionName"> &
  Readonly<{
    projectionName: string;
  }>;

export function createProjectionHandlerSet(config: ProjectionHandlerSetConfig): ProjectionHandlerSet {
  const batchSize = assertPositiveInteger(config.batchSize ?? 100, "batchSize");
  const checkpointBatchSize = assertPositiveInteger(config.checkpointBatchSize ?? batchSize, "checkpointBatchSize");
  return {
    projectionName: config.projectionName,
    handlers: config.handlers,
    batchSize,
    checkpointBatchSize,
    eventTypes: config.eventTypes ?? Object.keys(config.handlers).sort(),
    streamPrefixes: config.streamPrefixes,
    errorPolicy: config.errorPolicy ?? "strict-per-stream",
  };
}

export function createTransientProjectionError(message: string, options?: ErrorOptions): Error {
  const error = new Error(message, options) as Error & { projectionFailureKind: ProjectionFailureKind };
  error.projectionFailureKind = "transient";
  return error;
}

export function isTransientProjectionError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "projectionFailureKind" in error &&
    (error as { projectionFailureKind?: unknown }).projectionFailureKind === "transient"
  );
}

function assertPositiveInteger(value: number, fieldName: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer.`);
  }

  return value;
}
