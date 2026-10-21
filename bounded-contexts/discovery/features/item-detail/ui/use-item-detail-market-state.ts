import { useEffect, useState } from "react";
import type {
  DiscoveryItemDetail,
  DiscoveryMarketListing,
  DiscoveryOffer,
} from "../../../support/client-support/contracts";
import { useMarketSelectionKeeper } from "../../../support/ui-support/entry-attempt-key";
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
  // The URL selection the page loaded with; a realtime patch or revalidation keeps it.
  const urlSelectionKey = JSON.stringify([
    initialMarketIntent,
    initialSelectedListingId,
    initialSelectedOfferId,
    initialSelectedOptions,
    hasInitialSelectedOptionFilters,
  ]);
  const selectionKeeper = useMarketSelectionKeeper();
  const [keptSelection] = useState(() => selectionKeeper?.selectionFor(urlSelectionKey) ?? null);
  const [selections, setSelections] = useState<Record<string, string>>(() =>
    keptSelection
      ? getInitialSelections(data, initialMarketIntent, keptSelection.options, true)
      : getInitialSelections(
          data,
          initialMarketIntent,
          initialSelectedOptions,
          hasInitialSelectedOptionFilters,
          initialSelectedListingId,
          initialSelectedOfferId,
        ),
  );
  const [selectedListingId, setSelectedListingId] = useState<string | null>(
    keptSelection ? keptSelection.listingId : initialSelectedListingId,
  );
  const [selectedOfferId, setSelectedOfferId] = useState<string | null>(
    keptSelection ? keptSelection.offerId : initialSelectedOfferId,
  );
  const [marketIntent, setMarketIntent] = useState<MarketIntent>(initialMarketIntent);
  const [activeMobileCommerce, setActiveMobileCommerce] = useState<"buy" | "sell" | "watch" | null>(null);
  const [marketBookTab, setMarketBookTab] = useState<MarketBookTab>(
    initialMarketIntent === "sell" ? "offers" : "listings",
  );
  const [appliedUrlSelectionKey, setAppliedUrlSelectionKey] = useState(urlSelectionKey);
  const [appliedData, setAppliedData] = useState(data);
  const urlSelectionChanged = appliedUrlSelectionKey !== urlSelectionKey;

  // Only a navigation to another URL selection resets the buyer's choices.
  if (urlSelectionChanged) {
    setAppliedUrlSelectionKey(urlSelectionKey);
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
  }

  // A navigation, realtime patch or revalidation resets the market tabs and closes the mobile commerce panel.
  if (urlSelectionChanged || appliedData !== data) {
    setAppliedData(data);
    setMarketIntent(initialMarketIntent);
    setMarketBookTab(initialMarketIntent === "sell" ? "offers" : "listings");
    setActiveMobileCommerce(null);
  }

  // Kept while rendering, so a Buy form below posts the choices this render shows.
  selectionKeeper?.keepSelection(urlSelectionKey, {
    listingId: selectedListingId,
    offerId: selectedOfferId,
    options: Object.entries(selections).map(([dimensionId, optionId]) => ({ dimensionId, optionId })),
  });

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
