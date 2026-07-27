import { applyEvents, type DomainEvent } from "./domain";
import { recordCommittedEvents } from "./consistency";
import type { CommandHandler, CommandHandlerConfig } from "./command-handler";

export function createCommandHandler<State, Command, Event extends DomainEvent>(
  config: CommandHandlerConfig<State, Command, Event>,
): CommandHandler<Command, State, Event> {
  return async (input) => {
    const loaded = await config.repository.load(input.streamId);
    const newEvents = await config.decide(loaded.state, input.command);
    const guards = input.guards ?? [];

    // A suppressed command still has to honour its guards: the caller read
    // guarded state to decide there was nothing to do, and that decision is
    // only sound if the state it read has not moved. Skipping the append here
    // would make such a guard silently inert.
    if (newEvents.length === 0 && guards.length === 0) {
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
      ...(config.commitSourceContextName ? { wakeSourceContextName: config.commitSourceContextName } : {}),
      expectedVersion,
      context: input.context,
      events: newEvents,
      ...(guards.length > 0 ? { guards } : {}),
    });
    recordCommittedEvents(storedEvents, config.commitSourceContextName);
    const state = applyEvents(loaded.state, config.evolve, newEvents);
    const version = storedEvents.length === 0 ? loaded.version : storedEvents[storedEvents.length - 1].streamVersion;

    // Write-behind snapshot scheduling happens after commit, outside the
    // append critical path, and must never fail a command -- scheduleSnapshot
    // itself is non-throwing (see aggregate-repository-internal.ts), but this
    // stays defensive against a future implementation change.
    try {
      config.repository.scheduleSnapshot?.({
        streamId: input.streamId,
        priorVersion: loaded.version,
        version,
        state,
      });
    } catch {
      // Snapshotting is a cache optimization; swallow and continue.
    }

    return {
      state,
      version,
      newEvents,
      storedEvents,
    };
  };
}
