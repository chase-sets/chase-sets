import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { useEffect, type ReactNode } from "react";
import { redirect, useActionData, useLoaderData } from "react-router";
import type { FormPanelVariant } from "@chase-sets/design-system";
import { requireActorFromAuthApi, resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { appendFreshWriteToken } from "@chase-sets/http/responses";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { useRealtimePatchedSnapshot } from "@chase-sets/platform-runtime/realtime-react";
import { createDiscoveryRequestApiClient, DiscoveryApiError } from "../support/request-support/api-client";
import { applyDiscoveryItemPatch } from "../support/client-support/realtime-market";
import { discoveryRealtimeRouteTopics } from "../support/realtime-support/topics";
import type {
  DiscoveryItemDetail,
  DiscoverySellerInventoryItem,
  DiscoveryAccountOfferMatch,
} from "../support/client-support/contracts";
import { discoveryAssetUrls, imageVariantSrcSet } from "../support/client-support/assets";
import {
  buildDiscoveryProductAssetImage,
  selectDiscoveryProductAssetUrl,
} from "../support/client-support/product-assets";
import {
  createMarketplaceRequestApiClient,
  type MarketplaceListingInventoryItemOption,
  type MarketplaceListingTermsPreview,
} from "@chase-sets/marketplace/server";
import { createInventoryRequestApiClient } from "@chase-sets/inventory/server";
import {
  appendAnonymousCartCookie,
  createCheckoutRequestApiClient,
  ensureAnonymousCartId,
} from "@chase-sets/checkout/server";
import { ItemDetailPage } from "../features/item-detail/ui/item-detail-page";
import {
  BuyActionCard,
  type AddToCartActionData,
  canUseAccountCheckoutCart,
  CheckoutPurchaseIntentSection,
  type CommerceAccordionEdge,
  getActionErrorMessage,
  MarketplaceListingSubmissionSection,
  MarketplaceOfferMatchSection,
  MarketplaceOfferSubmissionSection,
  MarketplaceSellerRegistrationSection,
  ProductAlertCreationSection,
  ProductSellListIntentSection,
  WatchActionCard,
  SellActionCard,
} from "../features/item-detail/ui/commerce-sections";

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

const MARKETPLACE_DESCRIPTION = t("discovery.routes.itemDetail.browse.the.chase.sets.marketplace.with");
const LISTING_STOCK_LOCATION_NAME = "Listing stock";
const LISTING_STOCK_LOCATION_DESCRIPTION = "Auto-managed stock backing standard marketplace listings.";
const LISTING_STOCK_SHIP_FROM_CODE = "LISTING-STOCK";

const EMPTY_ITEM_DETAIL_RESULT = {
  item: null,
  accountOfferMatches: [],
  sellerInventoryItems: [],
  sellerAccountId: null,
  hasListingStockLocation: false,
  viewerAccountId: null,
  initialMarketIntent: "buy" as const,
  initialSelectedOptions: [],
  hasInitialSelectedOptionFilters: false,
  showSellerTab: true,
  canUseSellerFeatures: false,
  canSubmitOffers: false,
  registerToSellHref: "/register",
  notFound: false,
  error: null,
  canonicalUrl: null,
} as const;

type DiscoveryOfferMatchWithTerms = DiscoveryAccountOfferMatch &
  Readonly<{
    acceptance_terms: MarketplaceListingTermsPreview | null;
  }>;

function selectItemImageUrl(
  item: Partial<Pick<DiscoveryItemDetail, "image_urls" | "product_asset_sets" | "image_fallback">>,
  role: "thumbnail" | "catalog-detail" = "catalog-detail",
): string | null {
  return selectItemImage(item, role).src;
}

function selectItemImage(
  item: Partial<Pick<DiscoveryItemDetail, "image_urls" | "product_asset_sets" | "image_fallback">>,
  role: "thumbnail" | "catalog-detail" = "catalog-detail",
): { src: string | null; srcSet: string | null } {
  const productAssetSets = Array.isArray(item.product_asset_sets) ? item.product_asset_sets : [];
  const imageUrls = Array.isArray(item.image_urls) ? item.image_urls : [];
  const productAssetImage = buildDiscoveryProductAssetImage(
    productAssetSets,
    role,
    role === "thumbnail" ? "96px" : "(min-width: 768px) 308px, min(100vw, 276px)",
  );

  return {
    src:
      productAssetImage?.src ??
      selectDiscoveryProductAssetUrl(productAssetSets, role) ??
      imageUrls[0] ??
      (item.image_fallback?.usage === "permanent" ? item.image_fallback.url : null) ??
      null,
    srcSet: productAssetImage?.srcSet ?? null,
  };
}

function buildRegisterToSellHref(request: Request) {
  const url = new URL(request.url);
  const returnTo = `${url.pathname}${url.search}`;

  return `/register?returnTo=${encodeURIComponent(returnTo)}`;
}

export function readInitialSelectedOptions(searchParams: URLSearchParams) {
  const selectedByDimension = new Map<string, Set<string>>();

  for (const [key, value] of searchParams.entries()) {
    if (!key.startsWith("dimension.") || !value.trim()) {
      continue;
    }

    const dimensionId = key.slice("dimension.".length).trim();
    const optionId = value.trim();

    if (!dimensionId || !optionId) {
      continue;
    }

    selectedByDimension.set(dimensionId, new Set([...(selectedByDimension.get(dimensionId) ?? []), optionId]));
  }

  return [...selectedByDimension.entries()]
    .filter(([, optionIds]) => optionIds.size === 1)
    .map(([dimensionId, optionIds]) => ({
      dimensionId,
      optionId: [...optionIds][0],
    }));
}

function hasInitialSelectedOptionFilters(searchParams: URLSearchParams) {
  return [...searchParams.entries()].some(([key, value]) => key.startsWith("dimension.") && value.trim().length > 0);
}

function toSellerInventoryItem(inventoryItem: MarketplaceListingInventoryItemOption): DiscoverySellerInventoryItem {
  return {
    item_id: inventoryItem.item_id,
    catalog_catalog_item_id: inventoryItem.catalog_catalog_item_id,
    product_id: inventoryItem.product_id,
    item_title: inventoryItem.item_title,
    item_subtitle: inventoryItem.item_subtitle,
    selected_options: inventoryItem.selected_options,
    product_summary: inventoryItem.product_summary,
    storage_location_name: inventoryItem.storage_location_name,
    ship_from_code: inventoryItem.ship_from_code,
    available_quantity: inventoryItem.available_quantity,
  };
}

function parseSelectedOptions(value: FormDataEntryValue | null) {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));

    return Array.isArray(parsed)
      ? parsed
          .filter((selection): selection is { dimensionId: string; optionId: string } =>
            Boolean(
              selection && typeof selection === "object" && "dimensionId" in selection && "optionId" in selection,
            ),
          )
          .map((selection) => ({
            dimensionId: String(selection.dimensionId ?? ""),
            optionId: String(selection.optionId ?? ""),
          }))
      : [];
  } catch {
    return [];
  }
}

