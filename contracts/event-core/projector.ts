import type { EventStore } from "./event-store";
import type { GlobalPosition, StreamId, StreamVersion } from "./storage";
import { toTransportEvent, type TransportEvent } from "./transport";

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
  loadCheckpoint: (projectorName: string) => Promise<GlobalPosition>;
  saveCheckpoint: (projectorName: string, globalPosition: GlobalPosition) => Promise<void>;
  loadBlockedStream?: (projectionKey: string, streamId: StreamId) => Promise<ProjectionBlockedStream | null>;
  recordPoisonEvent?: (input: RecordProjectionPoisonEventInput) => Promise<void>;
  recordDeferredBlockedStreamEvent?: (input: RecordProjectionDeferredEventInput) => Promise<void>;
  loadProjectionErrorSummary?: (projectionKey: string) => Promise<ProjectionErrorSummary>;
  listBlockedStreams?: (projectionKey: string) => Promise<readonly ProjectionBlockedStream[]>;
  resolveBlockedStream?: (projectionKey: string, streamId: StreamId) => Promise<void>;
  clearProjectionErrors?: (projectionKey: string) => Promise<void>;
}>;

export type ProjectorHandler = (event: Readonly<TransportEvent>) => Promise<void>;

export type ProjectorHandlerMap = Readonly<Record<string, ProjectorHandler>>;

export type ProjectorRunResult = Readonly<{
  processed: number;
  lastGlobalPosition: GlobalPosition;
  state?: ProjectionRunState;
  blockedStreams?: number;
  poisonEvents?: number;
}>;

export type Projector = Readonly<{
  projectorName?: string;
  runOnce: () => Promise<ProjectorRunResult>;
}>;

export type ProjectorConfig = Readonly<{
  projectorName: string;
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  handlers: ProjectorHandlerMap;
  batchSize?: number;
  errorPolicy?: ProjectionErrorPolicy;
}>;

export function createProjector(config: ProjectorConfig): Projector {
  const batchSize = assertPositiveInteger(config.batchSize ?? 100, "batchSize");
  const errorPolicy = config.errorPolicy ?? "strict-per-stream";

  return {
    projectorName: config.projectorName,
    runOnce: async () => {
      const checkpoint = await config.checkpointStore.loadCheckpoint(config.projectorName);
      const storedEvents = await config.eventStore.readAll({
        afterGlobalPosition: checkpoint,
        limit: batchSize,
      });

      if (storedEvents.length === 0) {
        const errorSummary = await loadProjectionErrorSummary(config.checkpointStore, config.projectorName);

        return {
          processed: 0,
          lastGlobalPosition: checkpoint,
          state: errorSummary.blockedStreamCount > 0 ? "degraded" : "caught-up",
          blockedStreams: errorSummary.blockedStreamCount,
          poisonEvents: errorSummary.poisonEventCount,
        };
      }

      let lastGlobalPosition = checkpoint;
      let processed = 0;

      for (const storedEvent of storedEvents) {
        const transportEvent = toTransportEvent(storedEvent);
        const handler = (config.handlers as Readonly<Record<string, ProjectorHandler | undefined>>)[
          transportEvent.type
        ];

        if (handler && errorPolicy === "strict-per-stream") {
          const blockedStream = await config.checkpointStore.loadBlockedStream?.(
            config.projectorName,
            transportEvent.streamId,
          );

          if (blockedStream && blockedStream.state !== "resolved") {
            await config.checkpointStore.recordDeferredBlockedStreamEvent?.({
              projectionKey: config.projectorName,
              streamId: transportEvent.streamId,
              streamVersion: transportEvent.streamVersion,
              globalPosition: transportEvent.globalPosition,
            });

            lastGlobalPosition = transportEvent.globalPosition;
            processed += 1;

            await config.checkpointStore.saveCheckpoint(config.projectorName, lastGlobalPosition);
            continue;
          }
        }

        if (handler) {
          try {
            await handler(transportEvent);
          } catch (error) {
            if (
              errorPolicy === "global-strict" ||
              isTransientProjectionError(error) ||
              !canRecordProjectionPoison(config.checkpointStore)
            ) {
              throw error;
            }

            await config.checkpointStore.recordPoisonEvent({
              projectionKey: config.projectorName,
              projectionName: config.projectorName,
              projectionKind: "projector",
              targetContextName: null,
              sourceContextName: null,
              projectionRevision: null,
              subscriptionVersion: null,
              streamId: transportEvent.streamId,
              streamVersion: transportEvent.streamVersion,
              eventId: String(transportEvent.id),
              eventType: transportEvent.type,
              globalPosition: transportEvent.globalPosition,
              failureKind: "poison",
              errorMessage: error instanceof Error ? error.message : String(error),
              errorStack: error instanceof Error ? (error.stack ?? null) : null,
            });
          }
        }

        lastGlobalPosition = transportEvent.globalPosition;
        processed += 1;

        await config.checkpointStore.saveCheckpoint(config.projectorName, lastGlobalPosition);
      }

      const errorSummary = await loadProjectionErrorSummary(config.checkpointStore, config.projectorName);

      return {
        processed,
        lastGlobalPosition,
        state: errorSummary.blockedStreamCount > 0 ? "degraded" : "running",
        blockedStreams: errorSummary.blockedStreamCount,
        poisonEvents: errorSummary.poisonEventCount,
      };
    },
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

function canRecordProjectionPoison(
  store: ProjectionCheckpointStore,
): store is ProjectionCheckpointStore &
  Required<
    Pick<ProjectionCheckpointStore, "recordPoisonEvent" | "loadBlockedStream" | "recordDeferredBlockedStreamEvent">
  > {
  return (
    typeof store.recordPoisonEvent === "function" &&
    typeof store.loadBlockedStream === "function" &&
    typeof store.recordDeferredBlockedStreamEvent === "function"
  );
}

async function loadProjectionErrorSummary(
  store: ProjectionCheckpointStore,
  projectionKey: string,
): Promise<ProjectionErrorSummary> {
  return store.loadProjectionErrorSummary
    ? store.loadProjectionErrorSummary(projectionKey)
    : { blockedStreamCount: 0, poisonEventCount: 0 };
}

function assertPositiveInteger(value: number, fieldName: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer.`);
  }

  return value;
}
