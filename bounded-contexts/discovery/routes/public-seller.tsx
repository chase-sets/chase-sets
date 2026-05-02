import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData } from "react-router";
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
import {
  createDiscoveryRequestApiClient,
  DiscoveryApiError,
} from "../support/request-support/api-client";
import { discoveryAssetUrls } from "../support/client-support/assets";

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
      ? `${data.seller.seller_display_name ?? "Seller"} | Marketplace`
      : "Seller Not Found | Marketplace",
    description: data?.seller
      ? `Browse ${data.seller.active_listing_count} active marketplace listings.`
      : "This marketplace seller is not available.",
  }),
  ...(data?.canonicalUrl
    ? [{ tagName: "link", rel: "canonical", href: data.canonicalUrl }]
    : []),
];

export default function PublicSellerRoute() {
  const data = useLoaderData<typeof loader>();
  const seller = data.seller;

  if (!seller) {
    return (
      <Container width="content">
        <PageSection title="Seller not found">
          <Text>This seller is not available right now.</Text>
        </PageSection>
      </Container>
    );
  }

  return (
    <Container width="expanded">
      <Stack gap={6}>
        <Stack gap={2}>
          <Heading level={1}>{seller.seller_display_name ?? "Seller"}</Heading>
          <Text size="lg" tone="secondary">
            {seller.active_listing_count} active listing
            {seller.active_listing_count === 1 ? "" : "s"}
          </Text>
        </Stack>

        {seller.listings.length > 0 ? (
          <Grid columns={{ base: 1, sm: 2, xl: 4 }} gap={4}>
            {seller.listings.map((listing) => (
              <MarketplaceProductCard
                key={listing.listing_id}
                href={`/listings/${listing.listing_slug}`}
                title={listing.item_title ?? "Marketplace listing"}
                subtitle={listing.item_subtitle ?? listing.product_summary}
                description={listing.product_summary ?? "Active marketplace listing"}
                fallbackImageSrc={discoveryAssetUrls.defaultProductImage}
                fallbackImageAlt="Pokemon card back"
                status="available"
                price={formatMoney(listing.price_amount)}
                meta={`${listing.quantity_cap} available`}
                actionLabel="View listing"
                categoryTags={[]}
                metadataTags={[]}
              />
            ))}
          </Grid>
        ) : (
          <EmptyState
            title="No active listings"
            description="This seller does not have active marketplace listings right now."
            icon="store"
            actions={<LinkButton href="/search">Browse marketplace</LinkButton>}
          />
        )}
      </Stack>
    </Container>
  );
}
