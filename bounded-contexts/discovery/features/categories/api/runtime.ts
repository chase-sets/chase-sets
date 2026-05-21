import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import type { DiscoveryRuntimeDeps } from "../../../support/runtime-support";
import { getDiscoveryCategoryBySlug, listDiscoveryCategories, type DiscoveryCategoryRow } from "../read-model/queries";
import { buildDiscoveryCategoryProjectionHandlers } from "../read-model/projection";

export type DiscoveryCategoryServices = Readonly<{
  listCategories: (params?: { parentCategoryId?: string; status?: string }) => Promise<DiscoveryCategoryRow[]>;
  getCategoryBySlug: (slug: string) => Promise<DiscoveryCategoryRow | null>;
  projectors: readonly Projector[];
}>;

export function createDiscoveryCategoryRuntime(deps: DiscoveryRuntimeDeps): DiscoveryCategoryServices {
  return {
    listCategories: (params = {}) => listDiscoveryCategories(deps.db, params),
    getCategoryBySlug: (slug) => getDiscoveryCategoryBySlug(deps.db, slug),
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
