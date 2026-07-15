import { t } from "@chase-sets/localization";
import type { MetaFunction } from "react-router";
import { useActionData, useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { useRealtimePatchedSnapshot } from "@chase-sets/platform-runtime/realtime-react";
import { applyDiscoveryItemPatch } from "../support/client-support/realtime-market";
import { discoveryRealtimeRouteTopics } from "../support/realtime-support/topics";
import { useDiscoveryRealtimeRevalidation } from "../support/realtime-support/revalidation";
import { discoveryAssetUrls } from "../support/client-support/assets";
import type { DiscoveryItemDetail } from "../support/client-support/contracts";
import { ItemDetailPage } from "../features/item-detail/ui/item-detail-page";
import { getActionErrorMessage } from "../features/item-detail/ui/commerce-sections";
import {
  EMPTY_ITEM_DETAIL_RESULT,
  MARKETPLACE_DESCRIPTION,
  selectItemImageUrl,
} from "../support/route-support/item-detail/support";
import { loader } from "../support/route-support/item-detail/loader";
import { buildItemDetailCommerce } from "../support/route-support/item-detail/commerce";
import type {
  DiscoveryItemDetailActionData,
  DiscoveryItemDetailRouteData,
} from "../support/route-support/item-detail/types";
import { buildBreadcrumbListJsonLd, isProductionMarketplaceUrl, serializeJsonLd } from "../support/route-support/seo";

type ItemDetailProductJsonLd = Readonly<{
  "@context": "https://schema.org";
  "@type": "Product";
  name: string;
  description: string;
  image: string;
  sku: string;
  category?: string;
  offers: Readonly<{
    "@type": "AggregateOffer";
    url: string;
    priceCurrency: string;
    lowPrice: string;
    offerCount: number;
    availability: "https://schema.org/InStock" | "https://schema.org/OutOfStock";
  }>;
}>;

export function buildItemDetailProductJsonLd(input: {
  item: DiscoveryItemDetail;
  canonicalUrl: string | null;
}): ItemDetailProductJsonLd | null {
  const { item, canonicalUrl } = input;
  const description = item.description?.trim();
  const image = selectItemImageUrl(item, "catalog-detail");
  const lowestPrice = item.market_summary?.lowest_price_amount ?? null;
  const offerCount = item.market_summary?.active_listing_count ?? 0;

  if (
    item.status !== "active" ||
    !description ||
    !image ||
    !canonicalUrl ||
    !isProductionMarketplaceUrl(canonicalUrl) ||
    !lowestPrice ||
    offerCount <= 0
  ) {
    return null;
  }

  const category = item.categories[0]?.name;

  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: item.title,
    description,
    image,
    sku: item.catalog_item_id,
    ...(category ? { category } : {}),
    offers: {
      "@type": "AggregateOffer",
      url: canonicalUrl,
      priceCurrency: "USD",
      lowPrice: lowestPrice,
      offerCount,
      availability:
        (item.market_summary?.total_visible_quantity ?? 0) > 0
          ? "https://schema.org/InStock"
          : "https://schema.org/OutOfStock",
    },
  };
}

export function buildItemDetailBreadcrumbListJsonLd(input: {
  item: Pick<DiscoveryItemDetail, "title" | "categories">;
  canonicalUrl: string | null;
}) {
  const { item, canonicalUrl } = input;

  if (!canonicalUrl || !isProductionMarketplaceUrl(canonicalUrl)) {
    return null;
  }

  const origin = new URL(canonicalUrl).origin;
  const category = item.categories[0] ?? null;

  return buildBreadcrumbListJsonLd([
    { name: t("discovery.features.itemDetail.ui.itemDetailPage.home"), url: `${origin}/` },
    ...(category ? [{ name: category.name, url: `${origin}/categories/${category.slug}` }] : []),
    { name: item.title, url: canonicalUrl },
  ]);
}