function shipFromAddressFromForm(formData: FormData) {
  const address = {
    name: String(formData.get("shipFromName") ?? "").trim(),
    line1: String(formData.get("shipFromLine1") ?? "").trim(),
    city: String(formData.get("shipFromCity") ?? "").trim(),
    state: String(formData.get("shipFromState") ?? "").trim(),
    postalCode: String(formData.get("shipFromPostalCode") ?? "").trim(),
    country: String(formData.get("shipFromCountry") ?? "US").trim() || "US",
  };

  if (!address.name && !address.line1 && !address.city && !address.state && !address.postalCode) {
    return null;
  }

  return address;
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createDiscoveryRequestApiClient(request);
  const marketplaceApi = createMarketplaceRequestApiClient(request);
  const inventoryApi = createInventoryRequestApiClient(request);
  const id = params.id;
  const url = new URL(request.url);
  const initialMarketIntent: "buy" | "sell" | "watch" =
    url.searchParams.get("market") === "sell" ? "sell" : url.searchParams.get("market") === "watch" ? "watch" : "buy";
  const initialSelectedOptions = readInitialSelectedOptions(url.searchParams);
  const initialSelectedOptionFiltersPresent = hasInitialSelectedOptionFilters(url.searchParams);

  if (!id) {
    return {
      item: null,
      accountOfferMatches: [],
      sellerInventoryItems: [],
      sellerAccountId: null,
      hasListingStockLocation: false,
      viewerAccountId: null,
      initialMarketIntent,
      initialSelectedOptions,
      hasInitialSelectedOptionFilters: initialSelectedOptionFiltersPresent,
      showSellerTab: false,
      canUseSellerFeatures: false,
      canUseListingFeatures: false,
      canSubmitOffers: false,
      registerToSellHref: buildRegisterToSellHref(request),
      notFound: true,
      canonicalUrl: null,
    };
  }

  try {
    const item = await api.getItemDetail(id);
    if (item.slug && id !== item.slug) {
      throw redirect(`/items/${item.slug}${url.search}`, { status: 301 });
    }

    const actor = await resolveActorFromAuthApi({ request });
    const canReviewAccountOfferMatches = Boolean(
      actor?.permissions.includes("offers.view") && actor.permissions.includes("listings.view"),
    );
    const canSellOnItem = Boolean(
      actor?.permissions.includes("listings.view") && actor.permissions.includes("listings.manage"),
    );
    const canSubmitOffers = Boolean(actor);
    let accountOfferMatches: DiscoveryOfferMatchWithTerms[] = [];
    let sellerInventoryItems: DiscoverySellerInventoryItem[] = [];
    let hasListingStockLocation = false;

    if (canReviewAccountOfferMatches) {
      try {
        const result = await marketplaceApi.listOfferMatches("limit=100&offset=0");
        const matchingOffers = result.items.filter((offer) => offer.catalog_catalog_item_id === item.catalog_item_id);
        accountOfferMatches = await Promise.all(
          matchingOffers.map(async (offer) => ({
            ...offer,
            acceptance_terms:
              offer.status === "submitted" ? await marketplaceApi.previewOfferAcceptanceTerms(offer.offer_id) : null,
          })),
        );
      } catch {
        accountOfferMatches = [];
      }
    }

    if (canSellOnItem) {
      try {
        const [items, storageLocations] = await Promise.all([
          marketplaceApi.listSellerListingInventory(
            `limit=100&offset=0&catalogItemId=${encodeURIComponent(item.catalog_item_id)}`,
          ),
          inventoryApi.listStorageLocations("limit=100&offset=0"),
        ]);
        sellerInventoryItems = (items.items as MarketplaceListingInventoryItemOption[]).map(toSellerInventoryItem);
        hasListingStockLocation = storageLocations.items.some(
          (location) => location.name === LISTING_STOCK_LOCATION_NAME,
        );
      } catch {
        sellerInventoryItems = [];
      }
    }

    return {
      item,
      accountOfferMatches,
      sellerInventoryItems,
      sellerAccountId: canSellOnItem ? (actor?.accountId ?? null) : null,
      hasListingStockLocation,
      viewerAccountId: actor?.accountId ?? null,
      initialMarketIntent,
      initialSelectedOptions,
      hasInitialSelectedOptionFilters: initialSelectedOptionFiltersPresent,
      showSellerTab: true,
      canUseSellerFeatures: canReviewAccountOfferMatches || canSellOnItem,
      canUseListingFeatures: canSellOnItem,
      canSubmitOffers,
      registerToSellHref: buildRegisterToSellHref(request),
      notFound: false,
      canonicalUrl: new URL(`/items/${item.slug || item.catalog_item_id}`, new URL(request.url).origin).toString(),
    };
  } catch (error) {
    if (error instanceof DiscoveryApiError) {
      return {
        item: null,
        accountOfferMatches: [],
        sellerInventoryItems: [],
        sellerAccountId: null,
        hasListingStockLocation: false,
        viewerAccountId: null,
        initialMarketIntent,
        initialSelectedOptions,
        hasInitialSelectedOptionFilters: initialSelectedOptionFiltersPresent,
        showSellerTab: false,
        canUseSellerFeatures: false,
        canUseListingFeatures: false,
        canSubmitOffers: false,
        registerToSellHref: buildRegisterToSellHref(request),
        notFound: true,
        canonicalUrl: null,
        error: error.message,
      };
    }

    return {
      item: null,
      accountOfferMatches: [],
      sellerInventoryItems: [],
      sellerAccountId: null,
      hasListingStockLocation: false,
      viewerAccountId: null,
      initialMarketIntent,
      initialSelectedOptions,
      hasInitialSelectedOptionFilters: initialSelectedOptionFiltersPresent,
      showSellerTab: false,
      canUseSellerFeatures: false,
      canUseListingFeatures: false,
      canSubmitOffers: false,
      registerToSellHref: buildRegisterToSellHref(request),
      notFound: true,
      canonicalUrl: null,
      error: error instanceof Error ? error.message : t("discovery.routes.itemDetail.item.not.found"),
    };
  }
}

