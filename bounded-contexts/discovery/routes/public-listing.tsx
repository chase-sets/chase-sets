import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData } from "react-router";
import {
  Badge,
  Container,
  Grid,
  Heading,
  LinkButton,
  ListingPurchasePanel,
  PageSection,
  ProductSelectionSummary,
  SellerTrustCard,
  Stack,
  Text,
} from "@chase-sets/design-system";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { useRealtimePatchedSnapshot } from "@chase-sets/platform-runtime/realtime-react";
import {
  createDiscoveryRequestApiClient,
  DiscoveryApiError,
} from "../support/request-support/api-client";
import type { DiscoveryPublicListing } from "../support/client-support/contracts";
import { applyDiscoveryPublicListingPatch } from "../support/client-support/realtime-market";
import { discoveryRealtimeRouteTopics } from "../support/realtime-support/topics";

function formatMoney(value: string): string {
  return `$${value}`;
}

function titleForListing(listing: {
  item_title: string | null;
}) {
  return listing.item_title ?? t("discovery.routes.publicListing.marketplace.listing");
}

function subtitleForListing(listing: { item_subtitle: string | null }) {
  return listing.item_subtitle ?? t("discovery.routes.publicListing.marketplace.listing");
}

function productSelectionDetails(productSummary: string | null) {
  return String(productSummary ?? "")
    .split("|")
    .map((part) => {
      const [label, ...valueParts] = part.split(":");
      const value = valueParts.join(":").trim();

      return label?.trim() && value
        ? { label: label.trim(), value }
        : null;
    })
    .filter((part): part is { label: string; value: string } => part !== null);
}

function buyerFulfillmentLabel(shipFromCode: string | null) {
  if (!shipFromCode) {
    return t("discovery.routes.publicListing.fulfillment.confirmed.at.checkout");
  }

  const normalized = shipFromCode.toUpperCase();
  if (normalized.startsWith("STL")) {
    return t("discovery.routes.publicListing.ships.from.location", {
      location: "St. Louis, MO",
    });
  }
  if (normalized.startsWith("CHI")) {
    return t("discovery.routes.publicListing.ships.from.location", {
      location: "Chicago, IL",
    });
  }

  return t("discovery.routes.publicListing.seller.fulfillment.center");
}

function availableQuantityLabel(visibleQuantity: number | null, quantityCap: number) {
  const quantity = Number(visibleQuantity ?? quantityCap);
  return t("discovery.routes.publicListing.available.quantity", {
    quantity: Number.isFinite(quantity) ? quantity.toLocaleString() : quantityCap,
  });
}

