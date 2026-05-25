import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { DiscoveryRuntimeDeps } from "../runtime-support";
import { buildDiscoveryMarketProjectionHandlers } from "./projection";
import {
  getDiscoveryPublicListingBySlug,
  getDiscoveryPublicAccountBySlug,
  listDiscoveryPublicSitemapUrls,
} from "./queries";

export type DiscoveryMarketServices = Readonly<{
  getPublicListingBySlug: (slug: string) => ReturnType<typeof getDiscoveryPublicListingBySlug>;
  getPublicAccountBySlug: (slug: string) => ReturnType<typeof getDiscoveryPublicAccountBySlug>;
  listPublicSitemapUrls: () => ReturnType<typeof listDiscoveryPublicSitemapUrls>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createDiscoveryMarketRuntime(deps: DiscoveryRuntimeDeps): DiscoveryMarketServices {
  return {
    getPublicListingBySlug: (slug) => getDiscoveryPublicListingBySlug(deps.db, slug),
    getPublicAccountBySlug: (slug) => getDiscoveryPublicAccountBySlug(deps.db, slug),
    listPublicSitemapUrls: () => listDiscoveryPublicSitemapUrls(deps.db),
    projectors: [
      createProjectionHandlerSet({
        projectionName: "discovery-market-projection",
        handlers: buildDiscoveryMarketProjectionHandlers(deps.db),
      }),
    ],
  };
}
