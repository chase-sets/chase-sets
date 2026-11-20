import { t } from "@chase-sets/localization";
import { InventoryMutationProvider, InventoryMutationForm } from "@chase-sets/inventory/web";
import { EntryAttemptKeyScope } from "../support/ui-support/entry-attempt-key";
import { MutationFormProvider } from "../support/ui-support/mutation-form";
import type { MetaFunction } from "react-router";
import { useActionData, useLoaderData, useNavigation, useRevalidator } from "react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import type { RealtimeProjectionPatch } from "@chase-sets/platform-runtime/realtime";
import { subscribeRealtimePatches } from "@chase-sets/platform-runtime/realtime-web";
import { applyDiscoveryItemPatch, type DiscoveryItemRealtimeSnapshot } from "../support/client-support/realtime-market";
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

  const view = (
    <EntryAttemptKeyScope
      key={data.item?.catalog_item_id ?? "empty"}
      loaderKey={"entryAttemptKey" in data ? data.entryAttemptKey : null}
      actionKey={actionData && "entryAttemptKey" in actionData ? actionData.entryAttemptKey : null}
      actionDraft={actionData && "buyDraft" in actionData ? actionData.buyDraft : null}
    >
      <DiscoveryItemDetailRealtimeView data={data} actionData={actionData} />
    </EntryAttemptKeyScope>
  );
  const authority = "recoveryAuthority" in data ? data.recoveryAuthority : null;
  return authority ? (
    <InventoryMutationProvider authority={authority} key={`${authority.accountId}/${authority.actorUserId}`}>
      <MutationFormProvider value={InventoryMutationForm}>{view}</MutationFormProvider>
    </InventoryMutationProvider>
  ) : (
    view
  );
}

function useItemDetailRealtime(item: DiscoveryItemDetail | null, hasViewer: boolean) {
  const revalidationState = useRevalidator().state;
  const navigationState = useNavigation().state;
  const loading = revalidationState === "loading" || navigationState === "loading";
  const loadingRef = useRef(loading);
  loadingRef.current = loading;
  const revalidate = useDiscoveryRealtimeRevalidation();
  const reload = useCallback(() => {
    loadingRef.current = true;
    revalidate();
  }, [revalidate]);
  const itemId = item?.catalog_item_id;
  const loaderKey = useMemo(() => JSON.stringify(item), [item]);
  const [state, setState] = useState<{
    loaderKey: string;
    visibleItem: DiscoveryItemRealtimeSnapshot | null;
    overlappingOfferPatches: readonly RealtimeProjectionPatch[];
  }>(() => ({
    loaderKey,
    visibleItem: item,
    overlappingOfferPatches: [],
  }));

  let visibleItem = state.visibleItem;
  if (state.loaderKey !== loaderKey || (!loading && state.overlappingOfferPatches.length > 0)) {
    // The response can predate patches received while it was loading. Replaying
    // removals also preserves the IDs used to filter the private seller overlay.
    if (state.loaderKey !== loaderKey) {
      visibleItem = state.overlappingOfferPatches.reduce<DiscoveryItemRealtimeSnapshot | null>(
        applyDiscoveryItemPatch,
        item,
      );
    }
    setState({ loaderKey, visibleItem, overlappingOfferPatches: [] });
  }

  useEffect(() => {
    if (!itemId) return;
    const subscription = subscribeRealtimePatches({
      topics: discoveryRealtimeRouteTopics.itemDetail(itemId).topics,
      onPatch: (patch) => {
        const offerChanges = patch.changes.filter((change) => change.entity === "discovery.buyerOffer");
        const overlapping = loadingRef.current && offerChanges.length > 0;
        setState((current) => ({
          ...current,
          visibleItem: applyDiscoveryItemPatch(current.visibleItem, patch),
          overlappingOfferPatches: overlapping
            ? [...current.overlappingOfferPatches, { ...patch, changes: offerChanges }]
            : current.overlappingOfferPatches,
        }));
        // Public patches do not carry the seller's account-scoped terms.
        if (hasViewer && offerChanges.some((change) => change.op === "upsert")) reload();
      },
      onSyncRequired: reload,
    });
    return () => subscription.close();
  }, [hasViewer, itemId, reload]);

  return visibleItem;
}

function DiscoveryItemDetailRealtimeView({
  data,
  actionData,
}: {
  data: DiscoveryItemDetailRouteData;
  actionData: DiscoveryItemDetailActionData;
}) {
  const actionErrorMessage = getActionErrorMessage(actionData);
  const realtimeItem = useItemDetailRealtime(data.item, Boolean(data.viewerAccountId));
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
        key={[
          data.item?.market_listings.map((listing) => listing.listing_id).join("|") ?? "",
          data.item?.offer_demand_matches.map((offer) => offer.offer_id).join("|") ?? "",
        ].join("\n")}
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
