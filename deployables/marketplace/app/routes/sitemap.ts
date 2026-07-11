import type { LoaderFunctionArgs } from "react-router";
import {
  createDiscoveryRequestApiClient,
  DISCOVERY_SITEMAP_ENTITY_KINDS,
  DISCOVERY_SITEMAP_PAGE_SIZE,
  type DiscoverySitemapEntityCounts,
} from "@chase-sets/discovery/server";
import { buildSitemapIndexXml, type SitemapIndexEntry } from "@chase-sets/platform-runtime/seo";

const EMPTY_SITEMAP_ENTITY_COUNTS: DiscoverySitemapEntityCounts = {
  items: 0,
  categories: 0,
  sellers: 0,
  listings: 0,
  sets: 0,
};

export async function loader({ request }: LoaderFunctionArgs) {
  const { origin } = new URL(request.url);
  const api = createDiscoveryRequestApiClient(request);
  const counts = await api.getSitemapEntityCounts().catch(() => EMPTY_SITEMAP_ENTITY_COUNTS);

  const childSitemaps: SitemapIndexEntry[] = [
    { path: "/sitemap/static/1.xml" },
    ...DISCOVERY_SITEMAP_ENTITY_KINDS.flatMap((kind) => {
      const entityCount = counts[kind] ?? 0;
      const pageCount = Math.ceil(entityCount / DISCOVERY_SITEMAP_PAGE_SIZE);

      return Array.from({ length: pageCount }, (_, index) => ({
        path: `/sitemap/${kind}/${index + 1}.xml`,
      }));
    }),
  ];

  const body = buildSitemapIndexXml(origin, childSitemaps);

  return new Response(body, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
    },
  });
}
