import { t } from "@chase-sets/localization";
import type { MetaFunction } from "react-router";
import { useActionData, useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { useRealtimePatchedSnapshot } from "@chase-sets/platform-runtime/realtime-react";
import { applyDiscoveryItemPatch } from "../support/client-support/realtime-market";
import { discoveryRealtimeRouteTopics } from "../support/realtime-support/topics";
import { discoveryAssetUrls } from "../support/client-support/assets";
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
      ? `${data.item.title} | Marketplace`
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
  const actionErrorMessage = getActionErrorMessage(actionData);
  const realtimeItem = useRealtimePatchedSnapshot({
    initialSnapshot: data.item,
    snapshotKey: JSON.stringify(data.item),
    topics: data.item ? discoveryRealtimeRouteTopics.itemDetail(data.item.catalog_item_id).topics : [],
    applyPatch: applyDiscoveryItemPatch,
    onSyncRequired: reloadForRealtimeSync,
  });

  return (
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
  );
}

function reloadForRealtimeSync() {
  if (typeof window !== "undefined") {
    window.location.reload();
  }
}
