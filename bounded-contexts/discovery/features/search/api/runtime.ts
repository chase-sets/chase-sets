import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { DiscoveryRuntimeDeps } from "../../../support/runtime-support";
import type { QueryEmbeddingCache } from "../domain/query-embedding-cache";
import type { DiscoveryEmbeddingProvider } from "../integrations/voyage-embedding-provider";
import { retrieveDiscoveryItems, type DiscoverySearchResult } from "../read-model/hybrid-retrieval";
import {
  previewBulkAddSearchResults,
  type DiscoveryBulkCartPreview,
  type DiscoverySearchParams,
} from "../read-model/queries";
import { buildDiscoverySearchItemProjectionHandlers, rebuildDiscoverySearchIndex } from "../read-model/projection";

export type DiscoveryItemSearchServices = Readonly<{
  searchItems: (params?: DiscoverySearchParams) => Promise<DiscoverySearchResult>;
  previewBulkAdd: (params?: DiscoverySearchParams) => Promise<DiscoveryBulkCartPreview>;
  rebuildSearchIndex: () => Promise<void>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createDiscoveryItemSearchRuntime(
  deps: DiscoveryRuntimeDeps,
  retrieval: Readonly<{
    provider?: DiscoveryEmbeddingProvider;
    cache?: QueryEmbeddingCache;
    rescueEnabled?: boolean;
    hybridEnabled?: boolean;
    recordRetrievalMode?: (mode: DiscoverySearchResult["retrievalMode"]) => void;
  }> = {},
): DiscoveryItemSearchServices {
  return {
    searchItems: async (params = {}) => {
      const result = await retrieveDiscoveryItems(
        {
          db: deps.db,
          provider: retrieval.provider,
          cache: retrieval.cache,
          rescueEnabled: retrieval.rescueEnabled ?? false,
          hybridEnabled: retrieval.hybridEnabled ?? false,
        },
        params,
      );
      try {
        retrieval.recordRetrievalMode?.(result.retrievalMode);
      } catch {
        // Telemetry must never become a search dependency.
      }
      return result;
    },
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
