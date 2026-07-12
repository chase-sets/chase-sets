import type { LoaderFunctionArgs } from "react-router";
import { buildSitemapXml } from "@chase-sets/platform-runtime/seo";
import { createPricingRequestApiClient } from "@chase-sets/pricing/server";
import { resolvePublicOrigin, shouldIndexPublicWeb } from "../seo";

const STABLE_PUBLIC_PATHS = [
  "/",
  "/faq",
  "/contact",
  "/terms",
  "/privacy",
  "/refunds-and-returns",
  "/order-protection",
  "/sales-fees",
  "/founders",
];

/**
 * Public market page sitemap entries. Only included once public-web
 * indexing is enabled -- listing not-yet-indexable pages in a sitemap
 * defeats the noindex posture -- and swallowed on error so a pricing-side
 * hiccup never takes the sitemap route down.
 */
async function loadMarketPagePaths(request: Request) {
  try {
    const { items } = await createPricingRequestApiClient(request).listPublicMarketPageSlugs();
    return items.map((entry) => `/market/${entry.slug}`);
  } catch {
    return [];
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  const origin = resolvePublicOrigin();
  const marketPagePaths = shouldIndexPublicWeb() ? await loadMarketPagePaths(request) : [];
  const body = buildSitemapXml(
    origin,
    [...STABLE_PUBLIC_PATHS, ...marketPagePaths].map((path) => ({ path })),
  );

  return new Response(body, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
    },
  });
}
