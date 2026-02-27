import type { EventStore } from "./event-store";
import type { GlobalPosition } from "./storage";
import { toTransportEvent, type TransportEvent } from "./transport";

export type ProjectionCheckpointStore = Readonly<{
  loadCheckpoint: (projectorName: string) => Promise<GlobalPosition>;
  saveCheckpoint: (
    projectorName: string,
    globalPosition: GlobalPosition,
  ) => Promise<void>;
}>;

export type ProjectorHandler = (
  event: Readonly<TransportEvent>,
) => Promise<void>;

export type ProjectorHandlerMap = Readonly<Record<string, ProjectorHandler>>;

export type ProjectorRunResult = Readonly<{
  processed: number;
  lastGlobalPosition: GlobalPosition;
}>;

export type Projector = Readonly<{
  runOnce: () => Promise<ProjectorRunResult>;
}>;

export type ProjectorConfig = Readonly<{
  projectorName: string;
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  handlers: ProjectorHandlerMap;
  batchSize?: number;
}>;

export function createProjector(config: ProjectorConfig): Projector {
  const batchSize = assertPositiveInteger(config.batchSize ?? 100, "batchSize");

  return {
    runOnce: async () => {
      const checkpoint = await config.checkpointStore.loadCheckpoint(
        config.projectorName,
      );
      const storedEvents = await config.eventStore.readAll({
        afterGlobalPosition: checkpoint,
        limit: batchSize,
      });

      if (storedEvents.length === 0) {
        return {
          processed: 0,
          lastGlobalPosition: checkpoint,
        };
      }

      let lastGlobalPosition = checkpoint;
      let processed = 0;

      for (const storedEvent of storedEvents) {
        const transportEvent = toTransportEvent(storedEvent);
        const handler = config.handlers[transportEvent.type];

        if (handler) {
          await handler(transportEvent);
        }

        lastGlobalPosition = transportEvent.globalPosition;
        processed += 1;

        await config.checkpointStore.saveCheckpoint(
          config.projectorName,
          lastGlobalPosition,
        );
      }

      return {
        processed,
        lastGlobalPosition,
      };
    },
  };
}

function assertPositiveInteger(value: number, fieldName: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer.`);
  }

  return value;
}
