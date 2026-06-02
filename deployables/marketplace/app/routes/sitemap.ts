import type { LoaderFunctionArgs } from "react-router";
import { createDiscoveryRequestApiClient } from "@chase-sets/discovery/server";
import { requireMarketplaceProofAccess } from "../proof-access.server";

const STABLE_PUBLIC_PATHS = ["/", "/search"];

function escapeXml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function loader({ request }: LoaderFunctionArgs) {
  await requireMarketplaceProofAccess(request);

  const { origin } = new URL(request.url);
  const api = createDiscoveryRequestApiClient(request);
  const dynamicUrls = await api
    .listSitemapUrls()
    .then((result) => (Array.isArray(result.items) ? result.items : []))
    .catch(() => []);
  const staticUrls = STABLE_PUBLIC_PATHS.map((path) => ({ path, updated_at: null }));
  const urls = [...staticUrls, ...dynamicUrls]
    .map((entry) => {
      const loc = escapeXml(new URL(entry.path, origin).toString());
      const lastmod = entry.updated_at
        ? `<lastmod>${escapeXml(new Date(entry.updated_at).toISOString())}</lastmod>`
        : "";

      return `<url><loc>${loc}</loc>${lastmod}</url>`;
    })
    .join("");

  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    urls,
    "</urlset>",
  ].join("");

  return new Response(body, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
    },
  });
}
