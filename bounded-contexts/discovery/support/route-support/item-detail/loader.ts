import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { loadFreshlyWrittenResource, recoverFreshWriteReadError } from "@chase-sets/http/responses";
import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { createDiscoveryRequestApiClient, DiscoveryApiError } from "../../request-support/api-client";
import {
  ensureAnonymousProductAlertOwnerId,
  readAnonymousProductAlertOwnerId,
} from "../../request-support/anonymous-product-alert";
import type {
  DiscoveryAccountOfferMatch,
  DiscoveryItemDetail,
  DiscoveryMarketListing,
  DiscoverySellerInventoryItem,
} from "../../client-support/contracts";
import {
  createMarketplaceRequestApiClient,
  type MarketplaceListingDetail,
  type MarketplaceListingInventoryItemOption,
  type MarketplaceListingTermsPreview,
} from "@chase-sets/marketplace/server";
import { createInventoryRequestApiClient } from "@chase-sets/inventory/server";
import { createCheckoutRequestApiClient } from "@chase-sets/checkout/server";
import {
  attachPublicStandardOfferTerms,
  buildRegisterToSellHref,
  canUseAccountSellList,
  hasInitialSelectedOptionFilters,
  isListingStockLocation,
  productAlertClaimErrorMessage,
  readExplicitMarketSelectionId,
  readInitialSelectedOptions,
  toSellerInventoryItem,
} from "./support";

type DiscoveryOfferMatchWithTerms = DiscoveryAccountOfferMatch &
  Readonly<{
    acceptance_terms: MarketplaceListingTermsPreview | null;
  }>;

const SELLER_MANAGEMENT_LISTING_FALLBACK_STATUSES = new Set(["draft", "active", "paused"]);

function apiErrorStatus(error: unknown) {
  const status = (error as { status?: unknown })?.status;
  return typeof status === "number" ? status : null;
}

function apiErrorBody(error: unknown) {
  return typeof error === "object" && error !== null && "body" in error ? (error as { body: unknown }).body : null;
}

function apiErrorCode(error: unknown) {
  const body = apiErrorBody(error);
  const apiError = typeof body === "object" && body !== null && "error" in body ? body.error : null;
  const code = typeof apiError === "object" && apiError !== null ? (apiError as { code?: unknown }).code : null;
  return typeof code === "string" && code.trim() ? code : null;
}

function apiErrorMessage(error: unknown) {
  const body = apiErrorBody(error);
  const apiError = typeof body === "object" && body !== null && "error" in body ? body.error : null;
  const bodyMessage =
    typeof apiError === "object" && apiError !== null ? (apiError as { message?: unknown }).message : null;

  if (typeof bodyMessage === "string" && bodyMessage.trim()) {
    return bodyMessage;
  }

  return error instanceof Error ? error.message : null;
}

function isProjectionFreshnessTimeout(error: unknown) {
  return (
    apiErrorCode(error) === "projection_freshness_timeout" ||
    /projection read model did not catch up .*freshness timeout/i.test(apiErrorMessage(error) ?? "")
  );
}

function freshWriteRecoveryStatus(error: unknown) {
  const status = apiErrorStatus(error);
  return isProjectionFreshnessTimeout(error) && status !== 404 ? 503 : status;
}

function freshWriteRecoveryCode(error: unknown) {
  return apiErrorCode(error) ?? (isProjectionFreshnessTimeout(error) ? "projection_freshness_timeout" : null);
}

function requestWithoutFreshWriteToken(request: Request) {
  const url = new URL(request.url);
  url.searchParams.delete("afterWrite");

  return new Request(url.toString(), {
    headers: request.headers,
    method: request.method,
  });
}

function canRecoverSelectedSellerListingRead(
  request: Request,
  error: unknown,
  options: Readonly<{
    actor: Awaited<ReturnType<typeof resolveActorFromAuthApi>>;
    initialMarketIntent: "buy" | "sell" | "watch";
    initialSelectedListingId: string | null;
  }>,
) {
  if (
    options.initialMarketIntent !== "sell" ||
    !options.initialSelectedListingId ||
    !options.actor?.accountId ||
    !options.actor.permissions.includes("listings.view") ||
    !options.actor.permissions.includes("listings.manage")
  ) {
    return false;
  }

  return Boolean(
    recoverFreshWriteReadError({
      request,
      error,
      getStatus: freshWriteRecoveryStatus,
      getErrorCode: freshWriteRecoveryCode,
      getBody: apiErrorBody,
      recoverTransient: () => true,
    }),
  );
}

