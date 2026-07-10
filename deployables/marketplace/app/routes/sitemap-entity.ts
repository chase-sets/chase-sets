import type { LoaderFunctionArgs } from "react-router";
import {
  createDiscoveryRequestApiClient,
  DISCOVERY_SITEMAP_ENTITY_KINDS,
  type DiscoverySitemapEntityKind,
} from "@chase-sets/discovery/server";
import { buildSitemapXml } from "@chase-sets/platform-runtime/seo";

const STATIC_SITEMAP_PATHS = ["/", "/search"];

function isDiscoverySitemapEntityKind(value: string): value is DiscoverySitemapEntityKind {
  return (DISCOVERY_SITEMAP_ENTITY_KINDS as readonly string[]).includes(value);
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { origin } = new URL(request.url);
  const kind = params.kind ?? "";
  const page = Number(params.page);

  if (!Number.isInteger(page) || page < 1) {
    return new Response("Not Found", { status: 404 });
  }

  if (kind === "static") {
    if (page !== 1) {
      return new Response("Not Found", { status: 404 });
    }

    const body = buildSitemapXml(
      origin,
      STATIC_SITEMAP_PATHS.map((path) => ({ path })),
    );

    return new Response(body, {
      headers: { "Content-Type": "application/xml; charset=utf-8" },
    });
  }

  if (!isDiscoverySitemapEntityKind(kind)) {
    return new Response("Not Found", { status: 404 });
  }

  const api = createDiscoveryRequestApiClient(request);
  const result = await api
    .listSitemapEntityPage(kind, page)
    .catch(() => ({ items: [] as { path: string; updated_at: string }[] }));

  const body = buildSitemapXml(
    origin,
    result.items.map((entry) => ({ path: entry.path, updatedAt: entry.updated_at })),
  );

  return new Response(body, {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
}
