import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { DiscoveryRuntimeDeps } from "../../../support/runtime-support";
import { getDiscoveryItemDetail, type DiscoveryItemDetailRow } from "../read-model/queries";
import { buildDiscoveryItemDetailProjectionHandlers } from "../read-model/projection";

export type DiscoveryItemDetailServices = Readonly<{
  getItemDetail: (itemId: string) => Promise<DiscoveryItemDetailRow | null>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createDiscoveryItemDetailRuntime(deps: DiscoveryRuntimeDeps): DiscoveryItemDetailServices {
  return {
    getItemDetail: (itemId) => getDiscoveryItemDetail(deps.db, itemId),
    projectors: [
      createProjectionHandlerSet({
        projectionName: "discovery-item-detail-projection",
        handlers: buildDiscoveryItemDetailProjectionHandlers(deps.db),
      }),
    ],
  };
}
