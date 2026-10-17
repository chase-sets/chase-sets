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
  type DiscoverySearchRetrievalOptions,
} from "../../features/search/api/runtime";

export type DiscoveryItemsServices = Readonly<{
  market: DiscoveryMarketServices;
  search: DiscoveryItemSearchServices;
  detail: DiscoveryItemDetailServices;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createDiscoveryItemRuntime(
  deps: DiscoveryRuntimeDeps,
  searchRetrieval: DiscoverySearchRetrievalOptions = {},
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
