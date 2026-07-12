import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { shouldIndexFromEnv } from "@chase-sets/platform-runtime/seo";
import { createPricingRequestApiClient } from "../../support/request-support/api-client";
import { MarketPriceHistoryPage } from "../../features/public-market-pages/ui/market-price-history-page";
import type { PublicMarketPageData } from "../../support/request-support/api-client";

/**
 * The public, SEO-facing market price-history page: `/market/:slug`
 * on public-web. Noindex is inherited from the SAME sitewide
 * `CHASE_SETS_PUBLIC_INDEXING` flag every other public-web route already
 * respects (deployables/public-web/app/root.tsx's `Layout` renders the
 * `<meta name="robots">` tag for every route unconditionally) -- this route
 * adds no separate per-page indexing knob, matching "noindex flag wired to
 * config" without inventing new machinery. Structured data additionally
 * gates on that same flag plus the production public-web hostname, mirroring
 * discovery's item-detail JSON-LD gate.
 */

const PUBLIC_WEB_PRODUCTION_HOSTNAME = "chasesets.com";
const MARKETPLACE_PRODUCTION_ORIGIN = "https://marketplace.chasesets.com";

function resolvePublicOrigin(request: Request) {
  return process.env.CHASE_SETS_PUBLIC_ORIGIN?.trim() || new URL(request.url).origin;
}

function resolveMarketplaceOrigin() {
  return process.env.CHASE_SETS_MARKETPLACE_ORIGIN?.trim() || MARKETPLACE_PRODUCTION_ORIGIN;
}

function isProductionPublicWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === PUBLIC_WEB_PRODUCTION_HOSTNAME;
  } catch {
    return false;
  }
}

function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const slug = params.slug?.trim();
  if (!slug) {
    throw new Response(t("pricing.features.publicMarketPages.routes.marketPriceHistory.not.found"), { status: 404 });
  }

  const api = createPricingRequestApiClient(request);
  const page = await api.getPublicMarketPage(slug);
  if (!page) {
    throw new Response(t("pricing.features.publicMarketPages.routes.marketPriceHistory.not.found"), { status: 404 });
  }

  const origin = resolvePublicOrigin(request);
  const canonicalUrl = new URL(`/market/${page.slug}`, `${origin}/`).toString();
  const marketplaceItemUrl = new URL(`/items/${page.slug}`, `${resolveMarketplaceOrigin()}/`).toString();
  const shouldIndex = shouldIndexFromEnv("CHASE_SETS_PUBLIC_INDEXING");

  return { page, canonicalUrl, marketplaceItemUrl, shouldIndex };
}

/**
 * Rollups refresh at most every few minutes (the market-rollups closer job)
 * and this page's own AC accepts freshness "within a day" -- a long shared
 * (CDN) cache with a short browser cache and a revalidation window keeps
 * this genuinely SSR + cacheable rather than a live query on every hit.
 *
 * `s-maxage=86400` matches the display policy's `publicPageCacheTtlSeconds`
 * compiled default (`../../features/market-rollups/domain/display-policy.ts`),
 * but stays a static literal here: React Router's `headers()` export
 * is synchronous and this codebase has no request-scoped async policy
 * resolution to thread a live revision through it. The underlying public
 * market-pages JSON API this page's loader calls
 * (`../../features/public-market-pages/api/route.ts`) DOES set its own
 * Cache-Control from the live-resolved policy -- that is the boundary a
 * revision actually reaches today. Forwarding it into this document-level
 * header is a known follow-up, not silently dropped.
 */
export function headers() {
  return {
    "Cache-Control": "public, max-age=60, s-maxage=86400, stale-while-revalidate=3600",
  };
}

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  const page = data?.page;
  const canonicalUrl = data?.canonicalUrl;
  if (!page || !canonicalUrl) {
    return [{ title: t("pricing.features.publicMarketPages.routes.marketPriceHistory.not.found") }];
  }

  const title = t("pricing.features.publicMarketPages.routes.marketPriceHistory.meta.title", { item: page.title });
  const description = t("pricing.features.publicMarketPages.routes.marketPriceHistory.meta.description", {
    item: page.title,
  });

  return [
    ...buildOpenGraphMeta({ title, description, type: "website" }),
    { property: "og:url", content: canonicalUrl },
  ];
};

function buildMarketPageProductJsonLd(input: {
  page: PublicMarketPageData;
  canonicalUrl: string;
  marketplaceItemUrl: string;
}) {
  const { page, canonicalUrl, marketplaceItemUrl } = input;
  const lowPrice = page.marketState?.minAskAmount ?? null;
  const offerCount = page.marketState?.activeListingCount ?? 0;

  if (!isProductionPublicWebUrl(canonicalUrl) || !lowPrice || offerCount <= 0) {
    return null;
  }

  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: page.title,
    ...(page.subtitle ? { description: page.subtitle } : {}),
    offers: {
      "@type": "AggregateOffer",
      url: marketplaceItemUrl,
      priceCurrency: "USD",
      lowPrice,
      offerCount,
      availability: "https://schema.org/InStock",
    },
  } as const;
}

export default function MarketPriceHistoryRoute() {
  const { page, marketplaceItemUrl, canonicalUrl, shouldIndex } = useLoaderData<typeof loader>();
  const productJsonLd =
    shouldIndex && canonicalUrl ? buildMarketPageProductJsonLd({ page, canonicalUrl, marketplaceItemUrl }) : null;

  return (
    <>
      {productJsonLd ? (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(productJsonLd) }} />
      ) : null}
      <MarketPriceHistoryPage page={page} marketplaceItemUrl={marketplaceItemUrl} />
    </>
  );
}