export {
  BuyActionCard,
  CheckoutPurchaseIntentSection,
  ItemCommercePanel,
  MarketplaceListingSubmissionSection,
  MarketplaceOfferMatchSection,
  MarketplaceOfferSubmissionSection,
  MarketplaceSellerRegistrationSection,
  ProductAlertCreationSection,
  ProductSellListIntentSection,
  SellActionCard,
  WatchActionCard,
} from "../features/item-detail/ui/commerce-sections";
export type { AddToCartActionData, CommerceAccordionEdge } from "../features/item-detail/ui/commerce-sections";
export { loader } from "../support/route-support/item-detail/loader";
export { action } from "../support/route-support/item-detail/action";
export {
  readExplicitMarketSelectionId,
  readInitialSelectedOptions,
} from "../support/route-support/item-detail/support";

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  ...buildOpenGraphMeta({
    title: data?.item
      ? t("discovery.routes.itemDetail.meta.title", { title: data.item.title })
      : t("discovery.routes.itemDetail.item.not.found.marketplace"),
    description: data?.item?.description ? data.item.description : MARKETPLACE_DESCRIPTION,
    imageUrl: data?.item
      ? (selectItemImageUrl(data.item, "catalog-detail") ?? discoveryAssetUrls.defaultProductImage)
      : undefined,
    type: data?.item ? "product" : "website",
  }),
  ...(data?.canonicalUrl ? [{ tagName: "link", rel: "canonical", href: data.canonicalUrl }] : []),
];

export default function DiscoveryItemDetailRoute() {
  const data = useLoaderData<typeof loader>() ?? EMPTY_ITEM_DETAIL_RESULT;
  const actionData = useActionData<DiscoveryItemDetailActionData>();

  return (
    <DiscoveryItemDetailRealtimeView
      key={[
        data.item?.catalog_item_id ?? "empty",
        data.item?.market_listings.map((listing) => listing.listing_id).join("|") ?? "",
        data.item?.offer_demand_matches.map((offer) => offer.offer_id).join("|") ?? "",
      ].join("\n")}
      data={data}
      actionData={actionData}
    />
  );
}

function DiscoveryItemDetailRealtimeView({
  data,
  actionData,
}: {
  data: DiscoveryItemDetailRouteData;
  actionData: DiscoveryItemDetailActionData;
}) {
  const revalidateForRealtimeSync = useDiscoveryRealtimeRevalidation();
  const actionErrorMessage = getActionErrorMessage(actionData);
  const realtimeItem = useRealtimePatchedSnapshot({
    initialSnapshot: data.item,
    snapshotKey: JSON.stringify(data.item),
    topics: data.item ? discoveryRealtimeRouteTopics.itemDetail(data.item.catalog_item_id).topics : [],
    applyPatch: applyDiscoveryItemPatch,
    onSyncRequired: revalidateForRealtimeSync,
  });
  const productJsonLd = realtimeItem
    ? buildItemDetailProductJsonLd({ item: realtimeItem, canonicalUrl: data.canonicalUrl })
    : null;
  const breadcrumbJsonLd = realtimeItem
    ? buildItemDetailBreadcrumbListJsonLd({ item: realtimeItem, canonicalUrl: data.canonicalUrl })
    : null;

  return (
    <>
      {productJsonLd ? (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(productJsonLd) }} />
      ) : null}
      {breadcrumbJsonLd ? (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(breadcrumbJsonLd) }} />
      ) : null}
      <ItemDetailPage
        data={realtimeItem}
        similarItems={data.similarItems}
        accountOfferMatches={data.accountOfferMatches}
        viewerAccountId={data.viewerAccountId}
        initialMarketIntent={data.initialMarketIntent}
        initialSelectedListingId={data.initialSelectedListingId}
        initialSelectedOfferId={data.initialSelectedOfferId}
        initialSelectedOptions={data.initialSelectedOptions}
        hasInitialSelectedOptionFilters={data.hasInitialSelectedOptionFilters}
        notFound={data.notFound}
        error={data.error}
        renderCommerce={buildItemDetailCommerce(data, actionData, actionErrorMessage)}
      />
    </>
  );
}