export async function action({ request, params }: ActionFunctionArgs) {
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const discoveryApi = createDiscoveryRequestApiClient(request);
  const marketplaceApi = createMarketplaceRequestApiClient(request);
  const inventoryApi = createInventoryRequestApiClient(request);
  const checkoutApi = createCheckoutRequestApiClient(request);

  try {
    if (intent === "create-product-alert") {
      await requireActorFromAuthApi({
        request,
        permission: "accounts.view",
      });
      const item = await discoveryApi.getItemDetail(params.id!);
      await discoveryApi.createProductAlert({
        marketSide: String(formData.get("marketSide") ?? "") === "offer" ? "offer" : "listing",
        catalogItemId: item.catalog_item_id,
        productId: String(formData.get("productId") ?? ""),
        selectedOptions: parseSelectedOptions(formData.get("selectedOptions")),
        productSummary: String(formData.get("productSummary") ?? "") || null,
        thresholdAmount: String(formData.get("thresholdAmount") ?? "") || null,
      });

      return redirect(`/items/${item.slug || item.catalog_item_id}?productAlertCreated=1`);
    }

    if (intent === "submit-offer") {
      const item = await discoveryApi.getItemDetail(params.id!);
      const query = new URLSearchParams({
        source: "offer-intent",
        catalogItemId: item.catalog_item_id,
        productId: String(formData.get("productId") ?? ""),
        itemTitle: item.title,
        itemSubtitle: item.subtitle ?? "",
        selectedOptions: String(formData.get("selectedOptions") ?? "[]"),
        productSummary: String(formData.get("productSummary") ?? ""),
        offerPriceAmount: String(formData.get("priceAmount") ?? ""),
        quantity: String(formData.get("quantityRequested") ?? "1"),
      });

      return redirect(`/checkout/start?${query.toString()}`);
    }

    if (intent === "add-to-cart") {
      const actor = await resolveActorFromAuthApi({ request });
      const item = await discoveryApi.getItemDetail(params.id!);
      const itemImage = selectItemImage(item, "thumbnail");
      const cartLine = {
        catalogItemId: item.catalog_item_id,
        productId: String(formData.get("productId") ?? ""),
        itemTitle: item.title,
        itemSubtitle: item.subtitle,
        itemImageUrl: itemImage.src,
        itemImageSrcSet: itemImage.srcSet,
        itemImageLoadingUrl: item.image_fallback?.url ?? null,
        itemImageLoadingAlt: item.image_fallback?.alt ?? null,
        itemImageLoadingSrcSet: imageVariantSrcSet(item.image_fallback, "thumbnail") ?? null,
        selectedOptions: parseSelectedOptions(formData.get("selectedOptions")),
        productSummary: String(formData.get("productSummary") ?? "") || null,
        quantity: Number(formData.get("quantity") ?? 0),
        fulfillmentMode: "optimize" as const,
        lockedListingId: null,
      };

      if (!canUseAccountCheckoutCart(actor)) {
        const anonymousCartId = ensureAnonymousCartId(request);
        await checkoutApi.addGuestCartLine(anonymousCartId, cartLine);
        const response = Response.json({
          status: "added-to-cart",
          itemTitle: item.title,
          quantity: cartLine.quantity,
        } satisfies AddToCartActionData);
        appendAnonymousCartCookie(response.headers, anonymousCartId);
        return response;
      }

      await checkoutApi.addCartLine(cartLine);

      return Response.json({
        status: "added-to-cart",
        itemTitle: item.title,
        quantity: cartLine.quantity,
      } satisfies AddToCartActionData);
    }

    if (intent === "buy-now" || intent === "buy-this-listing") {
      const actor = await resolveActorFromAuthApi({ request });
      const item = await discoveryApi.getItemDetail(params.id!);
      const lockedListingId =
        intent === "buy-this-listing" ? String(formData.get("lockedListingId") ?? formData.get("listingId") ?? "") : "";
      const source = {
        type: "buy-now",
        listingId: lockedListingId,
        catalogItemId: item.catalog_item_id,
        productId: String(formData.get("productId") ?? ""),
        itemTitle: item.title,
        itemSubtitle: item.subtitle,
        selectedOptions: parseSelectedOptions(formData.get("selectedOptions")),
        productSummary: String(formData.get("productSummary") ?? "") || null,
        quantity: Number(formData.get("quantity") ?? 0),
        fulfillmentMode: lockedListingId ? ("locked-listing" as const) : ("optimize" as const),
        lockedListingId: lockedListingId || null,
      } as const;

      if (!canUseAccountCheckoutCart(actor)) {
        const query = new URLSearchParams({
          source: "buy-now",
          listingId: source.listingId,
          fulfillmentMode: source.fulfillmentMode,
          lockedListingId: source.lockedListingId ?? "",
          catalogItemId: source.catalogItemId,
          productId: source.productId,
          itemTitle: source.itemTitle,
          itemSubtitle: source.itemSubtitle ?? "",
          selectedOptions: JSON.stringify(source.selectedOptions),
          productSummary: source.productSummary ?? "",
          quantity: String(source.quantity),
          priceAmount: source.fulfillmentMode === "locked-listing" ? String(formData.get("priceAmount") ?? "") : "",
          sellerName: source.fulfillmentMode === "locked-listing" ? String(formData.get("sellerName") ?? "") : "",
          availability: source.fulfillmentMode === "locked-listing" ? String(formData.get("availability") ?? "") : "",
          fulfillment: t("discovery.routes.itemDetail.confirmed.at.checkout"),
        });
        return redirect(`/checkout/start?${query.toString()}`);
      }

      const session = await checkoutApi.createCheckoutSession({
        source,
      });

      return redirect(appendFreshWriteToken(`/checkout/${session.session_id}`, session));
    }

    if (intent === "sell-now") {
      await requireActorFromAuthApi({
        request,
        permission: "offers.manage",
      });

      const offerId = String(formData.get("offerId") ?? "");
      await marketplaceApi.acceptOfferMatch(offerId, {
        feeQuoteFingerprint: String(formData.get("feeQuoteFingerprint") ?? ""),
      });
      return redirect("/account/sales");
    }

    if (intent === "add-to-sell-list") {
      await requireActorFromAuthApi({
        request,
        permission: "offers.manage",
      });

      const item = await discoveryApi.getItemDetail(params.id!);
      const offerId = String(formData.get("offerId") ?? "");
      const offer = item.offer_demand_matches.find((candidate) => candidate.offer_id === offerId);
      if (!offer) {
        throw new Error("Offer match is no longer available.");
      }

      await checkoutApi.addSellListLine({
        lineType: "selected-offer",
        offerId,
        buyerAccountId: offer.buyer_account_id,
        buyerDisplayName: offer.buyer_display_name,
        offerPriceAmount: offer.price_amount,
        catalogItemId: item.catalog_item_id,
        productId: offer.product_id,
        itemTitle: item.title,
        itemSubtitle: item.subtitle,
        selectedOptions: offer.selected_options,
        productSummary: offer.product_summary,
        quantity: offer.quantity_requested,
      });
      return redirect("/account/sell-list");
    }

    if (intent === "add-product-to-sell-list") {
      await requireActorFromAuthApi({
        request,
        permission: "listings.manage",
      });

      const item = await discoveryApi.getItemDetail(params.id!);
      await checkoutApi.addSellListLine({
        lineType: "product",
        offerId: null,
        buyerAccountId: null,
        buyerDisplayName: null,
        offerPriceAmount: null,
        catalogItemId: item.catalog_item_id,
        productId: String(formData.get("productId") ?? ""),
        itemTitle: item.title,
        itemSubtitle: item.subtitle,
        selectedOptions: parseSelectedOptions(formData.get("selectedOptions")),
        productSummary: String(formData.get("productSummary") ?? "") || null,
        quantity: Number(formData.get("quantity") ?? 0),
        fallbackMode: "none",
        minimumListingPriceAmount: null,
      });
      return redirect("/account/sell-list");
    }

    if (intent === "create-listing-stock-location") {
      await requireActorFromAuthApi({
        request,
        permission: "listings.manage",
      });
      const item = await discoveryApi.getItemDetail(params.id!);
      const shipFromAddress = shipFromAddressFromForm(formData);

      if (!shipFromAddress) {
        throw new Error(t("discovery.routes.itemDetail.ship.from.setup.required"));
      }

      await inventoryApi.createStorageLocation({
        name: LISTING_STOCK_LOCATION_NAME,
        description: LISTING_STOCK_LOCATION_DESCRIPTION,
        shipFromCode: LISTING_STOCK_SHIP_FROM_CODE,
        shipFromAddress,
      });

      return redirect(`/items/${item.slug || item.catalog_item_id}?market=sell`);
    }

    if (intent === "list-at-price") {
      await requireActorFromAuthApi({
        request,
        permission: "listings.manage",
      });
      const item = await discoveryApi.getItemDetail(params.id!);

      const listingId = String(formData.get("listingId") ?? "").trim();
      const priceAmount = String(formData.get("priceAmount") ?? "");
      const quantityCap = Number(formData.get("quantityCap") ?? 0);

      if (listingId) {
        const quote = await marketplaceApi.previewListingTerms({ priceAmount });
        await marketplaceApi.updateListingPrice(listingId, {
          priceAmount,
          feeQuoteFingerprint: quote.fee_quote_fingerprint,
        });
        await marketplaceApi.updateListingQuantityCap(listingId, {
          quantityCap,
          feeQuoteFingerprint: quote.fee_quote_fingerprint,
        });
        return redirect(`/items/${item.slug || params.id}`);
      }

      const inventoryItemId = String(formData.get("inventoryItemId") ?? "").trim();
      const listingBody = inventoryItemId
        ? {
            inventoryItemId,
            priceAmount,
            quantityCap,
          }
        : {
            inventoryItemId: "",
            priceAmount,
            quantityCap,
            inventorySnapshot: (
              await inventoryApi.ensureListingStock({
                catalogItemId: item.catalog_item_id,
                selectedOptions: parseSelectedOptions(formData.get("selectedOptions")),
                quantity: quantityCap,
              })
            ).snapshot,
          };
      const result = (await marketplaceApi.createListing(listingBody)) as { id?: string; feeQuoteFingerprint?: string };

      if (result.id) {
        await marketplaceApi.publishListing(result.id, {
          feeQuoteFingerprint: result.feeQuoteFingerprint,
        });
      }

      return redirect(`/items/${item.slug || params.id}`);
    }

    return null;
  } catch (error) {
    if (error instanceof Error) {
      return {
        error: error.message,
      };
    }

    throw error;
  }
}

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
  const actionData = useActionData<typeof action>();

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

