import { foldEvents, type AggregateEvolver, type DomainEvent } from "@chase-sets/event-core/domain";
import { CatalogDomainError } from "../common";

export function givenEvents<State, Event extends DomainEvent>(
  initialState: State,
  evolve: AggregateEvolver<State, Event>,
  events: readonly Event[],
): State {
  return foldEvents(initialState, evolve, events);
}

export function decide<State, Command, Event extends DomainEvent>(
  decider: (state: Readonly<State>, command: Readonly<Command>) => readonly Event[] | Promise<readonly Event[]>,
  state: State,
  command: Command,
): readonly Event[] {
  const result = decider(state, command);

  if (result instanceof Promise) {
    throw new Error("Expected synchronous decider in tests.");
  }

  return result;
}

export function expectDomainError(
  fn: () => unknown,
  expectedMessage?: string,
): void {
  try {
    fn();
    throw new Error("Expected CatalogDomainError to be thrown.");
  } catch (error) {
    if (!(error instanceof CatalogDomainError)) {
      throw error;
    }

    if (expectedMessage && error.message !== expectedMessage) {
      throw new Error(
        `Expected error message "${expectedMessage}" but got "${error.message}".`,
      );
    }
  }
}


