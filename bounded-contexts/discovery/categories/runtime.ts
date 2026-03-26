import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import type { DiscoveryRuntimeDeps } from "../runtime-support";
import { listDiscoveryCategories, type DiscoveryCategoryRow } from "./queries";
import { buildDiscoveryCategoryProjectionHandlers } from "./projection";

export type DiscoveryCategoryServices = Readonly<{
  listCategories: (
    params?: { parentCategoryId?: string; status?: string },
  ) => Promise<DiscoveryCategoryRow[]>;
  projectors: readonly Projector[];
}>;

export function createDiscoveryCategoryRuntime(
  deps: DiscoveryRuntimeDeps,
): DiscoveryCategoryServices {
  return {
    listCategories: (params = {}) => listDiscoveryCategories(deps.db, params),
    projectors: [
      createProjector({
        projectorName: "discovery-category-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildDiscoveryCategoryProjectionHandlers(deps.db),
      }),
    ],
  };
}