type DiscoveryItemDetailRouteData = typeof EMPTY_ITEM_DETAIL_RESULT | Awaited<ReturnType<typeof loader>>;
type DiscoveryItemDetailActionData = Exclude<Awaited<ReturnType<typeof action>>, Response> | undefined;

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
      accountOfferMatches={data.accountOfferMatches}
      viewerAccountId={data.viewerAccountId}
      initialMarketIntent={data.initialMarketIntent}
      initialSelectedOptions={data.initialSelectedOptions}
      hasInitialSelectedOptionFilters={data.hasInitialSelectedOptionFilters}
      notFound={data.notFound}
      error={data.error}
      renderCommerce={
        data.item
          ? (context) => {
              const ownListing =
                data.sellerAccountId && context.selectedProductId
                  ? (context.visibleListings.find(
                      (listing) =>
                        listing.account_id === data.sellerAccountId && listing.product_id === context.selectedProductId,
                    ) ?? null)
                  : null;
              const renderBuy = (
                formId: string,
                panelVariant: FormPanelVariant = "card",
                actions?: ReactNode,
                showSummary?: boolean,
                actionMode?: "all" | "buy-now" | "add-to-cart",
              ) => (
                <CheckoutPurchaseIntentSection
                  formId={formId}
                  panelVariant={panelVariant}
                  showSummary={showSummary}
                  actions={actions}
                  actionMode={actionMode}
                  catalogItemId={context.itemId}
                  productId={context.selectedProductId}
                  selectedListing={context.selectedListing}
                  itemTitle={context.itemTitle}
                  selectedOptions={context.selectedProductOptions}
                  productSelectionDetails={context.selectedProductSelectionDetails}
                  productSummary={context.selectedProductSummary}
                  visibleListingCount={context.visibleListings.length}
                  errorMessage={actionErrorMessage}
                />
              );
              const renderProductAlert = (
                formId: string,
                marketSide: "listing" | "offer",
                panelVariant: FormPanelVariant = "card",
                showSummary?: boolean,
              ) => (
                <ProductAlertCreationSection
                  formId={formId}
                  panelVariant={panelVariant}
                  showSummary={showSummary}
                  marketSide={marketSide}
                  catalogItemId={context.itemId}
                  productId={context.selectedProductId}
                  selectedOptions={context.selectedProductOptions}
                  productSelectionDetails={context.selectedProductSelectionDetails}
                  productSummary={context.selectedProductSummary}
                />
              );
              const renderOffer = (
                formId: string,
                panelVariant: FormPanelVariant = "card",
                actions?: ReactNode,
                showSummary?: boolean,
              ) => (
                <MarketplaceOfferSubmissionSection
                  formId={formId}
                  panelVariant={panelVariant}
                  showSummary={showSummary}
                  actions={actions}
                  catalogItemId={context.itemId}
                  productId={context.selectedProductId}
                  itemTitle={context.itemTitle}
                  selectedOptions={context.selectedProductOptions}
                  productSelectionDetails={context.selectedProductSelectionDetails}
                  productSummary={context.selectedProductSummary}
                  visibleListingCount={context.visibleListings.length}
                  errorMessage={actionErrorMessage}
                />
              );
              const renderOfferMatch = (
                formId: string,
                panelVariant: FormPanelVariant = "card",
                actions?: ReactNode,
                showSummary?: boolean,
                actionMode?: "all" | "sell-now" | "add-to-sell-list",
              ) => (
                <MarketplaceOfferMatchSection
                  formId={formId}
                  panelVariant={panelVariant}
                  showSummary={showSummary}
                  actions={actions}
                  actionMode={actionMode}
                  selectedOffer={context.selectedAccountOfferMatch}
                  productId={context.selectedProductId}
                  productSelectionDetails={context.selectedProductSelectionDetails}
                  productSummary={context.selectedProductSummary}
                  matchingOfferCount={context.visibleAccountOfferMatches.length}
                  errorMessage={actionErrorMessage}
                />
              );
              const renderListingSubmission = (
                formId: string,
                panelVariant: FormPanelVariant = "card",
                actions?: ReactNode,
                showSummary?: boolean,
              ) => (
                <MarketplaceListingSubmissionSection
                  formId={formId}
                  panelVariant={panelVariant}
                  showSummary={showSummary}
                  actions={actions}
                  productId={context.selectedProductId}
                  selectedOptions={context.selectedProductOptions}
                  productSummary={context.selectedProductSummary}
                  productSelectionDetails={context.selectedProductSelectionDetails}
                  bestListing={context.bestListing}
                  ownListing={ownListing}
                  hasListingStockLocation={data.hasListingStockLocation}
                  errorMessage={actionErrorMessage}
                />
              );
              const renderSellerRegistration = (
                panelVariant: FormPanelVariant = "card",
                showSummary?: boolean,
                mode?: "combined" | "offer" | "listing",
              ) => (
                <MarketplaceSellerRegistrationSection
                  panelVariant={panelVariant}
                  showSummary={showSummary}
                  mode={mode}
                  productSummary={context.selectedProductSummary}
                  productSelectionDetails={context.selectedProductSelectionDetails}
                  selectedOffer={context.selectedOffer}
                  matchingOfferCount={context.visibleOffers.length}
                  registerHref={data.registerToSellHref}
                />
              );
              const renderBuyActionCard = (
                formIdPrefix: string,
                panelVariant: FormPanelVariant = "card",
                accordionEdge?: CommerceAccordionEdge,
              ) => (
                <BuyActionCard
                  formIdPrefix={formIdPrefix}
                  panelVariant={panelVariant}
                  accordionEdge={accordionEdge}
                  productId={context.selectedProductId}
                  productSummary={context.selectedProductSummary}
                  productSelectionDetails={context.selectedProductSelectionDetails}
                  visibleListingCount={context.visibleListings.length}
                  renderBuyNow={(formId) => renderBuy(formId, "plain", undefined, true, "buy-now")}
                  renderAddToCart={(formId) => renderBuy(formId, "plain", undefined, true, "add-to-cart")}
                  renderOffer={(formId) => renderOffer(formId, "plain", undefined, true)}
                />
              );
              const renderSellActionCard = (
                formIdPrefix: string,
                panelVariant: FormPanelVariant = "card",
                accordionEdge?: CommerceAccordionEdge,
              ) => (
                <SellActionCard
                  formIdPrefix={formIdPrefix}
                  panelVariant={panelVariant}
                  accordionEdge={accordionEdge}
                  productId={context.selectedProductId}
                  productSummary={context.selectedProductSummary}
                  productSelectionDetails={context.selectedProductSelectionDetails}
                  hasMatchingOffer={
                    data.canUseSellerFeatures
                      ? Boolean(context.selectedAccountOfferMatch)
                      : context.visibleOffers.length > 0
                  }
                  canUseSellerFeatures={data.canUseSellerFeatures}
                  canUseListingFeatures={data.canUseListingFeatures}
                  renderSellNow={(formId) =>
                    data.canUseSellerFeatures
                      ? renderOfferMatch(formId, "plain", undefined, true, "sell-now")
                      : renderSellerRegistration("plain", true, "offer")
                  }
                  renderAddToSellList={(formId) =>
                    data.canUseSellerFeatures
                      ? renderOfferMatch(formId, "plain", undefined, true, "add-to-sell-list")
                      : renderSellerRegistration("plain", true, "offer")
                  }
                  renderAddProductToSellList={(formId) =>
                    data.canUseListingFeatures ? (
                      <ProductSellListIntentSection
                        formId={formId}
                        panelVariant="plain"
                        showSummary
                        catalogItemId={data.item.catalog_item_id}
                        productId={context.selectedProductId}
                        itemTitle={data.item.title}
                        selectedOptions={context.selectedProductOptions}
                        productSelectionDetails={context.selectedProductSelectionDetails}
                        productSummary={context.selectedProductSummary}
                        errorMessage={actionData?.error ?? null}
                      />
                    ) : (
                      renderSellerRegistration("plain", true, "offer")
                    )
                  }
                  renderListing={(formId) =>
                    data.canUseListingFeatures
                      ? renderListingSubmission(formId, "plain", undefined, true)
                      : renderSellerRegistration("plain", true, "listing")
                  }
                />
              );
              const renderWatchActionCard = (
                formIdPrefix: string,
                panelVariant: FormPanelVariant = "card",
                accordionEdge?: CommerceAccordionEdge,
              ) => (
                <WatchActionCard
                  formIdPrefix={formIdPrefix}
                  panelVariant={panelVariant}
                  accordionEdge={accordionEdge}
                  productId={context.selectedProductId}
                  productSummary={context.selectedProductSummary}
                  productSelectionDetails={context.selectedProductSelectionDetails}
                  renderListingAlert={(formId) => renderProductAlert(formId, "listing", "plain", true)}
                  renderOfferAlert={(formId) => renderProductAlert(formId, "offer", "plain", true)}
                />
              );
              return {
                buy: renderBuyActionCard("buy-card", "plain"),
                offer: null,
                sell: data.showSellerTab ? renderSellActionCard("sell-card", "plain") : undefined,
                watch: renderWatchActionCard("watch-card", "plain"),
                mobile: {
                  buy: {
                    content: renderBuyActionCard("mobile-buy-card", "plain", "panel"),
                    title: t("discovery.routes.itemDetail.buy"),
                  },
                  sell: {
                    content: renderSellActionCard("mobile-sell-card", "plain", "panel"),
                    title: t("discovery.routes.itemDetail.sell.2"),
                  },
                  watch: {
                    content: renderWatchActionCard("mobile-watch-card", "plain", "panel"),
                    title: t("discovery.routes.itemDetail.watch"),
                  },
                },
                sellLabel: data.canUseSellerFeatures
                  ? t("discovery.routes.itemDetail.sell.2")
                  : t("discovery.routes.itemDetail.sell.3"),
                watchLabel: t("discovery.routes.itemDetail.watch"),
              };
            }
          : undefined
      }
    />
  );
}

function reloadForRealtimeSync() {
  if (typeof window !== "undefined") {
    window.location.reload();
  }
}
