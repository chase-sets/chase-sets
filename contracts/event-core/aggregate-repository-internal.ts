import { foldEvents, type DomainEvent } from "./domain";
import type {
  AggregateRepository,
  AggregateRepositoryConfig,
  AggregateRepositorySnapshotConfig,
} from "./aggregate-repository";

const AGGREGATE_STREAM_READ_PAGE_SIZE = 500;

export function createAggregateRepository<State, Event extends DomainEvent>(
  config: AggregateRepositoryConfig<State, Event>,
): AggregateRepository<State, Event> {
  const snapshots = config.snapshots;
  if (snapshots) {
    assertPositiveInteger(snapshots.schemaVersion, "snapshots.schemaVersion");
    assertPositiveInteger(snapshots.everyNEvents, "snapshots.everyNEvents");
  }

  return {
    load: async (streamId) => {
      const snapshotBase = snapshots ? await loadSnapshotBase(snapshots, streamId) : null;

      const storedEvents: Array<Awaited<ReturnType<typeof config.eventStore.readStream>>[number]> = [];
      let fromVersion: number | null = snapshotBase ? snapshotBase.streamVersion + 1 : null;
      for (;;) {
        const page = await config.eventStore.readStream(
          fromVersion === null
            ? { streamId }
            : {
                streamId,
                fromVersion,
                limit: AGGREGATE_STREAM_READ_PAGE_SIZE,
              },
        );
        storedEvents.push(...page);
        if (page.length < AGGREGATE_STREAM_READ_PAGE_SIZE) {
          break;
        }
        fromVersion = page[page.length - 1].streamVersion + 1;
      }
      const domainEvents = storedEvents.map((storedEvent) =>
        config.codec.decode({
          eventType: storedEvent.eventType,
          payload: storedEvent.payload,
        }),
      );
      const baseState = snapshotBase ? snapshotBase.state : config.initialState();
      const state = foldEvents(baseState, config.evolve, domainEvents);
      const version =
        storedEvents.length === 0
          ? (snapshotBase?.streamVersion ?? 0)
          : storedEvents[storedEvents.length - 1].streamVersion;

      return {
        state,
        version,
        events: domainEvents,
        storedEvents,
      };
    },

    append: async (input) => {
      const encodedEvents = input.events.map((event, index) => {
        const encoded = config.codec.encode(event);
        const metadata = typeof input.metadata === "function" ? input.metadata(event, index) : input.metadata;

        return {
          ...encoded,
          metadata,
        };
      });

      return config.eventStore.appendToStream({
        streamId: input.streamId,
        ...(input.wakeSourceContextName ? { wakeSourceContextName: input.wakeSourceContextName } : {}),
        expectedVersion: input.expectedVersion,
        context: input.context,
        events: encodedEvents,
      });
    },

    ...(snapshots
      ? {
          scheduleSnapshot: (
            input: Parameters<NonNullable<AggregateRepository<State, Event>["scheduleSnapshot"]>>[0],
          ) => {
            if (!crossesSnapshotThreshold(input.priorVersion, input.version, snapshots.everyNEvents)) {
              return;
            }

            void snapshots.store
              .save({
                streamId: input.streamId,
                streamVersion: input.version,
                schemaVersion: snapshots.schemaVersion,
                state: input.state,
              })
              .catch((error: unknown) => {
                snapshots.onSnapshotWriteFailed?.(error, {
                  streamId: input.streamId,
                  streamVersion: input.version,
                });
              });
          },
        }
      : {}),
  };
}

type SnapshotBase<State> = Readonly<{ streamVersion: number; state: State }>;

/**
 * Reads the latest snapshot for a stream, ignoring (never throwing on) a
 * missing row, a schema-version mismatch after an `evolve` change, or a
 * failed read -- every one of those cases must fall back to full replay
 * exactly as if no snapshot existed.
 */
async function loadSnapshotBase<State>(
  snapshots: AggregateRepositorySnapshotConfig<State>,
  streamId: string,
): Promise<SnapshotBase<State> | null> {
  try {
    const stored = await snapshots.store.loadLatest(streamId);
    if (!stored || stored.schemaVersion !== snapshots.schemaVersion) {
      return null;
    }
    return { streamVersion: stored.streamVersion, state: stored.state };
  } catch {
    return null;
  }
}

/** True when `version` crossed a multiple of `everyNEvents` that `priorVersion` had not yet reached. */
function crossesSnapshotThreshold(priorVersion: number, version: number, everyNEvents: number): boolean {
  if (everyNEvents <= 0 || version <= priorVersion) {
    return false;
  }
  return Math.floor(version / everyNEvents) > Math.floor(priorVersion / everyNEvents);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`AggregateRepositoryConfig.${label} must be a positive integer.`);
  }
}
