import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import type { DiscoveryRuntimeDeps } from "../runtime-support";
import { buildDiscoveryMarketProjectionHandlers } from "./projection";
import {
  getDiscoveryPublicListingBySlug,
  getDiscoveryPublicAccountBySlug,
  listDiscoveryPublicSitemapUrls,
} from "./queries";

export type DiscoveryMarketServices = Readonly<{
  getPublicListingBySlug: (
    slug: string,
  ) => ReturnType<typeof getDiscoveryPublicListingBySlug>;
  getPublicAccountBySlug: (
    slug: string,
  ) => ReturnType<typeof getDiscoveryPublicAccountBySlug>;
  listPublicSitemapUrls: () => ReturnType<typeof listDiscoveryPublicSitemapUrls>;
  projectors: readonly Projector[];
}>;

export function createDiscoveryMarketRuntime(
  deps: DiscoveryRuntimeDeps,
): DiscoveryMarketServices {
  return {
    getPublicListingBySlug: (slug) => getDiscoveryPublicListingBySlug(deps.db, slug),
    getPublicAccountBySlug: (slug) => getDiscoveryPublicAccountBySlug(deps.db, slug),
    listPublicSitemapUrls: () => listDiscoveryPublicSitemapUrls(deps.db),
    projectors: [
      createProjector({
        projectorName: "discovery-market-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildDiscoveryMarketProjectionHandlers(deps.db),
      }),
    ],
  };
}