function checkoutStartHref(listing: DiscoveryPublicListing) {
  const params = new URLSearchParams({
    source: "buy-now",
    listingId: listing.listing_id,
    fulfillmentMode: "locked-listing",
    lockedListingId: listing.listing_id,
    catalogItemId: listing.catalog_catalog_item_id,
    productId: listing.product_id,
    itemTitle: listing.item_title ?? t("discovery.routes.publicListing.marketplace.listing"),
    quantity: "1",
    selectedOptions: JSON.stringify(listing.selected_options ?? []),
    priceAmount: listing.price_amount,
    sellerName: listing.seller_display_name ?? t("discovery.routes.publicListing.seller"),
    availability: availableQuantityLabel(listing.visible_quantity, listing.quantity_cap),
    fulfillment: buyerFulfillmentLabel(listing.ship_from_code),
  });

  if (listing.item_subtitle) {
    params.set("itemSubtitle", listing.item_subtitle);
  }
  if (listing.product_summary) {
    params.set("productSummary", listing.product_summary);
  }

  return `/checkout/start?${params.toString()}`;
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const slug = params.listingSlug;

  if (!slug) {
    return { listing: null, notFound: true, canonicalUrl: null };
  }

  try {
    const listing = await createDiscoveryRequestApiClient(request).getPublicListingBySlug(slug);
    const url = new URL(request.url);

    if (listing.listing_slug && slug !== listing.listing_slug) {
      throw redirect(`/listings/${listing.listing_slug}${url.search}`, { status: 301 });
    }

    return {
      listing,
      notFound: false,
      canonicalUrl: new URL(`/listings/${listing.listing_slug}`, url.origin).toString(),
    };
  } catch (error) {
    if (error instanceof DiscoveryApiError) {
      return { listing: null, notFound: true, canonicalUrl: null };
    }

    throw error;
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  ...buildOpenGraphMeta({
    title: data?.listing
      ? `${titleForListing(data.listing)} | Marketplace`
      : t("discovery.routes.publicListing.listing.not.found.marketplace"),
    description: data?.listing
      ? `${formatMoney(data.listing.price_amount)} from ${data.listing.seller_display_name ?? t("discovery.routes.publicListing.a.marketplace.seller")}.`
      : t("discovery.routes.publicListing.this.marketplace.listing.is.not.available"),
    type: "product",
  }),
  ...(data?.canonicalUrl
    ? [{ tagName: "link", rel: "canonical", href: data.canonicalUrl }]
    : []),
];

export default function PublicListingRoute() {
  const data = useLoaderData<typeof loader>();

  return (
    <PublicListingRealtimeView
      key={[
        data.listing?.listing_id ?? "empty",
        data.listing?.updated_at ?? data.listing?.status ?? "",
      ].join("\n")}
      data={data}
    />
  );
}

function PublicListingRealtimeView({ data }: { data: Awaited<ReturnType<typeof loader>> }) {
  const listing = useRealtimePatchedSnapshot({
    initialSnapshot: data.listing,
    snapshotKey: JSON.stringify(data.listing),
    topics: data.listing
      ? discoveryRealtimeRouteTopics.publicListing(data.listing.listing_id).topics
      : [],
    applyPatch: applyDiscoveryPublicListingPatch,
    onSyncRequired: reloadForRealtimeSync,
  });

  if (!listing) {
    return (
      <Container width="content">
        <PageSection title={t("discovery.routes.publicListing.listing.not.found")}>
          <Text>{t("discovery.routes.publicListing.this.listing.is.not.available.right")}</Text>
        </PageSection>
      </Container>
    );
  }

  const checkoutHref = checkoutStartHref(listing);
  const itemMarketHref = `/items/${listing.catalog_item_slug ?? listing.catalog_catalog_item_id}`;
  const sellerHref = listing.seller_slug ? `/sellers/${listing.seller_slug}` : null;
  const productDetails = productSelectionDetails(listing.product_summary);
  const availability = availableQuantityLabel(listing.visible_quantity, listing.quantity_cap);
  const fulfillment = buyerFulfillmentLabel(listing.ship_from_code);

  return (
    <Container width="content">
      <Stack gap={6}>
        <Stack gap={3}>
          <Badge tone={listing.status === "active" ? "success" : "neutral"}>
            {listing.status}
          </Badge>
          <Heading level={1}>{titleForListing(listing)}</Heading>
          <Text size="lg" tone="secondary">
            {subtitleForListing(listing)}
          </Text>
          <ProductSelectionSummary
            selections={productDetails}
            summary={listing.product_summary ?? t("discovery.routes.publicListing.standard")}
            summaryAsChip
          />
          <Text tone="secondary">
            {formatMoney(listing.price_amount)} from{" "}
            {listing.seller_display_name ?? t("discovery.routes.publicListing.seller")}
          </Text>
        </Stack>

        <Grid columns={{ base: 1, lg: 2 }} gap={4}>
          <Stack gap={4}>
            <ListingPurchasePanel
              title={t("discovery.routes.publicListing.ready.to.buy.this.listing")}
              price={formatMoney(listing.price_amount)}
              seller={listing.seller_display_name ?? t("discovery.routes.publicListing.seller")}
              trust={
                listing.status === "active"
                  ? t("discovery.routes.publicListing.verified.seller")
                  : t("discovery.routes.publicListing.seller.details.visible")
              }
              availability={availability}
              fulfillment={fulfillment}
              policy={t("discovery.routes.publicListing.returns.reviewed.before.payment")}
              protection={t("discovery.routes.publicListing.buyer.protected")}
              reassurance={t("discovery.routes.publicListing.secure.checkout.reassurance")}
              primaryAction={
                <LinkButton href={checkoutHref} size="lg" leadingIcon="lock">
                  {t("discovery.routes.publicListing.buy.this.listing")}
                </LinkButton>
              }
              secondaryAction={
                <LinkButton href={itemMarketHref} tone="secondary">
                  {t("discovery.routes.publicListing.compare.market")}
                </LinkButton>
              }
            />
          </Stack>

          <Stack gap={4}>
            <SellerTrustCard
              name={listing.seller_display_name ?? t("discovery.routes.publicListing.seller")}
              verified={listing.status === "active"}
              completedSales={t("discovery.routes.publicListing.active.listing")}
              shipsFrom={fulfillment}
              policies={[
                {
                  label: t("discovery.routes.publicListing.availability"),
                  value: availability,
                },
                {
                  label: t("discovery.routes.publicListing.shipping.credit"),
                  value: listing.shipping_allowance_percentage_bps > 0
                    ? `${listing.shipping_allowance_percentage_bps / 100}%`
                    : t("discovery.routes.publicListing.none"),
                },
                {
                  label: t("discovery.routes.publicListing.product"),
                  value: (
                    <ProductSelectionSummary
                      selections={productDetails}
                      summary={listing.product_summary ?? t("discovery.routes.publicListing.standard")}
                      summaryAsChip
                    />
                  ),
                },
              ]}
              actions={
                listing.seller_slug ? (
                  <LinkButton href={`/sellers/${listing.seller_slug}`} tone="secondary">
                    {t("discovery.routes.publicListing.view.seller")}
                  </LinkButton>
                ) : null
              }
            />
          </Stack>
        </Grid>
      </Stack>
    </Container>
  );
}

function reloadForRealtimeSync() {
  if (typeof window !== "undefined") {
    window.location.reload();
  }
}
