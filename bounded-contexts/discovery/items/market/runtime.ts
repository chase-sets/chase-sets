import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import type { DiscoveryRuntimeDeps } from "../../runtime-support";
import { buildDiscoveryMarketProjectionHandlers } from "./projection";

export type DiscoveryMarketServices = Readonly<{
  projectors: readonly Projector[];
}>;

export function createDiscoveryMarketRuntime(
  deps: DiscoveryRuntimeDeps,
): DiscoveryMarketServices {
  return {
    projectors: [
      createProjector({
        projectorName: "discovery-market-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildDiscoveryMarketProjectionHandlers(deps.db),
      }),
    ],
  };
}