async function loadItemDetailForSelectedSellerListing(
  api: ReturnType<typeof createDiscoveryRequestApiClient>,
  request: Request,
  id: string,
  options: Readonly<{
    actor: Awaited<ReturnType<typeof resolveActorFromAuthApi>>;
    initialMarketIntent: "buy" | "sell" | "watch";
    initialSelectedListingId: string | null;
  }>,
) {
  try {
    return await api.getItemDetail(id);
  } catch (error) {
    if (!canRecoverSelectedSellerListingRead(request, error, options)) {
      throw error;
    }

    return createDiscoveryRequestApiClient(requestWithoutFreshWriteToken(request)).getItemDetail(id);
  }
}

function sellerListingFallbackFromMarketplace(
  item: DiscoveryItemDetail,
  listing: MarketplaceListingDetail,
): DiscoveryMarketListing | null {
  if (
    !SELLER_MANAGEMENT_LISTING_FALLBACK_STATUSES.has(listing.status) ||
    listing.catalog_catalog_item_id !== item.catalog_item_id ||
    !listing.listing_id ||
    !listing.product_id
  ) {
    return null;
  }

  return {
    listing_id: listing.listing_id,
    listing_slug: "",
    product_slug: "",
    account_id: listing.account_id,
    inventory_item_id: listing.inventory_item_id,
    catalog_catalog_item_id: listing.catalog_catalog_item_id,
    catalog_item_slug: item.slug || null,
    product_id: listing.product_id,
    item_title: listing.item_title,
    item_subtitle: listing.item_subtitle,
    selected_options: listing.selected_options,
    product_summary: listing.product_summary,
    storage_location_name: listing.storage_location_name,
    ship_from_code: listing.ship_from_code,
    price_amount: listing.price_amount,
    shipping_allowance_percentage_bps: listing.shipping_allowance_percentage_bps,
    quantity_cap: listing.quantity_cap,
    max_units_per_order: listing.max_units_per_order ?? null,
    max_units_per_day: listing.max_units_per_day ?? null,
    max_units_per_customer_account: listing.max_units_per_customer_account ?? null,
    status: listing.status,
    seller_listing_availability_status: "available",
    seller_listing_availability_reason_category: null,
    seller_listing_available_again_on: null,
    seller_display_name: null,
    seller_average_rating: null,
    seller_review_count: 0,
    google_shopping_structured_data_payload: null,
    visible_quantity: listing.quantity_cap,
    created_at: listing.created_at,
    updated_at: listing.updated_at,
  };
}

