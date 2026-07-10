import { t } from "@chase-sets/localization";
import { DiscoveryApiError } from "../../request-support/api-client";
import type { DiscoveryItemDetail } from "../../client-support/contracts";
import { buildDiscoveryProductAssetImage, selectDiscoveryProductAssetUrl } from "../../client-support/product-assets";
import {
  createMarketplaceRequestApiClient,
  type MarketplacePublicStandardTermsPreview,
} from "@chase-sets/marketplace/server";

export const MARKETPLACE_DESCRIPTION = t("discovery.routes.itemDetail.browse.the.chase.sets.marketplace.with");
export const LISTING_STOCK_LOCATION_NAME = "Listing stock";
export const LISTING_STOCK_LOCATION_DESCRIPTION = "Auto-managed stock backing standard marketplace listings.";
export const LISTING_STOCK_SHIP_FROM_CODE = "LISTING-STOCK";
export type ListingSetupLoadState = "not-applicable" | "ready" | "missing" | "fresh-write-recovering" | "load-failed";

export const EMPTY_ITEM_DETAIL_RESULT = {
  item: null,
  similarItems: [],
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
  listingSetupLoadState: "not-applicable" as const,
  listingSetupLoadError: null,
  canonicalUrl: null,
  productAlertClaimError: null,
} as const;

export function selectItemImageUrl(
  item: Partial<Pick<DiscoveryItemDetail, "image_urls" | "product_asset_sets" | "image_fallback">>,
  role: "thumbnail" | "catalog-detail" = "catalog-detail",
): string | null {
  return selectItemImage(item, role).src;
}

export function selectItemImage(
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

export function buildRegisterToSellHref(request: Request) {
  const url = new URL(request.url);
  const returnTo = `${url.pathname}${url.search}`;

  return `/register?returnTo=${encodeURIComponent(returnTo)}`;
}

export function buildRegisterToClaimListingDraftHref(intentId: string) {
  const returnTo = `/account/listings?claimListingIntent=${encodeURIComponent(intentId)}`;
  return `/register?returnTo=${encodeURIComponent(returnTo)}`;
}

export function buildRegisterToClaimProductAlertHref(itemSlugOrId: string, intentId: string) {
  const returnTo = `/items/${encodeURIComponent(itemSlugOrId)}?market=watch&claimProductAlertIntent=${encodeURIComponent(
    intentId,
  )}`;
  return `/register?returnTo=${encodeURIComponent(returnTo)}`;
}

export function productAlertClaimErrorMessage(error: unknown) {
  if (error instanceof DiscoveryApiError) {
    const body = error.body as { error?: { message?: unknown } } | null;
    const message = body?.error?.message;
    return typeof message === "string" ? message : t("discovery.routes.itemDetail.product.alert.claim.failed");
  }

  return error instanceof Error ? error.message : t("discovery.routes.itemDetail.product.alert.claim.failed");
}

export function canUseAccountSellList(actor: { permissions: readonly string[] } | null | undefined) {
  return Boolean(actor && !actor.permissions.includes("guest-checkout.manage"));
}

export async function attachPublicStandardOfferTerms(
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

export function hasInitialSelectedOptionFilters(searchParams: URLSearchParams) {
  return [...searchParams.entries()].some(([key, value]) => key.startsWith("dimension.") && value.trim().length > 0);
}
