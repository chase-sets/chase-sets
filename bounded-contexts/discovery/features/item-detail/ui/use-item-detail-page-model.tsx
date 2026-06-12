import { formatLanguageCodeLabel, t } from "@chase-sets/localization";
import { useEffect, useState } from "react";
import { Badge, Banner, Inline, Stack } from "@chase-sets/design-system";
import type {
  DiscoveryItemDetail,
  DiscoveryMarketListing,
  DiscoveryOffer,
  DiscoveryAccountOfferMatch,
  DiscoveryReferenceRecordRef,
} from "../../../support/client-support/contracts";
import { discoveryAssetUrls } from "../../../support/client-support/assets";
import { uniqueDisplayValues } from "../../../support/item-support/unique-display-values";
import {
  createDiscoveryProductDescriptor,
  getOrderedActiveDimensions,
  isProductSelectionComplete,
  normalizeProductSearchOptionsForSchema,
  summarizeSelections,
} from "../domain/product-resolution";
import {
  applyOptionFilter,
  buildProductOptionSummaries,
  formatCompactProductSummary,
  formatListingAvailability,
  formatUpdatedAt,
  getBestAccountOfferMatch,
  getBestOffer,
  getInitialSelections,
  getListingAvailableQuantity,
  getLowestPrice,
  itemDetailRailAnalyticsSelection,
  itemDetailRailAnalyticsWorkflow,
  type MarketBookTab,
  type MarketIntent,
  type MarketSelectionSource,
  matchesSelectedOptions,
  readExplicitSelectionId,
  readMarketIntentFromSearch,
  selectionsFromListing,
  sortAccountOfferMatchesForReview,
  sortListingsByBuyerPrice,
  sortOffersBySellerPrice,
  updateExplicitSelectionUrl,
} from "../domain/item-detail-market";
import { buildReferenceDetailRows } from "./reference-detail-rows";
import { ReferenceValueCue } from "./item-detail-references";
import { trackItemDetailRailEvent } from "../../../support/ui-support/item-detail-rail-analytics";
import { buildItemDetailImages } from "./item-detail-images";
import { buildItemDetailPageView } from "./item-detail-page-view";
import type { ItemDetailCommerceSections, ItemDetailMarketplaceSectionContext } from "./item-detail-page-types";

export type LoadedItemDetailPageProps = {
  data: DiscoveryItemDetail;
  accountOfferMatches: readonly DiscoveryAccountOfferMatch[];
  viewerAccountId: string | null;
  initialMarketIntent: MarketIntent;
  initialSelectedListingId: string | null;
  initialSelectedOfferId: string | null;
  initialSelectedOptions: readonly { dimensionId: string; optionId: string }[];
  hasInitialSelectedOptionFilters: boolean;
  renderCommerce?: (context: ItemDetailMarketplaceSectionContext) => ItemDetailCommerceSections | null;
};

