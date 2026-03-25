import { createProjector, type Projector } from "../../../contracts/event-core/projector";
import type { DiscoveryRuntimeDeps } from "../runtime-support";
import { buildDiscoveryItemDetailProjectionHandlers } from "./projection";

export function createItemDetailProjectors(
  deps: DiscoveryRuntimeDeps,
): readonly Projector[] {
  return [
    createProjector({
      projectorName: "discovery-item-detail-projection",
      eventStore: deps.eventStore,
      checkpointStore: deps.checkpointStore,
      handlers: buildDiscoveryItemDetailProjectionHandlers(deps.db),
    }),
  ];
}
