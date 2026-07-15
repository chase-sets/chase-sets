import { formatBpsPercent, formatDate, t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData } from "react-router";
import {
  AccountReputationSummary,
  Badge,
  Banner,
  Button,
  Container,
  Form,
  Grid,
  Heading,
  HiddenInput,
  LinkButton,
  ListingPurchasePanel,
  NativeSelect,
  PageSection,
  AccountTrustCard,
  ProductOptions,
  Stack,
  Text,
  Textarea,
  productOptionsFromSummary,
} from "@chase-sets/design-system";
import {
  appendAnonymousReportCookie,
  createMarketplaceRequestApiClient,
  ensureAnonymousReportId,
} from "@chase-sets/marketplace/server";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { defineFormAction, formActionRedirect } from "@chase-sets/platform-runtime/http";
import { useRealtimePatchedSnapshot } from "@chase-sets/platform-runtime/realtime-react";
import { createDiscoveryRequestApiClient, DiscoveryApiError } from "../support/request-support/api-client";
import type { DiscoveryPublicListing } from "../support/client-support/contracts";
import { applyDiscoveryPublicListingPatch } from "../support/client-support/realtime-market";
import { discoveryRealtimeRouteTopics } from "../support/realtime-support/topics";
import { useDiscoveryRealtimeRevalidation } from "../support/realtime-support/revalidation";
import { isProductionMarketplaceUrl, serializeJsonLd } from "../support/route-support/seo";
import { formatMoney } from "../support/ui-support/formatting";

function parseRating(value: string | null | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const rating = Number(value);
  return Number.isFinite(rating) ? rating : undefined;
}

function titleForListing(listing: { item_title: string | null }) {
  return listing.item_title ?? t("discovery.routes.publicListing.marketplace.listing");
}

function subtitleForListing(listing: { item_subtitle: string | null }) {
  return listing.item_subtitle ?? t("discovery.routes.publicListing.marketplace.listing");
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

/**
 * Buyer-facing "visible but unbuyable" messaging (m127): a seller can
 * be away (date disclosed, reason never) or at capacity (no date -- it
 * clears on its own once an open order slot frees up). Away takes display
 * priority when both apply, since it is the more definite state. Returns
 * `null` when the listing is fully purchasable.
 */
export function sellerUnbuyableMessage(
  listing: Pick<
    DiscoveryPublicListing,
    "seller_listing_availability_status" | "seller_available_again_at" | "seller_at_capacity"
  >,
): { title: string; description: string } | null {
  const isAway = (listing.seller_listing_availability_status ?? "available") === "unavailable";

  if (isAway) {
    return listing.seller_available_again_at
      ? {
          title: t("discovery.routes.publicListing.seller.away"),
          description: t("discovery.routes.publicListing.seller.away.until", {
            date: formatDate(listing.seller_available_again_at, { preset: "long" }),
          }),
        }
      : {
          title: t("discovery.routes.publicListing.seller.away"),
          description: t("discovery.routes.publicListing.seller.listings.unavailable"),
        };
  }

  if (listing.seller_at_capacity) {
    return {
      title: t("discovery.routes.publicListing.at.capacity"),
      description: t("discovery.routes.publicListing.at.capacity.description"),
    };
  }

  return null;
}

function purchaseLimitLabel(
  listing: Pick<DiscoveryPublicListing, "max_units_per_order" | "max_units_per_day" | "max_units_per_customer_account">,
) {
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
    availability: [availableQuantityLabel(listing.visible_quantity, listing.quantity_cap), purchaseLimitLabel(listing)]
      .filter(Boolean)
      .join(" | "),
    fulfillment: buyerFulfillmentLabel(listing.ship_from_code),
  });

  if (listing.item_subtitle) {
    params.set("itemSubtitle", listing.item_subtitle);
  }
  if (listing.product_summary) {
    params.set("productSummary", listing.product_summary);
  }

  return `/checkout/buy/readiness?${params.toString()}`;
}

