import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData } from "react-router";
import {
  Badge,
  Container,
  Grid,
  Heading,
  LinkButton,
  ListingCard,
  MarketplaceEmptyState,
  PageSection,
  Stack,
  Text,
} from "@chase-sets/design-system";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { buildBreadcrumbListJsonLd, serializeJsonLd } from "../support/route-support/seo";
import { createDiscoveryRequestApiClient, DiscoveryApiError } from "../support/request-support/api-client";
import type { DiscoveryBrowseSetPage } from "../support/request-support/api-client";
import { imageVariantSrcSet } from "../support/client-support/assets";
import { buildDiscoveryProductAssetImage } from "../support/client-support/product-assets";

function formatReleaseDate(value: string | null) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function browseAllHref(setPage: DiscoveryBrowseSetPage) {
  const params = new URLSearchParams({ [`reference.${setPage.type_key}`]: setPage.reference_record_id });
  return `/search?${params.toString()}`;
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const slug = params.setSlug;

  if (!slug) {
    return { setPage: null, notFound: true, canonicalUrl: null };
  }

  try {
    const setPage = await createDiscoveryRequestApiClient(request).getSetBySlug(slug);
    const url = new URL(request.url);

    if (setPage.slug && slug !== setPage.slug) {
      throw redirect(`/sets/${setPage.slug}${url.search}`, { status: 301 });
    }

    return {
      setPage,
      notFound: false,
      canonicalUrl: new URL(`/sets/${setPage.slug}`, url.origin).toString(),
    };
  } catch (error) {
    if (error instanceof DiscoveryApiError) {
      return { setPage: null, notFound: true, canonicalUrl: null };
    }

    throw error;
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  ...buildOpenGraphMeta({
    title: data?.setPage
      ? t("discovery.routes.set.card.list.meta.title", { name: data.setPage.name })
      : t("discovery.routes.set.set.not.found.marketplace"),
    description: data?.setPage
      ? t("discovery.routes.set.browse.card.list.description", {
          name: data.setPage.name,
          count: data.setPage.item_count,
        })
      : t("discovery.routes.set.this.set.is.not.available"),
  }),
  ...(data?.canonicalUrl ? [{ tagName: "link", rel: "canonical", href: data.canonicalUrl }] : []),
];

export default function DiscoverySetRoute() {
  const data = useLoaderData<typeof loader>();
  const setPage = data.setPage;

  if (!setPage) {
    return (
      <Container width="content">
        <PageSection title={t("discovery.routes.set.set.not.found")}>
          <Text>{t("discovery.routes.set.this.set.is.not.available.right")}</Text>
        </PageSection>
      </Container>
    );
  }

  const releaseDate = formatReleaseDate(setPage.release_date);
  const breadcrumbJsonLd = data.canonicalUrl
    ? buildBreadcrumbListJsonLd([
        { name: t("discovery.routes.set.marketplace"), url: new URL("/", data.canonicalUrl).toString() },
        { name: t("discovery.routes.set.browse"), url: new URL("/search", data.canonicalUrl).toString() },
        { name: setPage.name, url: data.canonicalUrl },
      ])
    : null;
  const hasMoreItems = setPage.item_count > setPage.items.length;

  return (
    <Container width="expanded">
      {breadcrumbJsonLd ? (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(breadcrumbJsonLd) }} />
      ) : null}
      <Stack gap={6}>
        <Stack gap={2}>
          {setPage.game ? <Badge tone="neutral">{setPage.game}</Badge> : null}
          <Heading level={1}>{setPage.name}</Heading>
          <Text tone="secondary">
            {[
              t("discovery.routes.set.cards.count", { count: setPage.item_count }),
              setPage.code ? t("discovery.routes.set.set.code", { code: setPage.code }) : null,
              releaseDate ? t("discovery.routes.set.released.on", { date: releaseDate }) : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>
        </Stack>

        {setPage.items.length === 0 ? (
          <MarketplaceEmptyState
            title={t("discovery.routes.set.no.cards.yet")}
            description={t("discovery.routes.set.this.set.does.not.have.any.cataloged.cards.yet")}
            recoveryActions={<LinkButton href="/search">{t("discovery.routes.set.browse.marketplace")}</LinkButton>}
          />
        ) : (
          <Stack gap={4}>
            <Grid columns={{ base: 1, lg: 2, "2xl": 3 }} gap={4}>
              {setPage.items.map((item) => {
                const href = `/items/${item.slug || item.catalog_item_id}`;
                const productAssetImage = buildDiscoveryProductAssetImage(
                  item.product_asset_sets,
                  "search-card",
                  "(min-width: 768px) 164px, 124px",
                );
                const imageSrc =
                  productAssetImage?.src ??
                  item.image_urls[0] ??
                  (item.image_fallback?.usage === "permanent" ? item.image_fallback.url : undefined);
                const lowestPrice = item.market_summary?.lowest_price_amount ?? null;

                return (
                  <ListingCard
                    key={item.catalog_item_id}
                    cardLayout="search-result"
                    href={href}
                    title={item.title}
                    subtitle={item.subtitle}
                    image={productAssetImage ?? undefined}
                    imageSrc={imageSrc}
                    imageSlot="compact-product"
                    imageAlt={item.title}
                    imageFallbackSrc={item.image_fallback?.url}
                    imageFallbackAlt={item.image_fallback?.alt ?? item.title}
                    imageFallbackSrcSet={imageVariantSrcSet(item.image_fallback, "card")}
                    imageFallbackSizes="(min-width: 768px) 164px, 124px"
                    imageFallbackMode={item.image_fallback?.usage ?? "permanent"}
                    price={lowestPrice ? `$${lowestPrice}` : undefined}
                    primaryAction={
                      <LinkButton href={href} size="sm">
                        {t("discovery.routes.set.view.card")}
                      </LinkButton>
                    }
                  />
                );
              })}
            </Grid>
            {hasMoreItems ? (
              <LinkButton href={browseAllHref(setPage)} tone="secondary">
                {t("discovery.routes.set.browse.all.cards.in.this.set", { count: setPage.item_count })}
              </LinkButton>
            ) : null}
          </Stack>
        )}
      </Stack>
    </Container>
  );
}
