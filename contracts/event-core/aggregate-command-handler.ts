import {
  createAggregateRepository,
  type AggregateRepository,
  type AggregateRepositoryConfig,
} from "./aggregate-repository";
import { createCommandHandler, type CommandHandler } from "./command-handler";
import type { AggregateDecider, DomainEvent } from "./domain";

export type AggregateCommandHandlerConfig<State, Command, Event extends DomainEvent> = AggregateRepositoryConfig<
  State,
  Event
> &
  Readonly<{
    decide: AggregateDecider<State, Command, Event>;
  }>;

export type AggregateCommandHandlerRuntime<State, Command, Event extends DomainEvent> = Readonly<{
  commandHandler: CommandHandler<Command, State, Event>;
  repository: AggregateRepository<State, Event>;
}>;

export function createAggregateCommandHandler<State, Command, Event extends DomainEvent>(
  config: AggregateCommandHandlerConfig<State, Command, Event>,
): AggregateCommandHandlerRuntime<State, Command, Event> {
  const repository = createAggregateRepository({
    eventStore: config.eventStore,
    codec: config.codec,
    initialState: config.initialState,
    evolve: config.evolve,
  });
  const commandHandler = createCommandHandler({
    repository,
    evolve: config.evolve,
    decide: config.decide,
  });

  return {
    commandHandler,
    repository,
  };
}