type ProductJsonLd = Readonly<{
  "@context": "https://schema.org";
  "@type": "Product";
  name: string;
  description: string;
  image: string;
  sku: string;
  brand?: Readonly<{ "@type": "Brand"; name: string }>;
  gtin?: string;
  mpn?: string;
  category?: string;
  offers: Readonly<{
    "@type": "Offer";
    url: string;
    priceCurrency: string;
    price: string;
    availability: "https://schema.org/InStock" | "https://schema.org/OutOfStock";
    itemCondition: "https://schema.org/NewCondition" | "https://schema.org/UsedCondition";
    seller?: Readonly<{ "@type": "Organization"; name: string }>;
  }>;
}>;

export function buildPublicListingProductJsonLd(input: {
  listing: DiscoveryPublicListing;
  canonicalUrl: string | null;
}): ProductJsonLd | null {
  const payload = input.listing.google_shopping_structured_data_payload;
  if (
    !payload ||
    input.listing.status !== "active" ||
    (input.listing.seller_listing_availability_status ?? "available") !== "available" ||
    !input.canonicalUrl ||
    !isProductionMarketplaceUrl(input.canonicalUrl) ||
    payload.link !== input.canonicalUrl ||
    !isValidGoogleShoppingPayloadForJsonLd(payload)
  ) {
    return null;
  }

  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: payload.title,
    description: payload.description,
    image: payload.imageLink,
    sku: payload.offerId,
    ...(payload.brand ? { brand: { "@type": "Brand" as const, name: payload.brand } } : {}),
    ...(payload.gtin ? { gtin: payload.gtin } : {}),
    ...(payload.mpn ? { mpn: payload.mpn } : {}),
    ...(payload.productType ? { category: payload.productType } : {}),
    offers: {
      "@type": "Offer",
      url: payload.link,
      priceCurrency: payload.currencyCode,
      price: payload.priceAmount,
      availability:
        payload.availability === "in stock" ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
      itemCondition:
        payload.condition === "new" ? "https://schema.org/NewCondition" : "https://schema.org/UsedCondition",
      ...(input.listing.seller_display_name
        ? { seller: { "@type": "Organization" as const, name: input.listing.seller_display_name } }
        : {}),
    },
  };
}

export function serializePublicListingProductJsonLd(jsonLd: ProductJsonLd) {
  return serializeJsonLd(jsonLd);
}

function isValidGoogleShoppingPayloadForJsonLd(
  payload: DiscoveryPublicListing["google_shopping_structured_data_payload"],
) {
  return Boolean(
    payload?.offerId &&
    payload.title &&
    payload.description &&
    payload.link &&
    payload.imageLink &&
    payload.priceAmount &&
    payload.currencyCode &&
    (payload.availability === "in stock" || payload.availability === "out of stock") &&
    (payload.condition === "new" || payload.condition === "used"),
  );
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

export const action = defineFormAction({
  intents: {
    "report-listing": async ({ request, params, formData }) => {
      const listingId = String(formData.get("listingId") ?? "");
      const slug = params.listingSlug ?? "";
      if (!listingId || !slug) return formActionRedirect(null, `/listings/${slug}`);
      const anonymousReportId = ensureAnonymousReportId(request);
      await createMarketplaceRequestApiClient(request).reportListing(listingId, anonymousReportId, {
        reason: String(formData.get("reason") ?? "") as never,
        details: String(formData.get("details") ?? "") || null,
        sourceRoutePath: `/listings/${slug}`,
      });
      const headers = new Headers();
      appendAnonymousReportCookie(headers, anonymousReportId, request);
      return formActionRedirect(null, `/listings/${slug}?reported=1`, { headers });
    },
  },
  onUnknownIntent: ({ params }) => formActionRedirect(null, `/listings/${params.listingSlug ?? ""}`),
});

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
  ...(data?.canonicalUrl ? [{ tagName: "link", rel: "canonical", href: data.canonicalUrl }] : []),
];

