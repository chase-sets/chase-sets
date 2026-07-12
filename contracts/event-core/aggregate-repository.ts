import type { JsonObject } from "../primitives/json";
import type { AggregateEvolver, DomainEvent } from "./domain";
import type { AggregateSnapshotStore } from "./aggregate-snapshot-store";
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

/**
 * Per-aggregate snapshot opt-in (m113: aggregate snapshots in event-core).
 * Adoption is a repository config, never global: an aggregate that never
 * sets `snapshots` behaves exactly as before this feature existed.
 */
export type AggregateRepositorySnapshotConfig<State> = Readonly<{
  store: AggregateSnapshotStore<State>;
  /**
   * Bump whenever `evolve`'s fold shape changes in a way that would make an
   * old snapshot's `state` incompatible. A stored snapshot whose
   * `schemaVersion` does not match this value is treated as stale and
   * ignored -- `load()` falls back to full replay, exactly as if no
   * snapshot existed.
   */
  schemaVersion: number;
  /** Write a snapshot after a command whose resulting version crosses a multiple of this threshold. */
  everyNEvents: number;
  /**
   * Optional observer for write-behind snapshot failures. Snapshot writes
   * never block or fail the command that triggered them -- see
   * `scheduleSnapshot` on `AggregateRepository`.
   */
  onSnapshotWriteFailed?: (error: unknown, context: Readonly<{ streamId: string; streamVersion: number }>) => void;
}>;

export type ScheduleAggregateSnapshotInput<State> = Readonly<{
  streamId: string;
  priorVersion: number;
  version: number;
  state: State;
}>;

export type AggregateRepository<State, Event extends DomainEvent> = Readonly<{
  load: (streamId: string) => Promise<LoadedAggregate<State, Event>>;
  append: (input: AppendDomainEventsInput<Event>) => Promise<readonly StoredEvent[]>;
  /**
   * Present only when the repository is configured with `snapshots`.
   * Schedules (never awaits) a write-behind snapshot save once the
   * configured event threshold is crossed. Called by the command handler
   * after a successful append with the fully-folded post-command state --
   * never in the append/command critical path, and never throws.
   */
  scheduleSnapshot?: (input: ScheduleAggregateSnapshotInput<State>) => void;
}>;

export type AggregateRepositoryConfig<State, Event extends DomainEvent> = Readonly<{
  eventStore: EventStore;
  codec: DomainEventCodec<Event>;
  initialState: () => State;
  evolve: AggregateEvolver<State, Event>;
  snapshots?: AggregateRepositorySnapshotConfig<State>;
}>;
