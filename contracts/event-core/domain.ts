import type { JsonObject } from "../primitives/json";

// Domain events keep only what aggregates need for deterministic rehydration.
export type DomainEvent<
  Type extends string = string,
  Data extends JsonObject = JsonObject,
> = Readonly<{
  type: Type;
  data: Data;
}>;

export type AggregateEvolver<
  State,
  Event extends DomainEvent = DomainEvent,
> = (state: Readonly<State>, event: Readonly<Event>) => State;

export type AggregateDecider<
  State,
  Command,
  Event extends DomainEvent = DomainEvent,
> = (
  state: Readonly<State>,
  command: Readonly<Command>,
) => readonly Event[] | Promise<readonly Event[]>;

export type RehydratedAggregate<
  State,
  Event extends DomainEvent = DomainEvent,
> = Readonly<{
  state: State;
  version: number;
  events: readonly Event[];
}>;

export function foldEvents<State, Event extends DomainEvent>(
  initialState: State,
  evolve: AggregateEvolver<State, Event>,
  events: readonly Event[],
): State {
  return events.reduce((state, event) => evolve(state, event), initialState);
}

export function applyEvents<State, Event extends DomainEvent>(
  currentState: State,
  evolve: AggregateEvolver<State, Event>,
  events: readonly Event[],
): State {
  return events.reduce((state, event) => evolve(state, event), currentState);
}

export function rehydrateAggregate<State, Event extends DomainEvent>(
  initialState: State,
  evolve: AggregateEvolver<State, Event>,
  events: readonly Event[],
): RehydratedAggregate<State, Event> {
  return {
    state: foldEvents(initialState, evolve, events),
    version: events.length,
    events,
  };
}