export function useItemDetailPageModel({
  data,
  accountOfferMatches,
  viewerAccountId,
  initialMarketIntent,
  initialSelectedListingId,
  initialSelectedOfferId,
  initialSelectedOptions,
  hasInitialSelectedOptionFilters,
  renderCommerce,
}: LoadedItemDetailPageProps) {
  const initialSelectedOptionsKey = JSON.stringify(initialSelectedOptions);
  const [selectedReference, setSelectedReference] = useState<DiscoveryReferenceRecordRef | null>(null);
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

  const images = buildItemDetailImages(data);
  const imageFallback = data.image_fallback ?? {
    url: discoveryAssetUrls.defaultProductImage,
    alt: t("discovery.features.itemDetail.ui.itemDetailPage.default.product.image"),
    usage: "permanent" as const,
    variants: {},
  };
  const explicitSelectedOptions = data.product_schema ? summarizeSelections(data.product_schema, selections) : [];
  const explicitSelectedProductOptions = data.product_schema
    ? getOrderedActiveDimensions(data.product_schema, selections)
        .map((dimension) => {
          const optionId = selections[dimension.dimensionId];

          if (!optionId) {
            return null;
          }

          return {
            dimensionId: dimension.dimensionId,
            optionId,
          };
        })
        .filter((selection): selection is { dimensionId: string; optionId: string } => selection !== null)
    : [];
  const explicitSelectedProductSummary =
    explicitSelectedOptions.length > 0
      ? explicitSelectedOptions.map((selection) => selection.optionLabel).join(" / ")
      : null;
  const suppressImplicitProductSelection = hasInitialSelectedOptionFilters && initialSelectedOptions.length === 0;
  const hasActiveFilters = Object.keys(selections).length > 0;
  const hasCompleteProductSelection = data.product_schema
    ? isProductSelectionComplete(data.product_schema, selections)
    : true;
  const itemMarketListings = data.market_listings.filter(
    (listing) => listing.catalog_catalog_item_id === data.catalog_item_id,
  );
  const itemOfferDemandMatches = (data.offer_demand_matches ?? []).filter(
    (offer) => offer.catalog_catalog_item_id === data.catalog_item_id,
  );

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

  const categories = [...new Map(data.categories.map((category) => [category.categoryId, category] as const)).values()];
  const tags = uniqueDisplayValues(data.tags);
  const buyableMarketListings = itemMarketListings.filter((listing) => getListingAvailableQuantity(listing) > 0);
  const visibleListings = sortListingsByBuyerPrice(
    buyableMarketListings.filter((listing) =>
      data.product_schema ? matchesSelectedOptions(listing, selections) : true,
    ),
  );
  const explicitSelectedListing = selectedListingId
    ? (visibleListings.find((listing) => listing.listing_id === selectedListingId) ?? null)
    : null;
  const selectedListing = explicitSelectedListing ?? visibleListings[0] ?? null;
  const selectedListingSource: MarketSelectionSource = explicitSelectedListing ? "explicit" : "implicit";
  const staleSelectedListingId = selectedListingId && !explicitSelectedListing ? selectedListingId : null;
  const singleMatchingListing =
    !hasCompleteProductSelection && visibleListings.length === 1 ? visibleListings[0] : null;
  const explicitSelectedProductId = hasCompleteProductSelection
    ? createDiscoveryProductDescriptor({
        catalogItemId: data.catalog_item_id,
        productSchema: data.product_schema,
        selection: explicitSelectedProductOptions,
      }).productId
    : null;
  const matchingOffers = sortOffersBySellerPrice(
    itemOfferDemandMatches.filter((offer) =>
      explicitSelectedProductId
        ? offer.product_id === explicitSelectedProductId
        : data.product_schema
          ? matchesSelectedOptions(offer, selections)
          : true,
    ),
  );
  const matchingAccountOfferMatches = sortAccountOfferMatchesForReview(
    accountOfferMatches
      .filter((offer) => offer.catalog_catalog_item_id === data.catalog_item_id)
      .filter((offer) =>
        explicitSelectedProductId
          ? offer.product_id === explicitSelectedProductId
          : data.product_schema
            ? matchesSelectedOptions(offer, selections)
            : true,
      ),
  );
  const bestOffer = getBestOffer(matchingOffers);
  const bestAccountOfferMatch = getBestAccountOfferMatch(matchingAccountOfferMatches);
  const defaultSellerOffer =
    marketIntent === "sell" && bestAccountOfferMatch
      ? (matchingOffers.find((offer) => offer.offer_id === bestAccountOfferMatch.offer_id) ?? null)
      : null;
  const explicitSelectedOffer = selectedOfferId
    ? (matchingOffers.find((offer) => offer.offer_id === selectedOfferId) ?? null)
    : null;
  const selectedOffer = explicitSelectedOffer ?? defaultSellerOffer ?? bestOffer ?? null;
  const selectedOfferSource: MarketSelectionSource = explicitSelectedOffer ? "explicit" : "implicit";
  const staleSelectedOfferId = selectedOfferId && !explicitSelectedOffer ? selectedOfferId : null;
  const selectedAccountOfferMatch = selectedOffer
    ? (matchingAccountOfferMatches.find((offer) => offer.offer_id === selectedOffer.offer_id) ??
      bestAccountOfferMatch ??
      null)
    : (bestAccountOfferMatch ?? null);
  const selectedProductId =
    explicitSelectedProductId ??
    (suppressImplicitProductSelection
      ? null
      : marketIntent === "sell"
        ? (selectedOffer?.product_id ?? null)
        : (selectedListing?.product_id ?? singleMatchingListing?.product_id ?? null));
  const selectedOfferForProduct = !suppressImplicitProductSelection && marketIntent === "sell" ? selectedOffer : null;
  const selectedListingForProduct =
    !suppressImplicitProductSelection && marketIntent !== "sell" ? selectedListing : null;
  const selectedProductOptions =
    hasCompleteProductSelection || (!selectedListingForProduct && !selectedOfferForProduct && !singleMatchingListing)
      ? explicitSelectedProductOptions
      : (selectedOfferForProduct?.selected_options ??
        selectedListingForProduct?.selected_options ??
        (suppressImplicitProductSelection ? null : singleMatchingListing?.selected_options) ??
        explicitSelectedProductOptions);
  const selectedProductSummary =
    explicitSelectedProductSummary ??
    selectedOfferForProduct?.product_summary ??
    selectedListingForProduct?.product_summary ??
    (suppressImplicitProductSelection ? null : singleMatchingListing?.product_summary) ??
    null;
  const bestListing = selectedProductId
    ? (visibleListings.find((listing) => listing.product_id === selectedProductId) ?? null)
    : null;
  const sellerCount = new Set(visibleListings.map((listing) => listing.account_id)).size;
  const buyerCount = new Set(matchingOffers.map((offer) => offer.buyer_account_id)).size;
  const selectedMarketSummary = {
    lowest_price_amount: getLowestPrice(visibleListings),
    active_listing_count: visibleListings.length,
    total_visible_quantity: visibleListings.reduce((sum, listing) => sum + getListingAvailableQuantity(listing), 0),
  };
  const optionSummaries = data.product_schema
    ? buildProductOptionSummaries({
        entries: marketIntent === "sell" ? itemOfferDemandMatches : buyableMarketListings,
        mode: marketIntent === "sell" ? "sell" : "buy",
        productSchema: data.product_schema,
        selections,
      })
    : {};
  const metadataItems = [
    {
      key: t("discovery.features.itemDetail.ui.itemDetailPage.language"),
      value: formatLanguageCodeLabel(data.language_code),
    },
    ...(categories.length > 0
      ? [
          {
            key: t("discovery.features.itemDetail.ui.itemDetailPage.categories"),
            value: categories.map((category) => category.name).join(", "),
          },
        ]
      : []),
    ...(tags.length > 0
      ? [
          {
            key: t("discovery.features.itemDetail.ui.itemDetailPage.tags"),
            value: (
              <Inline gap={1}>
                {tags.map((tag) => (
                  <Badge key={tag} tone="neutral">
                    {tag}
                  </Badge>
                ))}
              </Inline>
            ),
          },
        ]
      : []),
    {
      key: t("discovery.features.itemDetail.ui.itemDetailPage.last.updated"),
      value: formatUpdatedAt(data.updated_at),
    },
  ];
  const referenceDetailRows = buildReferenceDetailRows(data.field_values);
  const detailItems = [
    ...referenceDetailRows.map((row) => ({
      key: row.label,
      value: <ReferenceValueCue row={row} onSelectReference={setSelectedReference} />,
    })),
    ...metadataItems,
  ];
  const getProductSelectionDetails = (options: readonly { dimensionId: string; optionId: string }[]) =>
    data.product_schema && options.length > 0
      ? summarizeSelections(
          data.product_schema,
          Object.fromEntries(options.map((selection) => [selection.dimensionId, selection.optionId])),
        ).map((selection) => ({
          label: selection.dimensionName,
          value: selection.optionLabel,
        }))
      : [];
  const selectedProductSelectionDetails = getProductSelectionDetails(selectedProductOptions);
  const explicitSelectedProductSelectionDetails = getProductSelectionDetails(explicitSelectedProductOptions);
  const selectedListingAvailability = selectedListing ? formatListingAvailability(selectedListing) : null;
  const selectedListingProductSummary = selectedListing
    ? formatCompactProductSummary(
        selectedListing.product_summary,
        getProductSelectionDetails(selectedListing.selected_options),
        t("discovery.features.itemDetail.ui.itemDetailPage.standard"),
      )
    : null;
  const currentOptionSummary =
    explicitSelectedProductSummary ??
    (hasActiveFilters
      ? t("discovery.features.itemDetail.ui.itemDetailPage.filtered.active.listings")
      : t("discovery.features.itemDetail.ui.itemDetailPage.all.listings"));
  const marketplaceContext = {
    itemId: data.catalog_item_id,
    selectedProductId,
    itemTitle: data.title,
    itemSubtitle: data.subtitle,
    selectedProductOptions,
    selectedProductSelectionDetails,
    selectedProductSummary,
    visibleListings,
    visibleOffers: matchingOffers,
    visibleAccountOfferMatches: matchingAccountOfferMatches,
    selectedListing,
    selectedOffer,
    selectedAccountOfferMatch,
    selectedListingSource,
    selectedOfferSource,
    staleSelectedListingId,
    staleSelectedOfferId,
    bestListing,
    bestOffer,
    bestAccountOfferMatch,
  } satisfies ItemDetailMarketplaceSectionContext;
  const commerceSections = renderCommerce?.(marketplaceContext) ?? null;
  const staleSelectionBanner = staleSelectedListingId ? (
    <Banner
      tone="warning"
      title={t("discovery.features.itemDetail.ui.itemDetailPage.selected.listing.unavailable")}
      description={t("discovery.features.itemDetail.ui.itemDetailPage.selected.listing.unavailable.description")}
    />
  ) : staleSelectedOfferId ? (
    <Banner
      tone="warning"
      title={t("discovery.features.itemDetail.ui.itemDetailPage.selected.offer.unavailable")}
      description={t("discovery.features.itemDetail.ui.itemDetailPage.selected.offer.unavailable.description")}
    />
  ) : null;
  const commerceContent = commerceSections ? (
    marketIntent === "watch" && commerceSections.watch ? (
      commerceSections.watch
    ) : marketIntent === "sell" && commerceSections.sell ? (
      commerceSections.sell
    ) : commerceSections.offer ? (
      <Stack gap={4}>
        {commerceSections.buy}
        {commerceSections.offer}
      </Stack>
    ) : (
      commerceSections.buy
    )
  ) : null;
  const trackRailIntentSelected = (nextMarketIntent: MarketIntent, surface: string) => {
    const hasListing = Boolean(selectedListing);
    const hasOffer = Boolean(selectedOffer);

    trackItemDetailRailEvent("rail_intent_selected", {
      intent: nextMarketIntent,
      workflow: itemDetailRailAnalyticsWorkflow({
        intent: nextMarketIntent,
        hasListing,
        listingSource: selectedListingSource,
        hasOffer,
        offerSource: selectedOfferSource,
      }),
      selection: itemDetailRailAnalyticsSelection({
        intent: nextMarketIntent,
        hasListing,
        listingSource: selectedListingSource,
        hasOffer,
        offerSource: selectedOfferSource,
      }),
      viewer: viewerAccountId ? "signed_in" : "guest",
      surface,
    });
  };
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

  const {
    commerce,
    marketNote,
    marketSummaryPrice,
    marketSummaryFacts,
    mobileCommerceActionBar,
    mobileCommerceBottomSheet,
    productOptionSelector,
  } = buildItemDetailPageView({
    data,
    marketIntent,
    setMarketIntent,
    setMarketBookTab,
    activeMobileCommerce,
    setActiveMobileCommerce,
    selections,
    optionSummaries,
    onProductSelectionChange: handleProductSelectionChange,
    trackRailIntentSelected,
    commerceSections,
    commerceContent,
    hasActiveFilters,
    matchingOffers,
    buyerCount,
    sellerCount,
    selectedMarketSummary,
    selectedListing,
    selectedListingSource,
    selectedListingAvailability,
    selectedListingProductSummary,
    selectedOffer,
    selectedOfferSource,
    selectedProductId,
    currentOptionSummary,
    explicitSelectedProductSummary,
    explicitSelectedProductSelectionDetails,
  });

  return {
    data,
    viewerAccountId,
    images,
    imageFallback,
    marketIntent,
    marketBookTab,
    setMarketBookTab,
    hasActiveFilters,
    visibleListings,
    itemMarketListings,
    matchingOffers,
    itemOfferDemandMatches,
    selectedListing,
    selectedOffer,
    selectedProductId,
    detailItems,
    getProductSelectionDetails,
    clearProductFilters,
    selectMarketListing,
    selectMarketOffer,
    staleSelectionBanner,
    productOptionSelector,
    marketNote,
    marketSummaryPrice,
    marketSummaryFacts,
    commerce,
    mobileCommerceActionBar,
    mobileCommerceBottomSheet,
    selectedReference,
    setSelectedReference,
  };
}
