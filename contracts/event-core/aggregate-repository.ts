import type { JsonObject } from "../primitives/json";
import type { AggregateEvolver, DomainEvent } from "./domain";
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