async function attachSelectedSellerListingFallback(
  item: DiscoveryItemDetail,
  options: Readonly<{
    request: Request;
    marketplaceApi: ReturnType<typeof createMarketplaceRequestApiClient>;
    actor: Awaited<ReturnType<typeof resolveActorFromAuthApi>>;
    initialMarketIntent: "buy" | "sell" | "watch";
    initialSelectedListingId: string | null;
    canSellOnItem: boolean;
  }>,
): Promise<DiscoveryItemDetail> {
  if (
    options.initialMarketIntent !== "sell" ||
    !options.initialSelectedListingId ||
    !options.actor?.accountId ||
    !options.canSellOnItem ||
    item.market_listings.some((listing) => listing.listing_id === options.initialSelectedListingId)
  ) {
    return item;
  }

  try {
    const selectedListingId = options.initialSelectedListingId;
    const loadSellerListing = () => options.marketplaceApi.getSellerListing(selectedListingId);
    let listing: MarketplaceListingDetail;

    try {
      listing = await loadFreshlyWrittenResource({
        request: options.request,
        isNotFound: (error) => apiErrorStatus(error) === 404,
        load: loadSellerListing,
      });
    } catch (error) {
      const canRecover = recoverFreshWriteReadError({
        request: options.request,
        error,
        getStatus: freshWriteRecoveryStatus,
        getErrorCode: freshWriteRecoveryCode,
        getBody: apiErrorBody,
        recoverTransient: () => true,
      });

      if (!canRecover) {
        throw error;
      }

      listing = await createMarketplaceRequestApiClient(
        requestWithoutFreshWriteToken(options.request),
      ).getSellerListing(selectedListingId);
    }

    const fallbackListing =
      listing.account_id === options.actor.accountId ? sellerListingFallbackFromMarketplace(item, listing) : null;

    if (!fallbackListing) {
      return item;
    }

    return {
      ...item,
      market_listings: [...item.market_listings, fallbackListing],
    };
  } catch {
    return item;
  }
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
  const claimProductAlertIntentId = url.searchParams.get("claimProductAlertIntent")?.trim() ?? "";
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
      productAlertClaimError: null,
      listingSetupLoadError: null,
    };
  }

  try {
    const actor = await resolveActorFromAuthApi({ request });
    const canReviewAccountOfferMatches = Boolean(
      actor?.permissions.includes("offers.view") && actor.permissions.includes("listings.view"),
    );
    const canSellOnItem = Boolean(
      actor?.permissions.includes("listings.view") && actor.permissions.includes("listings.manage"),
    );
    const canUseGuestListingDraft = !canUseAccountSellList(actor);
    const canSubmitOffers = Boolean(actor);
    let item = await loadItemDetailForSelectedSellerListing(api, request, id, {
      actor,
      initialMarketIntent,
      initialSelectedListingId,
    });

    if (item.slug && id !== item.slug) {
      throw redirect(`/items/${item.slug}${url.search}`, { status: 301 });
    }

    let productAlertClaimError: string | null = null;

    if (claimProductAlertIntentId) {
      const cleanClaimPath = `/items/${item.slug || item.catalog_item_id}?market=watch`;
      if (!actor) {
        productAlertClaimError = t("discovery.routes.itemDetail.sign.in.to.finish.product.alert");
      } else if (!actor.permissions.includes("accounts.view")) {
        productAlertClaimError = t("discovery.routes.itemDetail.account.cannot.create.product.alerts");
      } else {
        const anonymousOwnerId = readAnonymousProductAlertOwnerId(request);
        if (!anonymousOwnerId) {
          productAlertClaimError = t("discovery.features.productAlerts.api.route.anonymous.product.alert.required");
        } else {
          try {
            await api.claimAnonymousProductAlertIntent(anonymousOwnerId, claimProductAlertIntentId);
            throw redirect(`${cleanClaimPath}&productAlertCreated=1`);
          } catch (error) {
            if (error instanceof Response) {
              throw error;
            }

            productAlertClaimError = productAlertClaimErrorMessage(error);
          }
        }
      }
    }

    if (!canUseAccountSellList(actor)) {
      item = await attachPublicStandardOfferTerms(marketplaceApi, item);
    }

    let accountOfferMatches: DiscoveryOfferMatchWithTerms[] = [];
    let sellerInventoryItems: DiscoverySellerInventoryItem[] = [];
    let hasListingStockLocation = false;
    let listingSetupLoadError: string | null = null;

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
        const items = await marketplaceApi.listSellerListingInventory(
          `limit=100&offset=0&catalogItemId=${encodeURIComponent(item.catalog_item_id)}`,
        );
        sellerInventoryItems = (items.items as MarketplaceListingInventoryItemOption[]).map(toSellerInventoryItem);
      } catch {
        sellerInventoryItems = [];
      }

      try {
        const storageLocations = await loadFreshlyWrittenResource({
          request,
          load: () => inventoryApi.listStorageLocations("limit=100&offset=0"),
          isNotFound: (error) => apiErrorStatus(error) === 404,
        });
        hasListingStockLocation = storageLocations.items.some(isListingStockLocation);
      } catch (error) {
        const recovery = recoverFreshWriteReadError({
          request,
          error,
          getStatus: freshWriteRecoveryStatus,
          getErrorCode: freshWriteRecoveryCode,
          getBody: apiErrorBody,
          recoverTransient: () => ({
            hasListingStockLocation: false,
            listingSetupLoadError: t("discovery.routes.itemDetail.ship.from.setup.pending.fresh.write"),
          }),
        });
        if (!recovery) {
          listingSetupLoadError =
            error instanceof Error ? error.message : t("discovery.routes.itemDetail.ship.from.setup.required");
        } else {
          hasListingStockLocation = recovery.hasListingStockLocation;
          listingSetupLoadError = recovery.listingSetupLoadError;
        }
      }
    }

    item = await attachSelectedSellerListingFallback(item, {
      request,
      marketplaceApi,
      actor,
      initialMarketIntent,
      initialSelectedListingId,
      canSellOnItem,
    });

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
      productAlertClaimError,
      listingSetupLoadError,
      canonicalUrl: new URL(`/items/${item.slug || item.catalog_item_id}`, new URL(request.url).origin).toString(),
    };
  } catch (error) {
    if (error instanceof Response) {
      throw error;
    }

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
        productAlertClaimError: null,
        listingSetupLoadError: null,
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
      productAlertClaimError: null,
      listingSetupLoadError: null,
      error: error instanceof Error ? error.message : t("discovery.routes.itemDetail.item.not.found"),
    };
  }
}
