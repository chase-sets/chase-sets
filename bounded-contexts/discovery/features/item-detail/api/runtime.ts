import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import type { DiscoveryRuntimeDeps } from "../../../support/runtime-support";
import { getDiscoveryItemDetail, type DiscoveryItemDetailRow } from "../read-model/queries";
import { buildDiscoveryItemDetailProjectionHandlers } from "../read-model/projection";

export type DiscoveryItemDetailServices = Readonly<{
  getItemDetail: (itemId: string) => Promise<DiscoveryItemDetailRow | null>;
  projectors: readonly Projector[];
}>;

export function createDiscoveryItemDetailRuntime(deps: DiscoveryRuntimeDeps): DiscoveryItemDetailServices {
  return {
    getItemDetail: (itemId) => getDiscoveryItemDetail(deps.db, itemId),
    projectors: [
      createProjector({
        projectorName: "discovery-item-detail-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildDiscoveryItemDetailProjectionHandlers(deps.db),
      }),
    ],
  };
}
