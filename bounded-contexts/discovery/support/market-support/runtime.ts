import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { DiscoveryRuntimeDeps } from "../runtime-support";
import type { DiscoverySitemapEntityKind } from "../client-support/contracts";
import { buildDiscoveryMarketProjectionHandlers } from "./projection";
import {
  getDiscoveryPublicListingBySlug,
  getDiscoveryPublicAccountBySlug,
  countDiscoveryPublicSitemapEntities,
  listDiscoveryPublicSitemapEntityPage,
} from "./queries";

export type DiscoveryMarketServices = Readonly<{
  getPublicListingBySlug: (slug: string) => ReturnType<typeof getDiscoveryPublicListingBySlug>;
  getPublicAccountBySlug: (slug: string) => ReturnType<typeof getDiscoveryPublicAccountBySlug>;
  countPublicSitemapEntities: () => ReturnType<typeof countDiscoveryPublicSitemapEntities>;
  listPublicSitemapEntityPage: (
    kind: DiscoverySitemapEntityKind,
    page: number,
  ) => ReturnType<typeof listDiscoveryPublicSitemapEntityPage>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createDiscoveryMarketRuntime(deps: DiscoveryRuntimeDeps): DiscoveryMarketServices {
  return {
    getPublicListingBySlug: (slug) => getDiscoveryPublicListingBySlug(deps.db, slug),
    getPublicAccountBySlug: (slug) => getDiscoveryPublicAccountBySlug(deps.db, slug),
    countPublicSitemapEntities: () => countDiscoveryPublicSitemapEntities(deps.db),
    listPublicSitemapEntityPage: (kind, page) => listDiscoveryPublicSitemapEntityPage(deps.db, kind, page),
    projectors: [
      createProjectionHandlerSet({
        projectionName: "discovery-market-projection",
        handlers: buildDiscoveryMarketProjectionHandlers(deps.db),
      }),
    ],
  };
}
