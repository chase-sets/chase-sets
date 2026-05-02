import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData } from "react-router";
import { useEffect, useState } from "react";
import {
  Container,
  EmptyState,
  Grid,
  Heading,
  LinkButton,
  MarketplaceProductCard,
  PageSection,
  Stack,
  Text,
} from "@chase-sets/design-system";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { subscribeRealtimePatches } from "@chase-sets/platform-runtime/realtime-web";
import {
  createDiscoveryRequestApiClient,
  DiscoveryApiError,
} from "../support/request-support/api-client";
import { discoveryAssetUrls } from "../support/client-support/assets";
import { applyDiscoveryPublicSellerPatch } from "../support/client-support/realtime-market";
import { discoveryRealtimeTopics } from "../support/realtime-support/topics";

function formatMoney(value: string): string {
  return `$${value}`;
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const slug = params.sellerSlug;

  if (!slug) {
    return { seller: null, notFound: true, canonicalUrl: null };
  }

  try {
    const seller = await createDiscoveryRequestApiClient(request).getPublicSellerBySlug(slug);
    const url = new URL(request.url);

    if (seller.seller_slug && slug !== seller.seller_slug) {
      throw redirect(`/sellers/${seller.seller_slug}${url.search}`, { status: 301 });
    }

    return {
      seller,
      notFound: false,
      canonicalUrl: new URL(`/sellers/${seller.seller_slug}`, url.origin).toString(),
    };
  } catch (error) {
    if (error instanceof DiscoveryApiError) {
      return { seller: null, notFound: true, canonicalUrl: null };
    }

    throw error;
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  ...buildOpenGraphMeta({
    title: data?.seller
      ? t("discovery.routes.publicSeller.seller.meta.title", {
          sellerName: data.seller.seller_display_name ?? t("discovery.routes.publicSeller.seller"),
        })
      : t("discovery.routes.publicSeller.seller.not.found.marketplace"),
    description: data?.seller
      ? t("discovery.routes.publicSeller.browse.active.listings", {
          count: data.seller.active_listing_count,
        })
      : t("discovery.routes.publicSeller.this.marketplace.seller.is.not.available"),
  }),
  ...(data?.canonicalUrl
    ? [{ tagName: "link", rel: "canonical", href: data.canonicalUrl }]
    : []),
];

export default function PublicSellerRoute() {
  const data = useLoaderData<typeof loader>();
  const [seller, setSeller] = useState(data.seller);

  useEffect(() => {
    setSeller(data.seller);
  }, [data.seller]);

  useEffect(() => {
    if (!data.seller) {
      return;
    }

    const subscription = subscribeRealtimePatches({
      topics: [
        discoveryRealtimeTopics.publicMarket(),
        discoveryRealtimeTopics.seller(data.seller.account_id),
      ],
      onPatch: (patch) => {
        setSeller((current) => applyDiscoveryPublicSellerPatch(current, patch));
      },
      onSyncRequired: reloadForRealtimeSync,
    });

    return () => subscription.close();
  }, [data.seller?.account_id]);

  if (!seller) {
    return (
      <Container width="content">
        <PageSection title={t("discovery.routes.publicSeller.seller.not.found")}>
          <Text>{t("discovery.routes.publicSeller.this.seller.is.not.available.right")}</Text>
        </PageSection>
      </Container>
    );
  }

  return (
    <Container width="expanded">
      <Stack gap={6}>
        <Stack gap={2}>
          <Heading level={1}>{seller.seller_display_name ?? t("discovery.routes.publicSeller.seller.2")}</Heading>
          <Text size="lg" tone="secondary">
            {t("discovery.routes.publicSeller.active.listing.count", {
              count: seller.active_listing_count,
              listingLabel: t(
                seller.active_listing_count === 1
                  ? "discovery.routes.publicSeller.listing.singular"
                  : "discovery.routes.publicSeller.listing.plural",
              ),
            })}
          </Text>
        </Stack>

        {seller.listings.length > 0 ? (
          <Grid columns={{ base: 1, sm: 2, xl: 4 }} gap={4}>
            {seller.listings.map((listing) => (
              <MarketplaceProductCard
                key={listing.listing_id}
                href={`/listings/${listing.listing_slug}`}
                title={listing.item_title ?? t("discovery.routes.publicSeller.marketplace.listing")}
                subtitle={listing.item_subtitle ?? listing.product_summary}
                description={listing.product_summary ?? t("discovery.routes.publicSeller.active.marketplace.listing")}
                fallbackImageSrc={discoveryAssetUrls.defaultProductImage}
                fallbackImageAlt={t("discovery.routes.publicSeller.pokemon.card.back")}
                status="available"
                price={formatMoney(listing.price_amount)}
                meta={t("discovery.routes.publicSeller.quantity.available", {
                  quantity: listing.quantity_cap,
                })}
                actionLabel={t("discovery.routes.publicSeller.view.listing")}
                categoryTags={[]}
                metadataTags={[]}
              />
            ))}
          </Grid>
        ) : (
          <EmptyState
            title={t("discovery.routes.publicSeller.no.active.listings")}
            description={t("discovery.routes.publicSeller.this.seller.does.not.have.active")}
            icon="store"
            actions={<LinkButton href="/search">{t("discovery.routes.publicSeller.browse.marketplace")}</LinkButton>}
          />
        )}
      </Stack>
    </Container>
  );
}

function reloadForRealtimeSync() {
  if (typeof window !== "undefined") {
    window.location.reload();
  }
}
