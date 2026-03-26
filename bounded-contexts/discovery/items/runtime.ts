import type { Projector } from "@chase-sets/event-core/projector";
import type { DiscoveryRuntimeDeps } from "../runtime-support";
import {
  createDiscoveryItemDetailRuntime,
  type DiscoveryItemDetailServices,
} from "./detail/runtime";
import {
  createDiscoveryItemSearchRuntime,
  type DiscoveryItemSearchServices,
} from "./search/runtime";

export type DiscoveryItemsServices = Readonly<{
  search: DiscoveryItemSearchServices;
  detail: DiscoveryItemDetailServices;
  projectors: readonly Projector[];
}>;

export function createDiscoveryItemRuntime(
  deps: DiscoveryRuntimeDeps,
): DiscoveryItemsServices {
  const search = createDiscoveryItemSearchRuntime(deps);
  const detail = createDiscoveryItemDetailRuntime(deps);

  return {
    search,
    detail,
    projectors: [...search.projectors, ...detail.projectors],
  };
}