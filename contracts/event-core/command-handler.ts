import { applyEvents, type AggregateDecider, type AggregateEvolver, type DomainEvent } from "./domain";
import type { AggregateRepository } from "./aggregate-repository";
import type { EventStoreContext, ExpectedStreamVersion, StoredEvent } from "./storage";
import { recordCommittedEvents } from "./consistency";

export type CommandHandlerInput<Command> = Readonly<{
  streamId: string;
  command: Command;
  context: EventStoreContext;
  expectedVersion?: ExpectedStreamVersion;
}>;

export type CommandExecutionResult<State, Event extends DomainEvent> = Readonly<{
  state: State;
  version: number;
  newEvents: readonly Event[];
  storedEvents: readonly StoredEvent[];
}>;

export type CommandHandler<Command, State, Event extends DomainEvent> = (
  input: CommandHandlerInput<Command>,
) => Promise<CommandExecutionResult<State, Event>>;

export type CommandHandlerConfig<State, Command, Event extends DomainEvent> = Readonly<{
  repository: AggregateRepository<State, Event>;
  evolve: AggregateEvolver<State, Event>;
  decide: AggregateDecider<State, Command, Event>;
}>;

export function createCommandHandler<State, Command, Event extends DomainEvent>(
  config: CommandHandlerConfig<State, Command, Event>,
): CommandHandler<Command, State, Event> {
  return async (input) => {
    const loaded = await config.repository.load(input.streamId);
    const newEvents = await config.decide(loaded.state, input.command);

    if (newEvents.length === 0) {
      return {
        state: loaded.state,
        version: loaded.version,
        newEvents,
        storedEvents: [],
      };
    }

    const expectedVersion = input.expectedVersion ?? loaded.version;
    const storedEvents = await config.repository.append({
      streamId: input.streamId,
      expectedVersion,
      context: input.context,
      events: newEvents,
    });
    recordCommittedEvents(storedEvents);
    const state = applyEvents(loaded.state, config.evolve, newEvents);
    const version = storedEvents.length === 0 ? loaded.version : storedEvents[storedEvents.length - 1].streamVersion;

    return {
      state,
      version,
      newEvents,
      storedEvents,
    };
  };
}
