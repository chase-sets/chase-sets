import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData } from "react-router";
import {
  BuyerProtectionModule,
  Container,
  Grid,
  ListingCard,
  LinkButton,
  MarketplaceEmptyState,
  SellerCredibilityHeader,
  PageSection,
  Stack,
  Text,
} from "@chase-sets/design-system";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { useRealtimePatchedSnapshot } from "@chase-sets/platform-runtime/realtime-react";
import {
  createDiscoveryRequestApiClient,
  DiscoveryApiError,
} from "../support/request-support/api-client";
import { discoveryAssetUrls } from "../support/client-support/assets";
import { applyDiscoveryPublicSellerPatch } from "../support/client-support/realtime-market";
import { discoveryRealtimeRouteTopics } from "../support/realtime-support/topics";

function formatMoney(value: string): string {
  return `$${value}`;
}

function buyerFulfillmentLabel(shipFromCode: string | null) {
  if (!shipFromCode) {
    return t("discovery.routes.publicSeller.fulfillment.confirmed.at.checkout");
  }

  const normalized = shipFromCode.toUpperCase();
  if (normalized.startsWith("STL")) {
    return t("discovery.routes.publicSeller.ships.from", {
      shipFrom: "St. Louis, MO",
    });
  }
  if (normalized.startsWith("CHI")) {
    return t("discovery.routes.publicSeller.ships.from", {
      shipFrom: "Chicago, IL",
    });
  }

  return t("discovery.routes.publicSeller.seller.fulfillment.center");
}

function purchaseLimitLabel(listing: {
  max_units_per_order?: number | null;
  max_units_per_day?: number | null;
  max_units_per_customer_account?: number | null;
}) {
  if (listing.max_units_per_customer_account) {
    return `Limit ${listing.max_units_per_customer_account} per customer`;
  }
  if (listing.max_units_per_day) {
    return `Limit ${listing.max_units_per_day} per day`;
  }
  if (listing.max_units_per_order) {
    return `Limit ${listing.max_units_per_order} per order`;
  }
  return null;
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

  return (
    <PublicSellerRealtimeView
      key={[
        data.seller?.account_id ?? "empty",
        data.seller?.active_listing_count ?? 0,
        data.seller?.listings.map((listing) => listing.listing_id).join("|") ?? "",
      ].join("\n")}
      data={data}
    />
  );
}