export default function PublicListingRoute() {
  const data = useLoaderData<typeof loader>();

  return (
    <PublicListingRealtimeView
      key={[data.listing?.listing_id ?? "empty", data.listing?.updated_at ?? data.listing?.status ?? ""].join("\n")}
      data={data}
    />
  );
}

function PublicListingRealtimeView({ data }: { data: Awaited<ReturnType<typeof loader>> }) {
  const revalidateForRealtimeSync = useDiscoveryRealtimeRevalidation();
  const listing = useRealtimePatchedSnapshot({
    initialSnapshot: data.listing,
    snapshotKey: JSON.stringify(data.listing),
    topics: data.listing ? discoveryRealtimeRouteTopics.publicListing(data.listing.listing_id).topics : [],
    applyPatch: applyDiscoveryPublicListingPatch,
    onSyncRequired: revalidateForRealtimeSync,
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
  const accountHref = listing.seller_slug ? `/accounts/${listing.seller_slug}` : null;
  const availability = availableQuantityLabel(listing.visible_quantity, listing.quantity_cap);
  const sellerListingsAvailable = (listing.seller_listing_availability_status ?? "available") === "available";
  // Visible-but-unbuyable (m127): the listing itself renders normally
  // (it is not treated as "not found"), but purchase actions disable while
  // the seller is away or at capacity.
  const unbuyableMessage = sellerUnbuyableMessage(listing);
  const canPurchase = sellerListingsAvailable && !listing.seller_at_capacity;
  const availabilityCopy = canPurchase ? availability : (unbuyableMessage?.description ?? availability);
  const limitLabel = purchaseLimitLabel(listing);
  const fulfillment = buyerFulfillmentLabel(listing.ship_from_code);
  const sellerRating = parseRating(listing.seller_average_rating);
  const productJsonLd = buildPublicListingProductJsonLd({ listing, canonicalUrl: data.canonicalUrl });
  const reportReasonItems = [
    { value: "counterfeit-concern", label: t("discovery.routes.publicListing.report.reason.counterfeit") },
    { value: "stolen-photos", label: t("discovery.routes.publicListing.report.reason.stolenPhotos") },
    { value: "prohibited-item", label: t("discovery.routes.publicListing.report.reason.prohibited") },
    { value: "pricing-scam", label: t("discovery.routes.publicListing.report.reason.pricingScam") },
    { value: "other", label: t("discovery.routes.publicListing.report.reason.other") },
  ];

  return (
    <Container width="content">
      {productJsonLd ? (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: serializePublicListingProductJsonLd(productJsonLd) }}
        />
      ) : null}
      <Stack gap={6}>
        <Stack gap={3}>
          <Badge tone={listing.status === "active" && canPurchase ? "success" : "neutral"}>
            {canPurchase ? listing.status : t("discovery.routes.publicListing.unavailable")}
          </Badge>
          <Heading level={1}>{titleForListing(listing)}</Heading>
          <Text size="lg" tone="secondary">
            {subtitleForListing(listing)}
          </Text>
          {listing.product_summary ? (
            <ProductOptions options={productOptionsFromSummary(listing.product_summary)} variant="chips" />
          ) : (
            <Badge tone="neutral">{t("discovery.routes.publicListing.standard")}</Badge>
          )}
          <Text tone="secondary">
            {formatMoney(listing.price_amount)} from{" "}
            {listing.seller_display_name ?? t("discovery.routes.publicListing.seller")}
          </Text>
          {unbuyableMessage ? (
            <Banner tone="warning" title={unbuyableMessage.title} description={unbuyableMessage.description} />
          ) : null}
        </Stack>

        <Grid columns={{ base: 1, lg: 2 }} gap={4}>
          <Stack gap={4}>
            <ListingPurchasePanel
              title={t("discovery.routes.publicListing.ready.to.buy.this.listing")}
              price={formatMoney(listing.price_amount)}
              seller={listing.seller_display_name ?? t("discovery.routes.publicListing.seller")}
              trust={
                listing.status === "active" && canPurchase
                  ? t("discovery.routes.publicListing.verified.seller")
                  : t("discovery.routes.publicListing.seller.details.visible")
              }
              accountTrust={
                <Stack gap={1}>
                  <AccountReputationSummary
                    accountName={listing.seller_display_name ?? t("discovery.routes.publicListing.seller")}
                    href={accountHref ? `${accountHref}#feedback` : null}
                    averageRating={sellerRating}
                    reviewCount={listing.seller_review_count ?? 0}
                    align="end"
                  />
                  <Badge tone={listing.status === "active" && canPurchase ? "success" : "neutral"}>
                    {listing.status === "active" && canPurchase
                      ? t("discovery.routes.publicListing.verified.seller")
                      : t("discovery.routes.publicListing.seller.details.visible")}
                  </Badge>
                </Stack>
              }
              availability={availabilityCopy}
              fulfillment={fulfillment}
              policy={t("discovery.routes.publicListing.returns.reviewed.before.payment")}
              protection={t("discovery.routes.publicListing.buyer.protected")}
              reassurance={t("discovery.routes.publicListing.secure.checkout.reassurance")}
              primaryAction={
                canPurchase ? (
                  <LinkButton href={checkoutHref} size="lg" leadingIcon="lock">
                    {t("discovery.routes.publicListing.buy.this.listing")}
                  </LinkButton>
                ) : null
              }
              secondaryAction={
                <LinkButton href={itemMarketHref} tone="secondary">
                  {t("discovery.routes.publicListing.compare.market")}
                </LinkButton>
              }
            />
            {limitLabel ? <Badge tone="neutral">{limitLabel}</Badge> : null}
          </Stack>

          <Stack gap={4}>
            <AccountTrustCard
              name={listing.seller_display_name ?? t("discovery.routes.publicListing.seller")}
              verified={listing.status === "active" && canPurchase}
              rating={sellerRating}
              reviewCount={listing.seller_review_count ?? 0}
              completedSales={t("discovery.routes.publicListing.active.listing")}
              shipsFrom={fulfillment}
              policies={[
                {
                  label: t("discovery.routes.publicListing.availability"),
                  value: canPurchase && limitLabel ? `${availability} | ${limitLabel}` : availabilityCopy,
                },
                {
                  label: t("discovery.routes.publicListing.shipping.credit"),
                  value:
                    listing.shipping_allowance_percentage_bps > 0
                      ? formatBpsPercent(listing.shipping_allowance_percentage_bps)
                      : t("discovery.routes.publicListing.none"),
                },
                {
                  label: t("discovery.routes.publicListing.product"),
                  value: listing.product_summary ? (
                    <ProductOptions options={productOptionsFromSummary(listing.product_summary)} variant="chips" />
                  ) : (
                    <Badge tone="neutral">{t("discovery.routes.publicListing.standard")}</Badge>
                  ),
                },
              ]}
              actions={
                accountHref ? (
                  <LinkButton href={`${accountHref}#feedback`} tone="secondary">
                    {t("discovery.routes.publicListing.view.seller")}
                  </LinkButton>
                ) : null
              }
            />
            <PageSection title={t("discovery.routes.publicListing.report.title")}>
              <Form spacing="none" method="post">
                <HiddenInput type="hidden" name="intent" value="report-listing" readOnly />
                <HiddenInput type="hidden" name="listingId" value={listing.listing_id} readOnly />
                <NativeSelect
                  name="reason"
                  label={t("discovery.routes.publicListing.report.reason")}
                  items={reportReasonItems}
                  required
                />
                <Textarea
                  name="details"
                  label={t("discovery.routes.publicListing.report.details")}
                  rows={3}
                  maxLength={1000}
                />
                <Button type="submit" tone="secondary" leadingIcon="warning">
                  {t("discovery.routes.publicListing.report.submit")}
                </Button>
              </Form>
            </PageSection>
          </Stack>
        </Grid>
      </Stack>
    </Container>
  );
}
