import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData } from "react-router";
import {
  Badge,
  Card,
  Container,
  Grid,
  Heading,
  Inline,
  LinkButton,
  PageSection,
  Stack,
  Text,
} from "@chase-sets/design-system";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import {
  createDiscoveryRequestApiClient,
  DiscoveryApiError,
} from "../support/request-support/api-client";

function formatMoney(value: string): string {
  return `$${value}`;
}

function titleForListing(listing: {
  item_title: string | null;
  item_subtitle: string | null;
  product_summary: string | null;
}) {
  return [
    listing.item_title ?? t("discovery.routes.publicListing.marketplace.listing"),
    listing.item_subtitle,
    listing.product_summary,
  ].filter(Boolean).join(" - ");
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
  const listing = data.listing;

  if (!listing) {
    return (
      <Container width="content">
        <PageSection title={t("discovery.routes.publicListing.listing.not.found")}>
          <Text>{t("discovery.routes.publicListing.this.listing.is.not.available.right")}</Text>
        </PageSection>
      </Container>
    );
  }

  return (
    <Container width="content">
      <Stack gap={6}>
        <Stack gap={3}>
          <Inline gap={2}>
            <Badge tone={listing.status === "active" ? "success" : "neutral"}>
              {listing.status}
            </Badge>
          </Inline>
          <Heading level={1}>{titleForListing(listing)}</Heading>
          <Text size="lg" tone="secondary">
            {formatMoney(listing.price_amount)} from{" "}
            {listing.seller_display_name ?? t("discovery.routes.publicListing.seller")}
          </Text>
        </Stack>

        <Grid columns={{ base: 1, md: 3 }} gap={4}>
          <Card>
            <Stack gap={1}>
              <Text size="sm" tone="secondary">{t("discovery.routes.publicListing.available")}</Text>
              <Text weight="semibold">{listing.quantity_cap}</Text>
            </Stack>
          </Card>
          <Card>
            <Stack gap={1}>
              <Text size="sm" tone="secondary">{t("discovery.routes.publicListing.product")}</Text>
              <Text weight="semibold">{listing.product_summary ?? t("discovery.routes.publicListing.standard")}</Text>
            </Stack>
          </Card>
          <Card>
            <Stack gap={1}>
              <Text size="sm" tone="secondary">{t("discovery.routes.publicListing.ships.from")}</Text>
              <Text weight="semibold">{listing.ship_from_code ?? t("discovery.routes.publicListing.seller.location")}</Text>
            </Stack>
          </Card>
        </Grid>

        <Inline gap={2}>
          <LinkButton href={`/items/${listing.catalog_item_slug ?? listing.catalog_catalog_item_id}`}>
            {t("discovery.routes.publicListing.view.item.market")}</LinkButton>
          {listing.seller_slug ? (
            <LinkButton href={`/sellers/${listing.seller_slug}`} tone="secondary">
              {t("discovery.routes.publicListing.view.seller")}</LinkButton>
          ) : null}
        </Inline>
      </Stack>
    </Container>
  );
}
