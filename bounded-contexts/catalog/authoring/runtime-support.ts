import type { EventStore } from "../../../contracts/event-core/event-store";
import type { ProjectionCheckpointStore } from "../../../contracts/event-core/projector";
import type { PgQueryable } from "../../../contracts/event-core/postgres/types";

export type CatalogRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
}>;