function PublicSellerRealtimeView({ data }: { data: Awaited<ReturnType<typeof loader>> }) {
  const seller = useRealtimePatchedSnapshot({
    initialSnapshot: data.seller,
    snapshotKey: JSON.stringify(data.seller),
    topics: data.seller
      ? discoveryRealtimeRouteTopics.publicSeller(data.seller.account_id).topics
      : [],
    applyPatch: applyDiscoveryPublicSellerPatch,
    onSyncRequired: reloadForRealtimeSync,
  });

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
        <SellerCredibilityHeader
          name={seller.seller_display_name ?? t("discovery.routes.publicSeller.seller.2")}
          verification={
            seller.status === "active"
              ? t("discovery.routes.publicSeller.verified.seller")
              : t("discovery.routes.publicSeller.building.trust")
          }
          summary={
            seller.active_listing_count > 0
              ? t("discovery.routes.publicSeller.verified.marketplace.seller.profile")
              : t("discovery.routes.publicSeller.new.seller.protected.checkout")
          }
          facts={[
            {
              label: t("discovery.routes.publicSeller.active.listings"),
              value: seller.active_listing_count,
            },
            {
              label: t("discovery.routes.publicSeller.review.history"),
              value: seller.active_listing_count > 0
                ? t("discovery.routes.publicSeller.reviews.visible.after.orders")
                : t("discovery.routes.publicSeller.new.seller"),
            },
            {
              label: t("discovery.routes.publicSeller.response.time"),
              value: t("discovery.routes.publicSeller.responds.through.order.updates"),
            },
            {
              label: t("discovery.routes.publicSeller.profile.updated"),
              value: new Intl.DateTimeFormat("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              }).format(new Date(seller.updated_at)),
            },
          ]}
          policies={[
            {
              label: t("discovery.routes.publicSeller.buyer.protection"),
              value: t("discovery.routes.publicSeller.buyer.protection.description"),
            },
            {
              label: t("discovery.routes.publicSeller.return.refund.policy"),
              value: t("discovery.routes.publicSeller.policies.confirmed.before.payment"),
            },
          ]}
          contactAction={
            <LinkButton href="/sign-in?returnTo=%2Faccount%2Fmessages" tone="secondary">
              {t("discovery.routes.publicSeller.sign.in.to.contact.seller")}
            </LinkButton>
          }
          reportAction={
            <LinkButton href="/support" tone="ghost">
              {t("discovery.routes.publicSeller.report.seller")}
            </LinkButton>
          }
        />

        <BuyerProtectionModule
          title={t("discovery.routes.publicSeller.buyer.confidence")}
          items={[
            {
              title: t("discovery.routes.publicSeller.verified.seller.status"),
              description: t("discovery.routes.publicSeller.verified.seller.status.description"),
            },
            {
              title: t("discovery.routes.publicSeller.clear.listing.details"),
              description: t("discovery.routes.publicSeller.clear.listing.details.description"),
            },
            {
              title: t("discovery.routes.publicSeller.secure.checkout"),
              description: t("discovery.routes.publicSeller.secure.checkout.description"),
            },
          ]}
        />

        {seller.listings.length > 0 ? (
          <Grid columns={{ base: 1, lg: 2 }} gap={4}>
            {seller.listings.map((listing) => {
              const availability = t("discovery.routes.publicSeller.quantity.available", {
                quantity: listing.quantity_cap,
              });
              const limitLabel = purchaseLimitLabel(listing);
              const availabilityDetail = limitLabel ? `${availability} | ${limitLabel}` : availability;
              return (
                <ListingCard
                  key={listing.listing_id}
                  title={listing.item_title ?? t("discovery.routes.publicSeller.marketplace.listing")}
                  imageSrc={discoveryAssetUrls.defaultProductImage}
                  imageAlt={listing.item_title ?? t("discovery.routes.publicSeller.pokemon.card.back")}
                  price={formatMoney(listing.price_amount)}
                  priceDetail={availabilityDetail}
                  sellerName={seller.seller_display_name ?? t("discovery.routes.publicSeller.seller.2")}
                  sellerTrustLabel={
                    seller.status === "active"
                      ? t("discovery.routes.publicSeller.verified.seller")
                      : t("discovery.routes.publicSeller.seller.details.visible")
                  }
                  sellerVerified={seller.status === "active"}
                  fulfillment={buyerFulfillmentLabel(listing.ship_from_code)}
                  availability={availabilityDetail}
                  condition={listing.product_summary ?? t("discovery.routes.publicSeller.standard.product")}
                  valueCue={t("discovery.routes.publicSeller.price.quantity.and.seller.visible")}
                  protection={t("discovery.routes.publicSeller.buyer.protected")}
                  primaryAction={
                    <LinkButton href={`/listings/${listing.listing_slug}`} size="sm">
                      {t("discovery.routes.publicSeller.view.listing")}
                    </LinkButton>
                  }
                  secondaryAction={
                    <LinkButton
                      href={`/items/${listing.catalog_item_slug ?? listing.catalog_catalog_item_id}`}
                      tone="secondary"
                      size="sm"
                    >
                      {t("discovery.routes.publicSeller.compare")}
                    </LinkButton>
                  }
                />
              );
            })}
          </Grid>
        ) : (
          <MarketplaceEmptyState
            title={t("discovery.routes.publicSeller.no.active.listings")}
            description={t("discovery.routes.publicSeller.this.seller.does.not.have.active")}
            recoveryActions={<LinkButton href="/search">{t("discovery.routes.publicSeller.browse.marketplace")}</LinkButton>}
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
