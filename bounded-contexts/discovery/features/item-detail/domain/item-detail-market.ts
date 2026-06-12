import { t } from "@chase-sets/localization";
import type {
  DiscoveryItemDetail,
  DiscoveryMarketListing,
  DiscoveryOffer,
  DiscoveryAccountOfferMatch,
} from "../../../support/client-support/contracts";
import { getOrderedActiveDimensions, normalizeProductSearchOptionsForSchema } from "./product-resolution";
import { formatMoney } from "./item-detail-formatting";

export type {
  ExplicitSelectionParam,
  MarketBookTab,
  MarketIntent,
  MarketSelectionSource,
} from "./item-detail-url-state";
export {
  itemDetailRailAnalyticsSelection,
  itemDetailRailAnalyticsWorkflow,
  readExplicitSelectionId,
  readMarketIntentFromSearch,
  updateExplicitSelectionUrl,
  updateMarketIntentUrl,
} from "./item-detail-url-state";
export {
  formatBuyerCount,
  formatCompactProductSummary,
  formatFieldValue,
  formatListingAvailability,
  formatListingCount,
  formatListingPurchaseLimit,
  formatMoney,
  formatOfferCount,
  formatOfferRequestedQuantity,
  formatReferenceAttributes,
  formatRelationshipType,
  formatSellerCount,
  formatUpdatedAt,
  getListingAvailableQuantity,
  parseRating,
} from "./item-detail-formatting";

