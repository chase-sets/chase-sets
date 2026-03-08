import type { EventStoreContext } from "../../../../contracts/event-core/storage";

export type CatalogAuthoringEnv = {
  Variables: {
    context: EventStoreContext;
  };
};
