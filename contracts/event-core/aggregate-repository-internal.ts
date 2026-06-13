import { foldEvents, type DomainEvent } from "./domain";
import type { AggregateRepository, AggregateRepositoryConfig } from "./aggregate-repository";

export function createAggregateRepository<State, Event extends DomainEvent>(
  config: AggregateRepositoryConfig<State, Event>,
): AggregateRepository<State, Event> {
  return {
    load: async (streamId) => {
      const storedEvents = await config.eventStore.readStream({ streamId });
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
