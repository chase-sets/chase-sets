import { t } from "@chase-sets/localization";
import { redirect } from "react-router";
import { navigateAfterWriteWithPlatformPostWriteToken } from "@chase-sets/platform-runtime/post-write-tokens";
import type { DiscoveryItemDetail } from "../../client-support/contracts";
import {
  ACCOUNT_SELL_LIST_ADD_LINE_HANDOFF,
  appendAnonymousSellListCookie,
  createCheckoutRequestApiClient,
  ensureAnonymousSellListId,
} from "@chase-sets/checkout/server";

export function parseSelectedOptions(value: FormDataEntryValue | null) {
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

export function parsePositiveQuantity(value: FormDataEntryValue | null) {
  const normalized = String(value ?? "").trim();
  const quantity = Number(normalized);

  if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(quantity) || quantity < 1) {
    throw new Error(t("discovery.routes.itemDetail.validation.quantity.required"));
  }

  return quantity;
}

export function normalizeMoneyAmount(
  value: FormDataEntryValue | null,
  options: Readonly<{
    allowZero?: boolean;
    optional: true;
    invalidMessage: string;
  }>,
): string | null;
export function normalizeMoneyAmount(
  value: FormDataEntryValue | null,
  options: Readonly<{
    allowZero?: boolean;
    optional?: false;
    invalidMessage: string;
  }>,
): string;
export function normalizeMoneyAmount(
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

export function getListingAvailableQuantity(listing: DiscoveryItemDetail["market_listings"][number]) {
  const visibleQuantity = Number(listing.visible_quantity);
  const quantityCap = Number(listing.quantity_cap);

  if (Number.isFinite(visibleQuantity)) {
    return visibleQuantity;
  }

  return Number.isFinite(quantityCap) ? quantityCap : 0;
}

export function findSelectedListingForAction(item: DiscoveryItemDetail, listingId: string) {
  const normalizedListingId = listingId.trim();
  const listing = item.market_listings.find((candidate) => candidate.listing_id === normalizedListingId);

  if (!normalizedListingId || !listing || listing.status !== "active" || getListingAvailableQuantity(listing) < 1) {
    throw new Error(t("discovery.routes.itemDetail.validation.selected.listing.unavailable"));
  }

  return listing;
}

export function assertSelectedListingQuantityAvailable(
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

export function getPublicSelectedOfferForSellList(
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

export function selectedOfferSellListLineFromPublicOffer(
  item: DiscoveryItemDetail,
  offer: DiscoveryItemDetail["offer_demand_matches"][number],
) {
  return {
    lineType: "selected-offer" as const,
    offerId: offer.offer_id,
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
    fallbackMode: "none" as const,
    minimumListingPriceAmount: null,
  };
}

export async function saveGuestSelectedOfferToSellList(
  request: Request,
  checkoutApi: ReturnType<typeof createCheckoutRequestApiClient>,
  item: DiscoveryItemDetail,
  offerId: string,
) {
  const offer = getPublicSelectedOfferForSellList(item, offerId);
  const anonymousSellListId = ensureAnonymousSellListId(request);
  const result = await checkoutApi.addGuestSellListLine(
    anonymousSellListId,
    selectedOfferSellListLineFromPublicOffer(item, offer),
  );
  const response = redirect(
    await navigateAfterWriteWithPlatformPostWriteToken(result, "/account/sell-list", {
      handoff: ACCOUNT_SELL_LIST_ADD_LINE_HANDOFF,
    }),
  );
  appendAnonymousSellListCookie(response.headers, anonymousSellListId, request);
  return response;
}

export function shipFromAddressFromForm(formData: FormData) {
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
