import type { AggregateDecider, AggregateEvolver, DomainEvent } from "./domain";
import type { AggregateRepository } from "./aggregate-repository";
import type { AppendToStreamInput, EventStoreContext, ExpectedStreamVersion, StoredEvent } from "./storage";

export type CommandHandlerInput<Command> = Readonly<{
  streamId: string;
  command: Command;
  context: EventStoreContext;
  expectedVersion?: ExpectedStreamVersion;
  /**
   * Streams outside this aggregate whose version this command's append must be
   * consistent with. The command commits in one all-or-nothing transaction with
   * every guard, so state a handler read to decide the command cannot change
   * between that read and the append without the whole command failing.
   */
  guards?: readonly AppendToStreamInput[];
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
  commitSourceContextName?: string;
}>;
