import { createProjector, type Projector } from "../../../contracts/event-core/projector";
import type { DiscoveryRuntimeDeps } from "../runtime-support";
import { buildDiscoverySearchItemProjectionHandlers } from "./projection";

export function createSearchProjectors(
  deps: DiscoveryRuntimeDeps,
): readonly Projector[] {
  return [
    createProjector({
      projectorName: "discovery-search-item-projection",
      eventStore: deps.eventStore,
      checkpointStore: deps.checkpointStore,
      handlers: buildDiscoverySearchItemProjectionHandlers(deps.db),
    }),
  ];
}
