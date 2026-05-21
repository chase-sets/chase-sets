import type { JsonObject } from "../primitives/json";
import { foldEvents, type AggregateEvolver, type DomainEvent } from "./domain";
import type { DomainEventCodec } from "./codec";
import type { EventStore } from "./event-store";
import type { EventStoreContext, ExpectedStreamVersion, StoredEvent } from "./storage";

export type LoadedAggregate<State, Event extends DomainEvent> = Readonly<{
  state: State;
  version: number;
  events: readonly Event[];
  storedEvents: readonly StoredEvent[];
}>;

export type AppendDomainEventsInput<Event extends DomainEvent> = Readonly<{
  streamId: string;
  expectedVersion: ExpectedStreamVersion;
  context: EventStoreContext;
  events: readonly Event[];
  metadata?: JsonObject | ((event: Readonly<Event>, index: number) => JsonObject | undefined);
}>;

export type AggregateRepository<State, Event extends DomainEvent> = Readonly<{
  load: (streamId: string) => Promise<LoadedAggregate<State, Event>>;
  append: (input: AppendDomainEventsInput<Event>) => Promise<readonly StoredEvent[]>;
}>;

export type AggregateRepositoryConfig<State, Event extends DomainEvent> = Readonly<{
  eventStore: EventStore;
  codec: DomainEventCodec<Event>;
  initialState: () => State;
  evolve: AggregateEvolver<State, Event>;
}>;

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
