import type { LoaderFunctionArgs } from "react-router";
import { createDiscoveryRequestApiClient } from "@chase-sets/discovery/server";
import { buildSitemapXml } from "@chase-sets/platform-runtime/seo";

const STABLE_PUBLIC_PATHS = ["/", "/search"];

export async function loader({ request }: LoaderFunctionArgs) {
  const { origin } = new URL(request.url);
  const api = createDiscoveryRequestApiClient(request);
  const dynamicUrls = await api
    .listSitemapUrls()
    .then((result) => (Array.isArray(result.items) ? result.items : []))
    .catch(() => []);
  const staticUrls = STABLE_PUBLIC_PATHS.map((path) => ({ path, updated_at: null }));
  const body = buildSitemapXml(
    origin,
    [...staticUrls, ...dynamicUrls].map((entry) => ({
      path: entry.path,
      updatedAt: entry.updated_at,
    })),
  );

  return new Response(body, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
    },
  });
}
