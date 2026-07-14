import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { readFreshWriteToken, readPostWriteHandoff, recoverFreshWriteReadError } from "@chase-sets/http/responses";
import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { resolvePlatformPostWriteRequest } from "@chase-sets/platform-runtime/post-write-tokens";
import { createDiscoveryRequestApiClient, DiscoveryApiError } from "../../request-support/api-client";
import {
  ensureAnonymousProductAlertOwnerId,
  readAnonymousProductAlertOwnerId,
} from "../../request-support/anonymous-product-alert";
import type {
  DiscoveryAccountOfferMatchWithTerms,
  DiscoveryItemDetail,
  DiscoverySellerInventoryItem,
  DiscoverySimilarItem,
} from "../../client-support/contracts";
import { createMarketplaceRequestApiClient } from "@chase-sets/marketplace/server";
import {
  attachPublicStandardOfferTerms,
  buildRegisterToSellHref,
  canUseAccountSellList,
  hasInitialSelectedOptionFilters,
  type ListingSetupLoadState,
  productAlertClaimErrorMessage,
  readExplicitMarketSelectionId,
  readInitialSelectedOptions,
} from "./support";
import { loadSavedListClaimPreparation } from "../saved-list-addition";

const SELECTED_SELLER_LISTING_HANDOFF_EXPECTATIONS = {
  "marketplace.listing.publish": "resource-present",
  "marketplace.listing.update": "resource-updated",
} as const;

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
  url.searchParams.delete("postWriteHandoff");
  url.searchParams.delete("postWriteToken");

  return new Request(url.toString(), {
    headers: request.headers,
    method: request.method,
  });
}

