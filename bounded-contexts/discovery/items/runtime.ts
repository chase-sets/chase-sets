import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import type { DiscoveryRuntimeDeps } from "../runtime-support";
import { getDiscoveryItemDetail, type DiscoveryItemDetailRow } from "./detail/queries";
import { buildDiscoveryItemDetailProjectionHandlers } from "./detail/projection";
import { searchDiscoveryItems, type DiscoverySearchItemRow, type DiscoverySearchParams, type ListResult } from "./search/queries";
import {
  buildDiscoverySearchItemProjectionHandlers,
  rebuildDiscoverySearchIndex,
} from "./search/projection";

export type DiscoveryItemServices = Readonly<{
  searchItems: (params?: DiscoverySearchParams) => Promise<ListResult<DiscoverySearchItemRow>>;
  getItemDetail: (itemId: string) => Promise<DiscoveryItemDetailRow | null>;
  rebuildSearchIndex: () => Promise<void>;
  projectors: readonly Projector[];
}>;

export function createDiscoveryItemRuntime(
  deps: DiscoveryRuntimeDeps,
): DiscoveryItemServices {
  return {
    searchItems: (params = {}) => searchDiscoveryItems(deps.db, params),
    getItemDetail: (itemId) => getDiscoveryItemDetail(deps.db, itemId),
    rebuildSearchIndex: () => rebuildDiscoverySearchIndex(deps.db),
    projectors: [
      createProjector({
        projectorName: "discovery-search-item-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildDiscoverySearchItemProjectionHandlers(deps.db),
      }),
      createProjector({
        projectorName: "discovery-item-detail-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildDiscoveryItemDetailProjectionHandlers(deps.db),
      }),
    ],
  };
}

