import type { Projector } from "@chase-sets/event-core/projector";
import type { DiscoveryRuntimeDeps } from "../runtime-support";
import {
  createDiscoveryItemDetailRuntime,
  type DiscoveryItemDetailServices,
} from "./detail/runtime";
import {
  createDiscoveryMarketRuntime,
  type DiscoveryMarketServices,
} from "./market/runtime";
import {
  createDiscoveryItemSearchRuntime,
  type DiscoveryItemSearchServices,
} from "./search/runtime";

export type DiscoveryItemsServices = Readonly<{
  market: DiscoveryMarketServices;
  search: DiscoveryItemSearchServices;
  detail: DiscoveryItemDetailServices;
  projectors: readonly Projector[];
}>;

export function createDiscoveryItemRuntime(
  deps: DiscoveryRuntimeDeps,
): DiscoveryItemsServices {
  const market = createDiscoveryMarketRuntime(deps);
  const search = createDiscoveryItemSearchRuntime(deps);
  const detail = createDiscoveryItemDetailRuntime(deps);

  return {
    market,
    search,
    detail,
    projectors: [...market.projectors, ...search.projectors, ...detail.projectors],
  };
}
