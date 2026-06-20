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
import type { DiscoveryAccountOfferMatch, DiscoverySellerInventoryItem } from "../../client-support/contracts";
import {
  createMarketplaceRequestApiClient,
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
  LISTING_STOCK_LOCATION_NAME,
  productAlertClaimErrorMessage,
  readExplicitMarketSelectionId,
  readInitialSelectedOptions,
  toSellerInventoryItem,
} from "./support";

type DiscoveryOfferMatchWithTerms = DiscoveryAccountOfferMatch &
  Readonly<{
    acceptance_terms: MarketplaceListingTermsPreview | null;
  }>;

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
    let item = await api.getItemDetail(id);
    if (item.slug && id !== item.slug) {
      throw redirect(`/items/${item.slug}${url.search}`, { status: 301 });
    }

    const actor = await resolveActorFromAuthApi({ request });
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
        hasListingStockLocation = storageLocations.items.some(
          (location) => location.name === LISTING_STOCK_LOCATION_NAME,
        );
      } catch (error) {
        const recovery = recoverFreshWriteReadError({
          request,
          error,
          getStatus: apiErrorStatus,
          getErrorCode: apiErrorCode,
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
