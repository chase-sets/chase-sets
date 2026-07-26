import {
  loadSeedAggregateState as loadSharedSeedAggregateState,
  loadSeedStreamEvents,
  type SeedAggregateState as SharedSeedAggregateState,
  type SeedAggregateStateInput as SharedSeedAggregateStateInput,
} from "@chase-sets/bounded-context-runtime";
import type { AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { CatalogLifecycleStatus } from "../runtime-support/common";

export { loadSeedStreamEvents };

/** Catalog's authoring aggregates all share this lifecycle identity shape. */
export type SeedAggregateLifecycleState = Readonly<{
  id: string | null;
  key: string | null;
  status: CatalogLifecycleStatus;
}>;

export type SeedAggregateState<
  State extends SeedAggregateLifecycleState,
  Event extends DomainEvent,
> = SharedSeedAggregateState<State, Event>;

export const CATALOG_SEED_BOOTSTRAP_LABEL = "Catalog integration bootstrap";

/**
 * Catalog's binding of the shared stream-sourced seed fold
 * (`@chase-sets/bounded-context-runtime`). It pins the context's bootstrap
 * label and lifecycle vocabulary; the fold itself lives in exactly one place.
 */
export async function loadSeedAggregateState<
  State extends SeedAggregateLifecycleState,
  Event extends DomainEvent,
>(input: {
  db: PgQueryable;
  aggregateName: string;
  streamId: string;
  createdEventType: Event["type"];
  createdIdField: string;
  expectedId: string;
  expectedKey: string;
  keyScope?: SharedSeedAggregateStateInput<State, Event>["keyScope"];
  initialState: State;
  evolve: AggregateEvolver<State, Event>;
  validateIdentity?: (state: State) => void;
}): Promise<SeedAggregateState<State, Event>> {
  return loadSharedSeedAggregateState<State, Event>({
    ...input,
    bootstrapLabel: CATALOG_SEED_BOOTSTRAP_LABEL,
    identity: (state) => ({ id: state.id, key: state.key }),
    status: (state) => String(state.status),
    completedStatuses: ["active"],
    terminalStatuses: ["deprecated", "archived"],
    resumableStatuses: ["draft"],
  });
}
