import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { DiscoveryRuntimeDeps } from "../runtime-support";
import {
  createDiscoveryItemDetailRuntime,
  type DiscoveryItemDetailServices,
} from "../../features/item-detail/api/runtime";
import { createDiscoveryMarketRuntime, type DiscoveryMarketServices } from "../market-support/runtime";
import {
  createDiscoveryItemSearchRuntime,
  type DiscoveryItemSearchServices,
  type DiscoverySearchQuerySignal,
} from "../../features/search/api/runtime";
import type { QueryEmbeddingCache } from "../../features/search/domain/query-embedding-cache";
import type { DiscoveryEmbeddingProvider } from "../../features/search/integrations/voyage-embedding-provider";
import type { DiscoveryRetrievalMode } from "../../features/search/read-model/hybrid-retrieval";

export type DiscoveryItemsServices = Readonly<{
  market: DiscoveryMarketServices;
  search: DiscoveryItemSearchServices;
  detail: DiscoveryItemDetailServices;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createDiscoveryItemRuntime(
  deps: DiscoveryRuntimeDeps,
  searchRetrieval: Readonly<{
    provider?: DiscoveryEmbeddingProvider;
    cache?: QueryEmbeddingCache;
    rescueEnabled?: boolean;
    hybridEnabled?: boolean;
    recordSearchQuery?: (signal: DiscoverySearchQuerySignal) => void;
  }> = {},
): DiscoveryItemsServices {
  const market = createDiscoveryMarketRuntime(deps);
  const search = createDiscoveryItemSearchRuntime(deps, searchRetrieval);
  const detail = createDiscoveryItemDetailRuntime(deps, {
    semanticSimilarItemsEnabled: Boolean(searchRetrieval.provider),
  });

  return {
    market,
    search,
    detail,
    projectors: [...market.projectors, ...search.projectors, ...detail.projectors],
  };
}
