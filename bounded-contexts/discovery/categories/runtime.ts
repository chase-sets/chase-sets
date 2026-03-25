import { createProjector, type Projector } from "../../../contracts/event-core/projector";
import type { DiscoveryRuntimeDeps } from "../runtime-support";
import { buildDiscoveryCategoryProjectionHandlers } from "./projection";

export function createCategoryProjectors(
  deps: DiscoveryRuntimeDeps,
): readonly Projector[] {
  return [
    createProjector({
      projectorName: "discovery-category-projection",
      eventStore: deps.eventStore,
      checkpointStore: deps.checkpointStore,
      handlers: buildDiscoveryCategoryProjectionHandlers(deps.db),
    }),
  ];
}
