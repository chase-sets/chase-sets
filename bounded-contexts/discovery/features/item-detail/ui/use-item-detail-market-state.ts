import { useEffect, useState } from "react";
import type {
  DiscoveryItemDetail,
  DiscoveryMarketListing,
  DiscoveryOffer,
} from "../../../support/client-support/contracts";
import { trackItemDetailRailEvent } from "./item-detail-rail-analytics";
import { normalizeProductSearchOptionsForSchema } from "../domain/product-resolution";
import {
  applyOptionFilter,
  getInitialSelections,
  readExplicitSelectionId,
  readMarketIntentFromSearch,
  selectionsFromListing,
  updateExplicitSelectionUrl,
  type MarketBookTab,
  type MarketIntent,
} from "../domain/item-detail-market";

type ItemDetailMarketStateArgs = {
  data: DiscoveryItemDetail;
  viewerAccountId: string | null;
  initialMarketIntent: MarketIntent;
  initialSelectedListingId: string | null;
  initialSelectedOfferId: string | null;
  initialSelectedOptions: readonly { dimensionId: string; optionId: string }[];
  hasInitialSelectedOptionFilters: boolean;
};

export function useItemDetailMarketState({
  data,
  viewerAccountId,
  initialMarketIntent,
  initialSelectedListingId,
  initialSelectedOfferId,
  initialSelectedOptions,
  hasInitialSelectedOptionFilters,
}: ItemDetailMarketStateArgs) {
  const initialSelectedOptionsKey = JSON.stringify(initialSelectedOptions);
  const [selections, setSelections] = useState<Record<string, string>>(() =>
    getInitialSelections(
      data,
      initialMarketIntent,
      initialSelectedOptions,
      hasInitialSelectedOptionFilters,
      initialSelectedListingId,
      initialSelectedOfferId,
    ),
  );
  const [selectedListingId, setSelectedListingId] = useState<string | null>(initialSelectedListingId);
  const [selectedOfferId, setSelectedOfferId] = useState<string | null>(initialSelectedOfferId);
  const [marketIntent, setMarketIntent] = useState<MarketIntent>(initialMarketIntent);
  const [activeMobileCommerce, setActiveMobileCommerce] = useState<"buy" | "sell" | "watch" | null>(null);
  const [marketBookTab, setMarketBookTab] = useState<MarketBookTab>(
    initialMarketIntent === "sell" ? "offers" : "listings",
  );

  useEffect(() => {
    setSelections(
      getInitialSelections(
        data,
        initialMarketIntent,
        initialSelectedOptions,
        hasInitialSelectedOptionFilters,
        initialSelectedListingId,
        initialSelectedOfferId,
      ),
    );
    setSelectedListingId(initialSelectedListingId);
    setSelectedOfferId(initialSelectedOfferId);
    setMarketIntent(initialMarketIntent);
    setMarketBookTab(initialMarketIntent === "sell" ? "offers" : "listings");
    setActiveMobileCommerce(null);
  }, [
    data,
    data.catalog_item_id,
    initialMarketIntent,
    initialSelectedListingId,
    initialSelectedOfferId,
    initialSelectedOptionsKey,
    hasInitialSelectedOptionFilters,
  ]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const applyUrlState = () => {
      const url = new URL(window.location.href);
      const nextMarketIntent = readMarketIntentFromSearch(url.searchParams);
      const nextSelectedListingId = readExplicitSelectionId(url.searchParams, "listing");
      const nextSelectedOfferId = readExplicitSelectionId(url.searchParams, "offer");
      const selectedListingEntry = nextSelectedListingId
        ? data.market_listings.find(
            (listing) =>
              listing.catalog_catalog_item_id === data.catalog_item_id && listing.listing_id === nextSelectedListingId,
          )
        : null;
      const selectedOfferEntry = nextSelectedOfferId
        ? data.offer_demand_matches.find(
            (offer) => offer.catalog_catalog_item_id === data.catalog_item_id && offer.offer_id === nextSelectedOfferId,
          )
        : null;
      const explicitEntry =
        nextMarketIntent === "sell"
          ? (selectedOfferEntry ?? selectedListingEntry)
          : (selectedListingEntry ?? selectedOfferEntry);

      setMarketIntent(nextMarketIntent);
      setMarketBookTab(nextMarketIntent === "sell" ? "offers" : "listings");
      setSelectedListingId(nextSelectedListingId);
      setSelectedOfferId(nextSelectedOfferId);
      setSelections(
        data.product_schema && explicitEntry
          ? normalizeProductSearchOptionsForSchema(data.product_schema, selectionsFromListing(explicitEntry))
          : getInitialSelections(
              data,
              nextMarketIntent,
              initialSelectedOptions,
              hasInitialSelectedOptionFilters,
              nextSelectedListingId,
              nextSelectedOfferId,
            ),
      );
    };

    window.addEventListener("popstate", applyUrlState);

    return () => window.removeEventListener("popstate", applyUrlState);
  }, [data, initialSelectedOptionsKey, hasInitialSelectedOptionFilters]);

  const clearExplicitMarketSelection = (mode: "push" | "replace" = "push") => {
    setSelectedListingId(null);
    setSelectedOfferId(null);
    updateExplicitSelectionUrl({ listingId: null, offerId: null }, mode);
  };
  const clearProductFilters = () => {
    clearExplicitMarketSelection();
    setSelections({});
  };
  const handleProductSelectionChange = (dimensionId: string, optionId: string) => {
    clearExplicitMarketSelection();
    setSelections((current) =>
      normalizeProductSearchOptionsForSchema(data.product_schema!, applyOptionFilter(current, dimensionId, optionId)),
    );
  };
  const selectMarketListing = (listing: DiscoveryMarketListing) => {
    setSelectedListingId(listing.listing_id);
    setSelectedOfferId(null);
    updateExplicitSelectionUrl({ listingId: listing.listing_id, offerId: null });
    trackItemDetailRailEvent("workflow_selected", {
      intent: "buy",
      workflow: "selected_listing",
      selection: "explicit",
      viewer: viewerAccountId ? "signed_in" : "guest",
      surface: "market_book",
    });

    if (data.product_schema) {
      setSelections(normalizeProductSearchOptionsForSchema(data.product_schema, selectionsFromListing(listing)));
    }
  };
  const selectMarketOffer = (offer: DiscoveryOffer) => {
    setSelectedOfferId(offer.offer_id);
    setSelectedListingId(null);
    updateExplicitSelectionUrl({ listingId: null, offerId: offer.offer_id });
    trackItemDetailRailEvent("workflow_selected", {
      intent: "sell",
      workflow: "selected_offer",
      selection: "explicit",
      viewer: viewerAccountId ? "signed_in" : "guest",
      surface: "market_book",
    });

    if (data.product_schema) {
      setSelections(normalizeProductSearchOptionsForSchema(data.product_schema, selectionsFromListing(offer)));
    }
  };

  return {
    selections,
    selectedListingId,
    selectedOfferId,
    marketIntent,
    setMarketIntent,
    activeMobileCommerce,
    setActiveMobileCommerce,
    marketBookTab,
    setMarketBookTab,
    clearProductFilters,
    handleProductSelectionChange,
    selectMarketListing,
    selectMarketOffer,
  };
}
