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
  appendAnonymousListingDraftCookie,
  createMarketplaceRequestApiClient,
  ensureAnonymousListingDraftOwnerId,
  MarketplaceApiError,
  type OfferMatchListItem,
  type MarketplaceListingInventoryItemOption,
  type MarketplaceListingTermsPreview,
  type MarketplacePublicStandardTermsPreview,
} from "@chase-sets/marketplace/server";
import { createInventoryRequestApiClient } from "@chase-sets/inventory/server";
import {
  appendAnonymousCartCookie,
  appendAnonymousSellListCookie,
  createCheckoutRequestApiClient,
  ensureAnonymousCartId,
  ensureAnonymousSellListId,
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
  initialSelectedListingId: null,
  initialSelectedOfferId: null,
  initialSelectedOptions: [],
  hasInitialSelectedOptionFilters: false,
  showSellerTab: true,
  canUseSellerFeatures: false,
  canUseListingFeatures: false,
  canUseGuestListingDraft: false,
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

function buildRegisterToClaimListingDraftHref(intentId: string) {
  const returnTo = `/account/listings?claimListingIntent=${encodeURIComponent(intentId)}`;
  return `/register?returnTo=${encodeURIComponent(returnTo)}`;
}

function canUseAccountSellList(actor: Awaited<ReturnType<typeof resolveActorFromAuthApi>>) {
  return Boolean(actor && !actor.permissions.includes("guest-checkout.manage"));
}

async function attachPublicStandardOfferTerms(
  marketplaceApi: ReturnType<typeof createMarketplaceRequestApiClient>,
  item: DiscoveryItemDetail,
): Promise<DiscoveryItemDetail> {
  const previewPublicStandardListingTerms = marketplaceApi.previewPublicStandardListingTerms?.bind(marketplaceApi);
  if (typeof previewPublicStandardListingTerms !== "function" || item.offer_demand_matches.length === 0) {
    return item;
  }

  const previewByPrice = new Map<string, Promise<MarketplacePublicStandardTermsPreview | null>>();
  const previewForPrice = (priceAmount: string) => {
    if (!previewByPrice.has(priceAmount)) {
      previewByPrice.set(
        priceAmount,
        previewPublicStandardListingTerms({ priceAmount })
          .then((preview) => preview)
          .catch(() => null),
      );
    }

    return previewByPrice.get(priceAmount)!;
  };

  return {
    ...item,
    offer_demand_matches: await Promise.all(
      item.offer_demand_matches.map(async (offer) => ({
        ...offer,
        public_standard_terms_preview: offer.price_amount ? await previewForPrice(offer.price_amount) : null,
      })),
    ),
  };
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

export function readExplicitMarketSelectionId(searchParams: URLSearchParams, key: "listing" | "offer") {
  const ids = new Set(
    searchParams
      .getAll(key)
      .map((value) => value.trim())
      .filter(Boolean),
  );

  return ids.size === 1 ? [...ids][0] : null;
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

function parsePositiveQuantity(value: FormDataEntryValue | null) {
  const normalized = String(value ?? "").trim();
  const quantity = Number(normalized);

  if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(quantity) || quantity < 1) {
    throw new Error(t("discovery.routes.itemDetail.validation.quantity.required"));
  }

  return quantity;
}

function normalizeMoneyAmount(
  value: FormDataEntryValue | null,
  options: Readonly<{
    allowZero?: boolean;
    optional: true;
    invalidMessage: string;
  }>,
): string | null;
function normalizeMoneyAmount(
  value: FormDataEntryValue | null,
  options: Readonly<{
    allowZero?: boolean;
    optional?: false;
    invalidMessage: string;
  }>,
): string;
function normalizeMoneyAmount(
  value: FormDataEntryValue | null,
  {
    allowZero = false,
    optional = false,
    invalidMessage,
  }: Readonly<{
    allowZero?: boolean;
    optional?: boolean;
    invalidMessage: string;
  }>,
) {
  const normalized = String(value ?? "").trim();

  if (!normalized) {
    if (optional) {
      return null;
    }
    throw new Error(invalidMessage);
  }

  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) {
    throw new Error(invalidMessage);
  }

  const amount = Number.parseFloat(normalized);
  if (!Number.isFinite(amount) || (allowZero ? amount < 0 : amount <= 0)) {
    throw new Error(invalidMessage);
  }

  return amount.toFixed(2);
}

function getListingAvailableQuantity(listing: DiscoveryItemDetail["market_listings"][number]) {
  const visibleQuantity = Number(listing.visible_quantity);
  const quantityCap = Number(listing.quantity_cap);

  if (Number.isFinite(visibleQuantity)) {
    return visibleQuantity;
  }

  return Number.isFinite(quantityCap) ? quantityCap : 0;
}

function findSelectedListingForAction(item: DiscoveryItemDetail, listingId: string) {
  const normalizedListingId = listingId.trim();
  const listing = item.market_listings.find((candidate) => candidate.listing_id === normalizedListingId);

  if (!normalizedListingId || !listing || listing.status !== "active" || getListingAvailableQuantity(listing) < 1) {
    throw new Error(t("discovery.routes.itemDetail.validation.selected.listing.unavailable"));
  }

  return listing;
}

function assertSelectedListingQuantityAvailable(
  listing: DiscoveryItemDetail["market_listings"][number],
  quantity: number,
) {
  const availableQuantity = getListingAvailableQuantity(listing);
  if (quantity > availableQuantity) {
    throw new Error(
      t("discovery.routes.itemDetail.validation.selected.listing.quantity.exceeded", {
        availableQuantity,
      }),
    );
  }
}

async function getFreshOfferMatchForAction(
  marketplaceApi: ReturnType<typeof createMarketplaceRequestApiClient>,
  item: DiscoveryItemDetail,
  offerId: string,
): Promise<OfferMatchListItem> {
  const normalizedOfferId = offerId.trim();
  if (!normalizedOfferId || typeof marketplaceApi.getOfferMatch !== "function") {
    throw new Error(t("discovery.routes.itemDetail.validation.selected.offer.unavailable"));
  }

  const offer = await marketplaceApi.getOfferMatch(normalizedOfferId).catch((error: unknown) => {
    if (error instanceof MarketplaceApiError && error.status === 404) {
      return null;
    }

    throw error;
  });
  if (!offer || offer.catalog_catalog_item_id !== item.catalog_item_id || offer.status !== "submitted") {
    throw new Error(t("discovery.routes.itemDetail.validation.selected.offer.unavailable"));
  }

  if (!offer.can_fulfill) {
    throw new Error(
      t("discovery.routes.itemDetail.validation.selected.offer.quantity.unavailable", {
        requestedQuantity: offer.quantity_requested,
        availableQuantity: offer.seller_available_quantity,
      }),
    );
  }

  return offer;
}

function getPublicSelectedOfferForSellList(
  item: DiscoveryItemDetail,
  offerId: string,
): DiscoveryItemDetail["offer_demand_matches"][number] {
  const normalizedOfferId = offerId.trim();
  const offer = item.offer_demand_matches.find((candidate) => candidate.offer_id === normalizedOfferId);

  if (
    !normalizedOfferId ||
    !offer ||
    offer.catalog_catalog_item_id !== item.catalog_item_id ||
    offer.status !== "submitted"
  ) {
    throw new Error(t("discovery.routes.itemDetail.validation.selected.offer.unavailable"));
  }

  return offer;
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
  const checkoutApi = createCheckoutRequestApiClient(request);
  const inventoryApi = createInventoryRequestApiClient(request);
  const id = params.id;
  const url = new URL(request.url);
  const initialMarketIntent: "buy" | "sell" | "watch" =
    url.searchParams.get("market") === "sell" ? "sell" : url.searchParams.get("market") === "watch" ? "watch" : "buy";
  const initialSelectedListingId = readExplicitMarketSelectionId(url.searchParams, "listing");
  const initialSelectedOfferId = readExplicitMarketSelectionId(url.searchParams, "offer");
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
      initialSelectedListingId,
      initialSelectedOfferId,
      initialSelectedOptions,
      hasInitialSelectedOptionFilters: initialSelectedOptionFiltersPresent,
      showSellerTab: false,
      canUseSellerFeatures: false,
      canUseListingFeatures: false,
      canUseGuestListingDraft: false,
      canSubmitOffers: false,
      registerToSellHref: buildRegisterToSellHref(request),
      notFound: true,
      canonicalUrl: null,
    };
  }

  try {
    let item = await api.getItemDetail(id);
    if (item.slug && id !== item.slug) {
      throw redirect(`/items/${item.slug}${url.search}`, { status: 301 });
    }

    const actor = await resolveActorFromAuthApi({ request });
    if (!canUseAccountSellList(actor)) {
      item = await attachPublicStandardOfferTerms(marketplaceApi, item);
    }

    const canReviewAccountOfferMatches = Boolean(
      actor?.permissions.includes("offers.view") && actor.permissions.includes("listings.view"),
    );
    const canSellOnItem = Boolean(
      actor?.permissions.includes("listings.view") && actor.permissions.includes("listings.manage"),
    );
    const canUseGuestListingDraft = !canUseAccountSellList(actor);
    const canSubmitOffers = Boolean(actor);
    let accountOfferMatches: DiscoveryOfferMatchWithTerms[] = [];
    let sellerInventoryItems: DiscoverySellerInventoryItem[] = [];
    let hasListingStockLocation = false;

    if (canReviewAccountOfferMatches) {
      try {
        const [result, sellList] = await Promise.all([
          marketplaceApi.listOfferMatches("limit=100&offset=0"),
          checkoutApi.getSellList().catch(() => ({ items: [] })),
        ]);
        const selectedOfferIds = new Set(
          sellList.items
            .filter((line) => line.line_type === "selected-offer" && line.offer_id)
            .map((line) => String(line.offer_id)),
        );
        const matchingOffers = result.items.filter((offer) => offer.catalog_catalog_item_id === item.catalog_item_id);
        accountOfferMatches = await Promise.all(
          matchingOffers.map(async (offer) => ({
            ...offer,
            in_sell_list: selectedOfferIds.has(offer.offer_id),
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
      initialSelectedListingId,
      initialSelectedOfferId,
      initialSelectedOptions,
      hasInitialSelectedOptionFilters: initialSelectedOptionFiltersPresent,
      showSellerTab: true,
      canUseSellerFeatures: canReviewAccountOfferMatches || canSellOnItem,
      canUseListingFeatures: canSellOnItem,
      canUseGuestListingDraft,
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
        initialSelectedListingId,
        initialSelectedOfferId,
        initialSelectedOptions,
        hasInitialSelectedOptionFilters: initialSelectedOptionFiltersPresent,
        showSellerTab: false,
        canUseSellerFeatures: false,
        canUseListingFeatures: false,
        canUseGuestListingDraft: false,
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
      initialSelectedListingId,
      initialSelectedOfferId,
      initialSelectedOptions,
      hasInitialSelectedOptionFilters: initialSelectedOptionFiltersPresent,
      showSellerTab: false,
      canUseSellerFeatures: false,
      canUseListingFeatures: false,
      canUseGuestListingDraft: false,
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
        thresholdAmount: normalizeMoneyAmount(formData.get("thresholdAmount"), {
          allowZero: true,
          optional: true,
          invalidMessage: t("discovery.routes.itemDetail.validation.threshold.invalid"),
        }),
      });

      return redirect(`/items/${item.slug || item.catalog_item_id}?productAlertCreated=1`);
    }

    if (intent === "submit-offer") {
      const item = await discoveryApi.getItemDetail(params.id!);
      const offerPriceAmount = normalizeMoneyAmount(formData.get("priceAmount"), {
        invalidMessage: t("discovery.routes.itemDetail.validation.price.required"),
      });
      const quantity = parsePositiveQuantity(formData.get("quantityRequested"));
      const query = new URLSearchParams({
        source: "offer-intent",
        catalogItemId: item.catalog_item_id,
        productId: String(formData.get("productId") ?? ""),
        itemTitle: item.title,
        itemSubtitle: item.subtitle ?? "",
        selectedOptions: String(formData.get("selectedOptions") ?? "[]"),
        productSummary: String(formData.get("productSummary") ?? ""),
        offerPriceAmount,
        quantity: String(quantity),
      });

      return redirect(`/checkout/start?${query.toString()}`);
    }

    if (intent === "add-to-cart") {
      const actor = await resolveActorFromAuthApi({ request });
      const item = await discoveryApi.getItemDetail(params.id!);
      const itemImage = selectItemImage(item, "thumbnail");
      const quantity = parsePositiveQuantity(formData.get("quantity"));
      const productId = String(formData.get("productId") ?? "");
      const sellerPreferenceId = String(formData.get("sellerPreferenceId") ?? "").trim();
      const preferredListing = sellerPreferenceId ? findSelectedListingForAction(item, sellerPreferenceId) : null;
      if (preferredListing) {
        if (preferredListing.product_id !== productId) {
          throw new Error(t("discovery.routes.itemDetail.validation.selected.listing.unavailable"));
        }
        assertSelectedListingQuantityAvailable(preferredListing, quantity);
      }
      const cartLine = {
        catalogItemId: item.catalog_item_id,
        productId,
        itemTitle: item.title,
        itemSubtitle: item.subtitle,
        itemImageUrl: itemImage.src,
        itemImageSrcSet: itemImage.srcSet,
        itemImageLoadingUrl: item.image_fallback?.url ?? null,
        itemImageLoadingAlt: item.image_fallback?.alt ?? null,
        itemImageLoadingSrcSet: imageVariantSrcSet(item.image_fallback, "thumbnail") ?? null,
        selectedOptions: parseSelectedOptions(formData.get("selectedOptions")),
        productSummary: String(formData.get("productSummary") ?? "") || null,
        quantity,
        fulfillmentMode: "optimize" as const,
        lockedListingId: null,
        sellerPreferenceId: preferredListing?.listing_id ?? null,
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
        intent === "buy-this-listing"
          ? String(formData.get("lockedListingId") ?? formData.get("listingId") ?? "").trim()
          : "";
      const quantity = parsePositiveQuantity(formData.get("quantity"));
      const lockedListing = lockedListingId ? findSelectedListingForAction(item, lockedListingId) : null;
      if (lockedListing) {
        assertSelectedListingQuantityAvailable(lockedListing, quantity);
      }
      const lockedListingAvailableQuantity = lockedListing ? getListingAvailableQuantity(lockedListing) : 0;
      const source = {
        type: "buy-now",
        listingId: lockedListingId,
        catalogItemId: item.catalog_item_id,
        productId: String(formData.get("productId") ?? ""),
        itemTitle: item.title,
        itemSubtitle: item.subtitle,
        selectedOptions: parseSelectedOptions(formData.get("selectedOptions")),
        productSummary: String(formData.get("productSummary") ?? "") || null,
        quantity,
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
          priceAmount: lockedListing?.price_amount ?? "",
          sellerName: lockedListing?.seller_display_name ?? "",
          availability: lockedListing
            ? t("discovery.routes.itemDetail.inventory.option.label", {
                productSummary: source.productSummary ?? source.itemTitle,
                availableQuantity: lockedListingAvailableQuantity,
              })
            : "",
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

      const item = await discoveryApi.getItemDetail(params.id!);
      const offerId = String(formData.get("offerId") ?? "").trim();
      await getFreshOfferMatchForAction(marketplaceApi, item, offerId);
      await marketplaceApi.acceptOfferMatch(offerId, {
        feeQuoteFingerprint: String(formData.get("feeQuoteFingerprint") ?? ""),
      });
      return redirect("/account/sales");
    }

    if (intent === "add-to-sell-list") {
      const actor = await resolveActorFromAuthApi({ request });

      const item = await discoveryApi.getItemDetail(params.id!);
      const offerId = String(formData.get("offerId") ?? "").trim();

      if (!canUseAccountSellList(actor)) {
        const offer = getPublicSelectedOfferForSellList(item, offerId);
        const anonymousSellListId = ensureAnonymousSellListId(request);
        await checkoutApi.addGuestSellListLine(anonymousSellListId, {
          lineType: "selected-offer",
          offerId,
          buyerAccountId: null,
          buyerDisplayName: offer.buyer_display_name,
          offerPriceAmount: offer.price_amount,
          catalogItemId: item.catalog_item_id,
          productId: offer.product_id,
          itemTitle: item.title,
          itemSubtitle: item.subtitle,
          selectedOptions: offer.selected_options,
          productSummary: offer.product_summary,
          quantity: offer.quantity_requested,
          fallbackMode: "none",
          minimumListingPriceAmount: null,
        });
        const response = redirect("/account/sell-list");
        appendAnonymousSellListCookie(response.headers, anonymousSellListId);
        return response;
      }

      await requireActorFromAuthApi({
        request,
        permission: "offers.manage",
      });

      const offer = await getFreshOfferMatchForAction(marketplaceApi, item, offerId);

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
      const actor = await resolveActorFromAuthApi({ request });

      const item = await discoveryApi.getItemDetail(params.id!);
      const quantity = parsePositiveQuantity(formData.get("quantity"));
      const sellListLine = {
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
        quantity,
        fallbackMode: "none",
        minimumListingPriceAmount: null,
      } as const;

      if (!canUseAccountSellList(actor)) {
        const anonymousSellListId = ensureAnonymousSellListId(request);
        await checkoutApi.addGuestSellListLine(anonymousSellListId, sellListLine);
        const response = redirect("/account/sell-list");
        appendAnonymousSellListCookie(response.headers, anonymousSellListId);
        return response;
      }

      await checkoutApi.addSellListLine(sellListLine);
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
      const item = await discoveryApi.getItemDetail(params.id!);

      const listingId = String(formData.get("listingId") ?? "").trim();
      const priceAmount = normalizeMoneyAmount(formData.get("priceAmount"), {
        invalidMessage: t("discovery.routes.itemDetail.validation.price.required"),
      });
      const quantityCap = parsePositiveQuantity(formData.get("quantityCap"));

      if (listingId) {
        await requireActorFromAuthApi({
          request,
          permission: "listings.manage",
        });
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
      const selectedOptions = parseSelectedOptions(formData.get("selectedOptions"));
      const productId = String(formData.get("productId") ?? "").trim();
      const productSummary = String(formData.get("productSummary") ?? "").trim() || null;
      const actor = await resolveActorFromAuthApi({ request });

      if (!canUseAccountSellList(actor)) {
        const anonymousListingDraftOwnerId = ensureAnonymousListingDraftOwnerId(request);
        const draft = await marketplaceApi.createAnonymousListingDraftIntent(anonymousListingDraftOwnerId, {
          sourcePath: `/items/${item.slug || item.catalog_item_id}?market=sell`,
          catalogItemId: item.catalog_item_id,
          productId,
          selectedOptions,
          productSummary,
          priceAmount,
          quantityCap,
        });
        const response = redirect(buildRegisterToClaimListingDraftHref(draft.intent_id));
        appendAnonymousListingDraftCookie(response.headers, anonymousListingDraftOwnerId, request);
        return response;
      }

      await requireActorFromAuthApi({
        request,
        permission: "listings.manage",
      });
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
                selectedOptions,
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
      initialSelectedListingId={data.initialSelectedListingId}
      initialSelectedOfferId={data.initialSelectedOfferId}
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
                  selectedListingSource={context.selectedListingSource}
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
                  selectedOfferSource={context.selectedOfferSource}
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
                  allowDraftWithoutShipFromSetup={data.canUseGuestListingDraft}
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
                  selectedOfferSource={context.selectedOfferSource}
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
                  canSelectListingAction={Boolean(context.selectedProductId)}
                  canSelectProductSellListAction={Boolean(context.selectedProductId)}
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
                    context.selectedProductId ? (
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
                    data.canUseListingFeatures || data.canUseGuestListingDraft
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
