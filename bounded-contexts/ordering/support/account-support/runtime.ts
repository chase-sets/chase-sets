import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { buildOrderingAccountProjectionHandlers } from "./projection";

type OrderingAccountRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
}>;

export type OrderingAccountServices = Readonly<{
  projectors: readonly Projector[];
}>;

export function createOrderingAccountRuntime(deps: OrderingAccountRuntimeDeps): OrderingAccountServices {
  return {
    projectors: [
      createProjector({
        projectorName: "ordering-account-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildOrderingAccountProjectionHandlers(deps.db),
      }),
    ],
  };
}
