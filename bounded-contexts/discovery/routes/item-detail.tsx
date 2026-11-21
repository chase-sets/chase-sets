import { t } from "@chase-sets/localization";
import { InventoryMutationProvider, InventoryMutationForm } from "@chase-sets/inventory/web";
import { EntryAttemptKeyScope } from "../support/ui-support/entry-attempt-key";
import { MutationFormProvider } from "../support/ui-support/mutation-form";
import type { ClientLoaderFunctionArgs, MetaFunction } from "react-router";
import { useActionData, useLoaderData } from "react-router";
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
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

type OfferPatchStart = {
  index: number;
  signal: AbortSignal;
  forget: () => void;
};

function createOfferPatchLog(itemId: string | undefined) {
  const patches: RealtimeProjectionPatch[] = [];
  const starts = new WeakMap<DiscoveryItemDetailRouteData, OfferPatchStart>();
  const pending = new Set<WeakRef<OfferPatchStart>>();
  const listeners = new Set<() => void>();
  let offset = 0;
  let renderedStart = 0;
  const endIndex = () => offset + patches.length;

  function trim() {
    let first = renderedStart;
    for (const ref of pending) {
      const start = ref.deref();
      if (!start || start.signal.aborted) pending.delete(ref);
      else first = Math.min(first, start.index);
    }
    if (first > offset) {
      patches.splice(0, first - offset);
      offset = first;
    }
  }

  return {
    itemId,
    endIndex,
    start(signal: AbortSignal): OfferPatchStart {
      trim();
      // The loader, or its returned snapshot, keeps this position alive. A
      // response the router drops without rendering must not pin it forever.
      const start = { index: endIndex(), signal, forget: () => pending.delete(ref) };
      const ref = new WeakRef(start);
      pending.add(ref);
      return start;
    },
    bind(data: DiscoveryItemDetailRouteData, start: OfferPatchStart) {
      starts.set(data, start);
    },
    startOf(data: DiscoveryItemDetailRouteData) {
      const start = starts.get(data);
      return start?.signal.aborted ? undefined : start;
    },
    commit(start: OfferPatchStart | undefined) {
      start?.forget();
      renderedStart = start?.index ?? 0;
      trim();
    },
    append(patch: RealtimeProjectionPatch) {
      patches.push(patch);
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    replay(item: DiscoveryItemRealtimeSnapshot | null, start: OfferPatchStart | undefined, end: number) {
      let next = item;
      for (let index = Math.max(start?.index ?? 0, offset); index < end; index++) {
        next = applyDiscoveryItemPatch(next, patches[index - offset]!);
      }
      return next;
    },
  };
}

const activeOfferPatchLogs = new Set<ReturnType<typeof createOfferPatchLog>>();

export async function clientLoader({ request, serverLoader }: ClientLoaderFunctionArgs) {
  const starts = request.signal.aborted
    ? []
    : Array.from(activeOfferPatchLogs, (log) => ({ log, start: log.start(request.signal) }));
  try {
    // Each response needs its own identity, even when its book is unchanged.
    const data = { ...(await serverLoader<typeof loader>()) };
    for (const { log, start } of starts) {
      if (!request.signal.aborted && log.itemId === data.item?.catalog_item_id) log.bind(data, start);
      else start.forget();
    }
    return data;
  } catch (error) {
    for (const { start } of starts) start.forget();
    throw error;
  }
}

export default function DiscoveryItemDetailRoute() {
  const data = useLoaderData<typeof loader>() ?? EMPTY_ITEM_DETAIL_RESULT;
  const actionData = useActionData<DiscoveryItemDetailActionData>();
  const realtimeItem = useItemDetailRealtime(data);

  const view = (
    <EntryAttemptKeyScope
      key={data.item?.catalog_item_id ?? "empty"}
      loaderKey={"entryAttemptKey" in data ? data.entryAttemptKey : null}
      actionKey={actionData && "entryAttemptKey" in actionData ? actionData.entryAttemptKey : null}
      actionDraft={actionData && "buyDraft" in actionData ? actionData.buyDraft : null}
    >
      <DiscoveryItemDetailView data={data} actionData={actionData} realtimeItem={realtimeItem} />
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

function useItemDetailRealtime(data: DiscoveryItemDetailRouteData) {
  const reload = useDiscoveryRealtimeRevalidation();
  const itemId = data.item?.catalog_item_id;
  const hasViewer = Boolean(data.viewerAccountId);
  const [state, setState] = useState(() => ({ data, item: data.item, log: createOfferPatchLog(itemId) }));
  const log = state.log.itemId === itemId ? state.log : createOfferPatchLog(itemId);
  const item = state.data === data ? state.item : data.item;
  if (state.data !== data) setState({ data, item, log });
  const start = log.startOf(data);
  const end = useSyncExternalStore(log.subscribe, log.endIndex, () => 0);

  useLayoutEffect(() => {
    if (!itemId) return;
    activeOfferPatchLogs.add(log);
    return () => {
      activeOfferPatchLogs.delete(log);
    };
  }, [itemId, log]);

  useLayoutEffect(() => {
    log.commit(start);
  }, [data, log, start]);

  useEffect(() => {
    if (!itemId) return;
    const subscription = subscribeRealtimePatches({
      topics: discoveryRealtimeRouteTopics.itemDetail(itemId).topics,
      onPatch: (patch) => {
        const offerChanges = patch.changes.filter((change) => change.entity === "discovery.buyerOffer");
        const otherChanges = patch.changes.filter((change) => change.entity !== "discovery.buyerOffer");
        if (otherChanges.length > 0) {
          setState((current) =>
            current.log === log
              ? { ...current, item: applyDiscoveryItemPatch(current.item, { ...patch, changes: otherChanges }) }
              : current,
          );
        }
        if (offerChanges.length > 0) log.append({ ...patch, changes: offerChanges });
        // Public patches do not carry the seller's account-scoped terms.
        if (hasViewer && offerChanges.some((change) => change.op === "upsert")) reload();
      },
      onSyncRequired: reload,
    });
    return () => subscription.close();
  }, [hasViewer, itemId, log, reload]);

  return log.replay(item, start, end);
}

function DiscoveryItemDetailView({
  data,
  actionData,
  realtimeItem,
}: {
  data: DiscoveryItemDetailRouteData;
  actionData: DiscoveryItemDetailActionData;
  realtimeItem: DiscoveryItemRealtimeSnapshot | null;
}) {
  const actionErrorMessage = getActionErrorMessage(actionData);
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