function toSafeNumber(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

export function isLowestPriceListing(
  listing: DiscoveryMarketListing,
  listings: readonly DiscoveryMarketListing[],
): boolean {
  const listingPrice = toPriceNumber(listing.price_amount);
  const lowestPrice = toPriceNumber(getLowestPrice(listings) ?? "");

  return listingPrice !== null && lowestPrice !== null && listingPrice === lowestPrice;
}

export function isBestOffer(offer: DiscoveryOffer, offers: readonly DiscoveryOffer[]): boolean {
  const offerPrice = toPriceNumber(offer.price_amount);
  const highestPrice = toPriceNumber(getHighestOfferPrice(offers) ?? "");

  return offerPrice !== null && highestPrice !== null && offerPrice === highestPrice;
}

export function matchesSelectedOptions(
  listing: Readonly<{
    selected_options: readonly { dimensionId: string; optionId: string }[];
  }>,
  selections: Record<string, string>,
) {
  const selectedEntries = Object.entries(selections);

  if (selectedEntries.length === 0) {
    return true;
  }

  return selectedEntries.every(([dimensionId, optionId]) =>
    listing.selected_options.some((entry) => entry.dimensionId === dimensionId && entry.optionId === optionId),
  );
}

export function applyOptionFilter(selections: Record<string, string>, dimensionId: string, optionId: string) {
  const nextSelections = { ...selections };

  if (optionId) {
    nextSelections[dimensionId] = optionId;
  } else {
    delete nextSelections[dimensionId];
  }

  return nextSelections;
}

export function selectionsFromListing(
  listing:
    | Readonly<{
        selected_options: readonly { dimensionId: string; optionId: string }[];
      }>
    | undefined,
): Record<string, string> {
  if (!listing) {
    return {};
  }

  return Object.fromEntries(listing.selected_options.map((entry) => [entry.dimensionId, entry.optionId]));
}

export function getInitialSelections(
  data: DiscoveryItemDetail | null,
  marketIntent: "buy" | "sell" | "watch",
  initialSelectedOptions: readonly { dimensionId: string; optionId: string }[] = [],
  hasInitialSelectedOptionFilters = false,
  initialSelectedListingId: string | null = null,
  initialSelectedOfferId: string | null = null,
): Record<string, string> {
  if (!data?.product_schema) {
    return {};
  }

  if (hasInitialSelectedOptionFilters || initialSelectedOptions.length > 0) {
    return normalizeProductSearchOptionsForSchema(
      data.product_schema,
      Object.fromEntries(initialSelectedOptions.map((entry) => [entry.dimensionId, entry.optionId])),
    );
  }

  const explicitListing = initialSelectedListingId
    ? data.market_listings.find((listing) => listing.listing_id === initialSelectedListingId)
    : null;
  const explicitOffer = initialSelectedOfferId
    ? data.offer_demand_matches.find((offer) => offer.offer_id === initialSelectedOfferId)
    : null;
  const explicitEntry =
    marketIntent === "sell" ? (explicitOffer ?? explicitListing) : (explicitListing ?? explicitOffer);

  if (explicitEntry) {
    return normalizeProductSearchOptionsForSchema(data.product_schema, selectionsFromListing(explicitEntry));
  }

  const sourceEntries = marketIntent === "sell" ? data.offer_demand_matches : data.market_listings;
  const selections = sourceEntries.length === 1 ? selectionsFromListing(sourceEntries[0]) : {};

  return normalizeProductSearchOptionsForSchema(data.product_schema, selections);
}

export function getLowestPrice(listings: readonly DiscoveryMarketListing[]): string | null {
  return listings.reduce<string | null>((lowest, listing) => {
    if (lowest === null) {
      return listing.price_amount;
    }

    return Number.parseFloat(listing.price_amount) < Number.parseFloat(lowest) ? listing.price_amount : lowest;
  }, null);
}

export function getHighestOfferPrice(offers: readonly DiscoveryOffer[]): string | null {
  return offers.reduce<string | null>((highest, offer) => {
    if (highest === null) {
      return offer.price_amount;
    }

    return Number.parseFloat(offer.price_amount) > Number.parseFloat(highest) ? offer.price_amount : highest;
  }, null);
}

function toPriceNumber(value: string): number | null {
  const parsed = Number.parseFloat(value);

  return Number.isFinite(parsed) ? parsed : null;
}

function comparePriceValues(left: string, right: string, direction: "asc" | "desc"): number {
  const leftPrice = toPriceNumber(left);
  const rightPrice = toPriceNumber(right);

  if (leftPrice === null && rightPrice === null) {
    return 0;
  }

  if (leftPrice === null) {
    return 1;
  }

  if (rightPrice === null) {
    return -1;
  }

  return direction === "asc" ? leftPrice - rightPrice : rightPrice - leftPrice;
}

export function sortListingsByBuyerPrice(listings: readonly DiscoveryMarketListing[]): DiscoveryMarketListing[] {
  return [...listings].sort((left, right) => {
    const priceDelta = comparePriceValues(left.price_amount, right.price_amount, "asc");
    if (priceDelta !== 0) {
      return priceDelta;
    }

    return (
      new Date(left.created_at).getTime() - new Date(right.created_at).getTime() ||
      left.listing_id.localeCompare(right.listing_id)
    );
  });
}

export function sortOffersBySellerPrice(offers: readonly DiscoveryOffer[]): DiscoveryOffer[] {
  return [...offers].sort((left, right) => {
    const priceDelta = comparePriceValues(left.price_amount, right.price_amount, "desc");
    if (priceDelta !== 0) {
      return priceDelta;
    }

    const quantityDelta = right.quantity_requested - left.quantity_requested;
    if (quantityDelta !== 0) {
      return quantityDelta;
    }

    return (
      new Date(left.created_at).getTime() - new Date(right.created_at).getTime() ||
      left.offer_id.localeCompare(right.offer_id)
    );
  });
}

export function getBestOffer(offers: readonly DiscoveryOffer[]): DiscoveryOffer | null {
  return offers.find((offer) => offer.status === "submitted") ?? offers[0] ?? null;
}

export function getBestAccountOfferMatch(
  offers: readonly DiscoveryAccountOfferMatch[],
): DiscoveryAccountOfferMatch | null {
  return (
    sortAccountOfferMatchesForReview(offers.filter((offer) => offer.status === "submitted" && offer.can_fulfill))[0] ??
    null
  );
}

export function sortAccountOfferMatchesForReview(
  offers: readonly DiscoveryAccountOfferMatch[],
): DiscoveryAccountOfferMatch[] {
  return [...offers].sort((left, right) => {
    const fulfillableDelta = Number(right.can_fulfill) - Number(left.can_fulfill);
    if (fulfillableDelta !== 0) {
      return fulfillableDelta;
    }

    const priceDelta = Number.parseFloat(right.price_amount) - Number.parseFloat(left.price_amount);
    if (priceDelta !== 0) {
      return priceDelta;
    }

    const quantityDelta = right.quantity_requested - left.quantity_requested;
    if (quantityDelta !== 0) {
      return quantityDelta;
    }

    return (
      new Date(left.created_at).getTime() - new Date(right.created_at).getTime() ||
      left.offer_id.localeCompare(right.offer_id)
    );
  });
}

export function buildProductOptionSummaries({
  entries,
  mode,
  productSchema,
  selections,
}: {
  entries: readonly (DiscoveryMarketListing | DiscoveryOffer)[];
  mode: "buy" | "sell";
  productSchema: NonNullable<DiscoveryItemDetail["product_schema"]>;
  selections: Record<string, string>;
}): Record<string, Record<string, string>> {
  return Object.fromEntries(
    getOrderedActiveDimensions(productSchema, selections).map((dimension) => {
      const selectionsWithoutDimension = { ...selections };
      delete selectionsWithoutDimension[dimension.dimensionId];

      const matchingOtherSelections = entries.filter((entry) =>
        matchesSelectedOptions(entry, selectionsWithoutDimension),
      );

      return [
        dimension.dimensionId,
        Object.fromEntries(
          dimension.allowedOptions.map((option) => {
            const matchingOption = matchingOtherSelections.filter((listing) =>
              listing.selected_options.some(
                (entry) => entry.dimensionId === dimension.dimensionId && entry.optionId === option.optionId,
              ),
            );

            return [
              option.optionId,
              matchingOption.length > 0
                ? mode === "sell"
                  ? t("discovery.features.itemDetail.ui.itemDetailPage.offer.option.summary", {
                      count: matchingOption.reduce(
                        (sum, offer) =>
                          sum + ("quantity_requested" in offer ? toSafeNumber(offer.quantity_requested) : 0),
                        0,
                      ),
                      price: formatMoney(
                        getHighestOfferPrice(
                          matchingOption.filter((entry): entry is DiscoveryOffer => "quantity_requested" in entry),
                        ),
                      ),
                    })
                  : t("discovery.features.itemDetail.ui.itemDetailPage.option.summary", {
                      count: matchingOption.length,
                      price: formatMoney(
                        getLowestPrice(
                          matchingOption.filter((entry): entry is DiscoveryMarketListing => "listing_id" in entry),
                        ),
                      ),
                    })
                : t("discovery.features.itemDetail.ui.itemDetailPage.none"),
            ];
          }),
        ),
      ];
    }),
  );
}
