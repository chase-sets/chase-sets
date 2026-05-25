import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { DiscoveryRuntimeDeps } from "../../../support/runtime-support";
import {
  searchDiscoveryItems,
  previewBulkAddSearchResults,
  type DiscoveryBulkCartPreview,
  type DiscoverySearchItemRow,
  type DiscoverySearchParams,
  type ListResult,
} from "../read-model/queries";
import { buildDiscoverySearchItemProjectionHandlers, rebuildDiscoverySearchIndex } from "../read-model/projection";

export type DiscoveryItemSearchServices = Readonly<{
  searchItems: (params?: DiscoverySearchParams) => Promise<ListResult<DiscoverySearchItemRow>>;
  previewBulkAdd: (params?: DiscoverySearchParams) => Promise<DiscoveryBulkCartPreview>;
  rebuildSearchIndex: () => Promise<void>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createDiscoveryItemSearchRuntime(deps: DiscoveryRuntimeDeps): DiscoveryItemSearchServices {
  return {
    searchItems: (params = {}) => searchDiscoveryItems(deps.db, params),
    previewBulkAdd: (params = {}) => previewBulkAddSearchResults(deps.db, params),
    rebuildSearchIndex: () => rebuildDiscoverySearchIndex(deps.db),
    projectors: [
      createProjectionHandlerSet({
        projectionName: "discovery-search-item-projection",
        handlers: buildDiscoverySearchItemProjectionHandlers(deps.db),
      }),
    ],
  };
}
