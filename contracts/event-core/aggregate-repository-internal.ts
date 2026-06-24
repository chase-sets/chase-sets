import { foldEvents, type DomainEvent } from "./domain";
import type { AggregateRepository, AggregateRepositoryConfig } from "./aggregate-repository";

const AGGREGATE_STREAM_READ_PAGE_SIZE = 500;

export function createAggregateRepository<State, Event extends DomainEvent>(
  config: AggregateRepositoryConfig<State, Event>,
): AggregateRepository<State, Event> {
  return {
    load: async (streamId) => {
      const storedEvents: Array<Awaited<ReturnType<typeof config.eventStore.readStream>>[number]> = [];
      let fromVersion: number | null = null;
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
      const state = foldEvents(config.initialState(), config.evolve, domainEvents);
      const version = storedEvents.length === 0 ? 0 : storedEvents[storedEvents.length - 1].streamVersion;

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
        expectedVersion: input.expectedVersion,
        context: input.context,
        events: encodedEvents,
      });
    },
  };
}