function isSelectedSellerListingFreshWriteRecovery(request: Request) {
  const receipt = readFreshWriteToken(request);
  if (!receipt?.sources.some((source) => source.sourceContextName === "marketplace")) {
    return false;
  }

  const handoff = readPostWriteHandoff(request);
  const expected =
    SELECTED_SELLER_LISTING_HANDOFF_EXPECTATIONS[
      handoff?.kind as keyof typeof SELECTED_SELLER_LISTING_HANDOFF_EXPECTATIONS
    ];
  return Boolean(handoff && expected === handoff.expectation && handoff.surface === "item-detail");
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
    !isSelectedSellerListingFreshWriteRecovery(request) ||
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

function attachSelectedSellerListingOverlay(
  item: DiscoveryItemDetail,
  selectedListing: DiscoveryItemDetail["market_listings"][number] | null,
): DiscoveryItemDetail {
  if (!selectedListing || item.market_listings.some((listing) => listing.listing_id === selectedListing.listing_id)) {
    return item;
  }

  return {
    ...item,
    market_listings: [...item.market_listings, selectedListing],
  };
}

async function loadSimilarItems(
  api: ReturnType<typeof createDiscoveryRequestApiClient>,
  catalogItemId: string,
): Promise<DiscoverySimilarItem[]> {
  try {
    return (await api.getSimilarItems(catalogItemId)).items;
  } catch {
    return [];
  }
}

async function loadItemDetailSellerOverlay(
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
    return await api.getItemDetailSellerOverlay(id, {
      selectedListingId: options.initialSelectedListingId,
    });
  } catch (error) {
    if (!canRecoverSelectedSellerListingRead(request, error, options)) {
      throw error;
    }

    return createDiscoveryRequestApiClient(requestWithoutFreshWriteToken(request)).getItemDetailSellerOverlay(id, {
      selectedListingId: options.initialSelectedListingId,
    });
  }
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const browserUrl = new URL(request.url);
  const resolvedRequest = await resolvePlatformPostWriteRequest(request);
  const api = createDiscoveryRequestApiClient(resolvedRequest);
  const marketplaceApi = createMarketplaceRequestApiClient(resolvedRequest);
  const id = params.id;
  const url = new URL(resolvedRequest.url);
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
      similarItems: [],
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
      savedListClaim: { preparation: null, error: null },
      listingSetupLoadState: "not-applicable" satisfies ListingSetupLoadState,
      listingSetupLoadError: null,
    };
  }

  try {
    const actor = await resolveActorFromAuthApi({ request: resolvedRequest });
    const canReviewAccountOfferMatches = Boolean(
      actor?.permissions.includes("offers.view") && actor.permissions.includes("listings.view"),
    );
    const canSellOnItem = Boolean(
      actor?.permissions.includes("listings.view") && actor.permissions.includes("listings.manage"),
    );
    const canUseGuestListingDraft = !canUseAccountSellList(actor);
    const canSubmitOffers = Boolean(actor);
    let item = await loadItemDetailForSelectedSellerListing(api, resolvedRequest, id, {
      actor,
      initialMarketIntent,
      initialSelectedListingId,
    });

    if (item.slug && id !== item.slug) {
      throw redirect(`/items/${item.slug}${browserUrl.search}`, { status: 301 });
    }

    const similarItemsPromise = loadSimilarItems(api, item.catalog_item_id);

    let productAlertClaimError: string | null = null;
    const savedListClaimPromise = loadSavedListClaimPreparation(request, (product) => product.productId);

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

    let accountOfferMatches: DiscoveryAccountOfferMatchWithTerms[] = [];
    let sellerInventoryItems: DiscoverySellerInventoryItem[] = [];
    let hasListingStockLocation = false;
    let listingSetupLoadState: ListingSetupLoadState = "not-applicable";
    let listingSetupLoadError: string | null = null;

    if (canReviewAccountOfferMatches || canSellOnItem) {
      try {
        const overlay = await loadItemDetailSellerOverlay(api, resolvedRequest, item.slug || item.catalog_item_id, {
          actor,
          initialMarketIntent,
          initialSelectedListingId,
        });

        accountOfferMatches = canReviewAccountOfferMatches ? overlay.accountOfferMatches : [];
        if (canSellOnItem) {
          sellerInventoryItems = overlay.sellerInventoryItems;
          hasListingStockLocation = overlay.hasListingStockLocation;
          listingSetupLoadState = hasListingStockLocation ? "ready" : "missing";
          item = attachSelectedSellerListingOverlay(item, overlay.selectedSellerListing);
        }
      } catch (error) {
        accountOfferMatches = [];
        sellerInventoryItems = [];

        if (canSellOnItem) {
          const recovery = recoverFreshWriteReadError({
            request: resolvedRequest,
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
            listingSetupLoadState = "load-failed";
            listingSetupLoadError =
              error instanceof Error ? error.message : t("discovery.routes.itemDetail.ship.from.setup.required");
          } else {
            hasListingStockLocation = recovery.hasListingStockLocation;
            listingSetupLoadState = "fresh-write-recovering";
            listingSetupLoadError = recovery.listingSetupLoadError;
          }
        }
      }
    }

    return {
      item,
      similarItems: await similarItemsPromise,
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
      savedListClaim: await savedListClaimPromise,
      listingSetupLoadState,
      listingSetupLoadError,
      canonicalUrl: new URL(`/items/${item.slug || item.catalog_item_id}`, browserUrl.origin).toString(),
    };
  } catch (error) {
    if (error instanceof Response) {
      throw error;
    }

    if (error instanceof DiscoveryApiError) {
      return {
        item: null,
        similarItems: [],
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
        savedListClaim: { preparation: null, error: null },
        listingSetupLoadState: "not-applicable" satisfies ListingSetupLoadState,
        listingSetupLoadError: null,
        error: error.message,
      };
    }

    return {
      item: null,
      similarItems: [],
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
      savedListClaim: { preparation: null, error: null },
      listingSetupLoadState: "not-applicable" satisfies ListingSetupLoadState,
      listingSetupLoadError: null,
      error: error instanceof Error ? error.message : t("discovery.routes.itemDetail.item.not.found"),
    };
  }
}
