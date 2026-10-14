import type { EventStore } from "@chase-sets/event-core/event-store";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { createInventoryMutationRuntime } from "./mutation-attempt";

export type InventoryRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
  mutationChild?: ReturnType<typeof createInventoryMutationRuntime>["child"];
}>;
