import { formatLanguageCodeLabel, t } from "@chase-sets/localization";
import { useEffect, useState, type ReactNode } from "react";
import {
  Banner,
  Badge,
  Breadcrumbs,
  Button,
  Card,
  CommerceActionBar,
  CommerceBottomSheet,
  Container,
  Heading,
  Icon,
  ImageGallery,
  Inline,
  LinkButton,
  AccountReputationSummary,
  MarketplaceMarketSummary,
  MarketplaceProductDetailLayout,
  ProductOptions,
  SegmentedControl,
  Stack,
  Surface,
  Text,
  formatMarketplaceNumber,
} from "@chase-sets/design-system";
import type {
  DiscoveryItemDetail,
  DiscoveryMarketListing,
  DiscoveryOffer,
  DiscoveryAccountOfferMatch,
  DiscoveryReferenceRecordRef,
} from "../../../support/client-support/contracts";
import { discoveryAssetUrls, imageVariantSrcSet } from "../../../support/client-support/assets";
import { buildDiscoveryProductAssetImage } from "../../../support/client-support/product-assets";
import { uniqueDisplayValues } from "../../../support/item-support/unique-display-values";
import { ProductSelector } from "./product-selector";
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
  formatBuyerCount,
  formatCompactProductSummary,
  formatListingAvailability,
  formatListingCount,
  formatMoney,
  formatOfferCount,
  formatSellerCount,
  formatUpdatedAt,
  getBestAccountOfferMatch,
  getBestOffer,
  getHighestOfferPrice,
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
  updateMarketIntentUrl,
} from "../domain/item-detail-market";
import { buildReferenceDetailRows } from "./reference-detail-rows";
import { ReferenceDetailDialog, ReferenceValueCue } from "./item-detail-references";
import { ItemDetailMarketBook } from "./item-detail-market-book";
import { trackItemDetailRailEvent } from "../../../support/ui-support/item-detail-rail-analytics";

export type ItemDetailMarketplaceSectionContext = Readonly<{
  itemId: string;
  selectedProductId: string | null;
  itemTitle: string;
  itemSubtitle: string | null;
  selectedProductOptions: readonly { dimensionId: string; optionId: string }[];
  selectedProductSelectionDetails: readonly { label: string; value: string }[];
  selectedProductSummary: string | null;
  visibleListings: readonly DiscoveryMarketListing[];
  visibleOffers: readonly DiscoveryOffer[];
  visibleAccountOfferMatches: readonly DiscoveryAccountOfferMatch[];
  selectedListing: DiscoveryMarketListing | null;
  selectedOffer: DiscoveryOffer | null;
  selectedAccountOfferMatch: DiscoveryAccountOfferMatch | null;
  selectedListingSource: MarketSelectionSource;
  selectedOfferSource: MarketSelectionSource;
  staleSelectedListingId: string | null;
  staleSelectedOfferId: string | null;
  bestListing: DiscoveryMarketListing | null;
  bestOffer: DiscoveryOffer | null;
  bestAccountOfferMatch: DiscoveryAccountOfferMatch | null;
}>;

export type ItemDetailMobileCommerceSection = Readonly<{
  content: ReactNode;
  footer?: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
}>;

export type ItemDetailCommerceSections = Readonly<{
  buy: ReactNode;
  offer?: ReactNode;
  sell?: ReactNode;
  watch?: ReactNode;
  mobile?: Partial<Record<"buy" | "sell" | "watch", ItemDetailMobileCommerceSection>>;
  sellLabel?: string;
  watchLabel?: string;
}>;

function productOptionsFromSelectionDetails(selections: readonly { label: ReactNode; value: ReactNode }[]) {
  return selections.map((selection) => ({
    dimensionLabel: selection.label,
    optionLabel: selection.value,
  }));
}

function buildItemDetailImages(data: DiscoveryItemDetail) {
  const detailImage = buildDiscoveryProductAssetImage(
    data.product_asset_sets,
    "catalog-detail",
    "(min-width: 768px) 308px, min(100vw, 276px)",
  );
  const detailSrc = detailImage?.src;

  if (detailSrc) {
    const thumbnailImage = buildDiscoveryProductAssetImage(data.product_asset_sets, "thumbnail", "64px");

    return [
      {
        ...detailImage,
        src: detailSrc,
        thumbnailSrc: thumbnailImage?.src ?? detailSrc,
        thumbnailSrcSet: thumbnailImage?.srcSet,
        thumbnailSizes: thumbnailImage?.sizes,
        alt: t("discovery.features.itemDetail.ui.itemDetailPage.image.alt", {
          title: data.title,
          index: 1,
        }),
      },
    ];
  }

  return data.image_urls.map((url, index) => ({
    src: url,
    alt: t("discovery.features.itemDetail.ui.itemDetailPage.image.alt", {
      title: data.title,
      index: index + 1,
    }),
  }));
}

export function ItemDetailPage({
  data,
  notFound = false,
  error = null,
  accountOfferMatches = [],
  viewerAccountId = null,
  initialMarketIntent = "buy",
  initialSelectedListingId = null,
  initialSelectedOfferId = null,
  initialSelectedOptions = [],
  hasInitialSelectedOptionFilters = false,
  renderCommerce,
}: {
  data: DiscoveryItemDetail | null;
  notFound?: boolean;
  error?: string | null;
  accountOfferMatches?: readonly DiscoveryAccountOfferMatch[];
  viewerAccountId?: string | null;
  initialMarketIntent?: MarketIntent;
  initialSelectedListingId?: string | null;
  initialSelectedOfferId?: string | null;
  initialSelectedOptions?: readonly { dimensionId: string; optionId: string }[];
  hasInitialSelectedOptionFilters?: boolean;
  renderCommerce?: (context: ItemDetailMarketplaceSectionContext) => ItemDetailCommerceSections | null;
}) {
  if (error) {
    return (
      <Banner tone="danger" title={t("discovery.features.itemDetail.ui.itemDetailPage.error")} description={error} />
    );
  }

  if (!data) {
    return (
      <Banner
        tone="danger"
        title={
          notFound
            ? t("discovery.features.itemDetail.ui.itemDetailPage.not.found")
            : t("discovery.features.itemDetail.ui.itemDetailPage.error.2")
        }
        description={
          notFound
            ? t("discovery.features.itemDetail.ui.itemDetailPage.this.item.could.not.be.found")
            : t("discovery.features.itemDetail.ui.itemDetailPage.this.item.is.not.available.right")
        }
      />
    );
  }

  return (
    <LoadedItemDetailPage
      key={data.catalog_item_id}
      data={data}
      accountOfferMatches={accountOfferMatches}
      viewerAccountId={viewerAccountId}
      initialMarketIntent={initialMarketIntent}
      initialSelectedListingId={initialSelectedListingId}
      initialSelectedOfferId={initialSelectedOfferId}
      initialSelectedOptions={initialSelectedOptions}
      hasInitialSelectedOptionFilters={hasInitialSelectedOptionFilters}
      renderCommerce={renderCommerce}
    />
  );
}

function LoadedItemDetailPage({
  data,
  accountOfferMatches,
  viewerAccountId,
  initialMarketIntent,
  initialSelectedListingId,
  initialSelectedOfferId,
  initialSelectedOptions,
  hasInitialSelectedOptionFilters,
  renderCommerce,
}: {
  data: DiscoveryItemDetail;
  accountOfferMatches: readonly DiscoveryAccountOfferMatch[];
  viewerAccountId: string | null;
  initialMarketIntent: MarketIntent;
  initialSelectedListingId: string | null;
  initialSelectedOfferId: string | null;
  initialSelectedOptions: readonly { dimensionId: string; optionId: string }[];
  hasInitialSelectedOptionFilters: boolean;
  renderCommerce?: (context: ItemDetailMarketplaceSectionContext) => ItemDetailCommerceSections | null;
}) {
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
  const productSummary =
    selectedProductSummary ??
    (singleMatchingListing
      ? t("discovery.features.itemDetail.ui.itemDetailPage.1.matching.listing")
      : t("discovery.features.itemDetail.ui.itemDetailPage.all.listings"));
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
  const renderMarketIntentControl = (ariaLabel: string, fullWidth = false) => (
    <SegmentedControl
      aria-label={ariaLabel}
      fullWidth={fullWidth}
      items={[
        { value: "buy", label: t("discovery.features.itemDetail.ui.itemDetailPage.buy") },
        { value: "sell", label: t("discovery.features.itemDetail.ui.itemDetailPage.sell") },
        { value: "watch", label: commerceSections?.watchLabel ?? t("discovery.features.search.ui.searchPage.watch") },
      ]}
      value={marketIntent}
      onValueChange={(value) => {
        const nextMarketIntent: MarketIntent = value === "sell" ? "sell" : value === "watch" ? "watch" : "buy";
        setMarketIntent(nextMarketIntent);
        setMarketBookTab(nextMarketIntent === "sell" ? "offers" : "listings");
        updateMarketIntentUrl(nextMarketIntent);
        trackRailIntentSelected(nextMarketIntent, "desktop_rail");
      }}
    />
  );
  const commerce = commerceContent ? (
    <Stack gap={3}>
      {renderMarketIntentControl(t("discovery.features.itemDetail.ui.itemDetailPage.choose.market.intent"))}
      {commerceContent}
    </Stack>
  ) : null;
  const marketNote =
    explicitSelectedProductSelectionDetails.length > 0 ? (
      <ProductOptions
        options={productOptionsFromSelectionDetails(explicitSelectedProductSelectionDetails)}
        emptyLabel={explicitSelectedProductSummary ?? undefined}
      />
    ) : marketIntent === "sell" ? (
      (explicitSelectedProductSummary ??
      (hasActiveFilters
        ? t("discovery.features.itemDetail.ui.itemDetailPage.filtered.offers")
        : t("discovery.features.itemDetail.ui.itemDetailPage.all.offers")))
    ) : (
      (explicitSelectedProductSummary ??
      (hasActiveFilters
        ? t("discovery.features.itemDetail.ui.itemDetailPage.filtered.active.listings")
        : t("discovery.features.itemDetail.ui.itemDetailPage.all.active.listings")))
    );
  const marketSummaryPrice =
    marketIntent === "sell"
      ? formatMoney(getHighestOfferPrice(matchingOffers))
      : formatMoney(selectedMarketSummary.lowest_price_amount);
  const mobileCommerceSummary = (
    <Stack gap={1}>
      <Text element="div" weight="semibold">
        {marketIntent === "buy" && selectedListing ? formatMoney(selectedListing.price_amount) : marketSummaryPrice}
      </Text>
      <Text element="div" size="xs" tone="secondary" weight="medium" truncate>
        {marketIntent === "buy" && selectedListing ? (
          [selectedListingAvailability, selectedListingProductSummary].filter(Boolean).join(" · ")
        ) : (
          <>
            {t("discovery.features.itemDetail.ui.itemDetailPage.chosen.options")}
            {": "}
            {currentOptionSummary}
          </>
        )}
      </Text>
    </Stack>
  );
  const marketSummaryFacts =
    marketIntent === "sell"
      ? [
          {
            label: t("discovery.features.itemDetail.ui.itemDetailPage.requested"),
            value: matchingOffers.reduce((sum, offer) => sum + offer.quantity_requested, 0),
          },
          {
            label: t("discovery.features.itemDetail.ui.itemDetailPage.offers"),
            value: formatOfferCount(matchingOffers.length),
          },
          {
            label: t("discovery.features.itemDetail.ui.itemDetailPage.buyers"),
            value: formatBuyerCount(buyerCount),
          },
        ]
      : [
          {
            label: t("discovery.features.itemDetail.ui.itemDetailPage.available"),
            value: formatMarketplaceNumber(
              selectedMarketSummary.total_visible_quantity,
              t("discovery.features.itemDetail.ui.itemDetailPage.unavailable"),
            ),
          },
          {
            label: t("discovery.features.itemDetail.ui.itemDetailPage.listings"),
            value: formatListingCount(selectedMarketSummary.active_listing_count),
          },
          {
            label: t("discovery.features.itemDetail.ui.itemDetailPage.sellers"),
            value: formatSellerCount(sellerCount),
          },
        ];
  const activeMobileCommerceSection = activeMobileCommerce ? commerceSections?.mobile?.[activeMobileCommerce] : null;
  const activeMobileCommerceContent =
    activeMobileCommerceSection?.content ??
    (activeMobileCommerce === "buy"
      ? commerceSections?.buy
      : activeMobileCommerce === "sell"
        ? commerceSections?.sell
        : activeMobileCommerce === "watch"
          ? commerceSections?.watch
          : null);
  const mobileBuySheetTitle = selectedListing
    ? selectedListingSource === "explicit"
      ? t("discovery.features.itemDetail.ui.itemDetailPage.selected.listing")
      : t("discovery.routes.itemDetail.best.available.listing")
    : t("discovery.routes.itemDetail.selected.product");
  const mobileBuySheetDescription = selectedListing
    ? selectedListingSource === "explicit"
      ? t("discovery.routes.itemDetail.mobile.buy.selected.listing.description")
      : t("discovery.routes.itemDetail.mobile.buy.best.available.listing.description")
    : t("discovery.routes.itemDetail.mobile.buy.selected.product.description");
  const mobileSellSheetTitle = selectedOffer
    ? selectedOfferSource === "explicit"
      ? t("discovery.routes.itemDetail.selected.offer.heading")
      : t("discovery.routes.itemDetail.best.offer.heading")
    : t("discovery.routes.itemDetail.selected.product");
  const mobileSellSheetDescription = selectedOffer
    ? selectedOfferSource === "explicit"
      ? t("discovery.routes.itemDetail.mobile.sell.selected.offer.description")
      : t("discovery.routes.itemDetail.mobile.sell.best.offer.description")
    : t("discovery.routes.itemDetail.mobile.sell.selected.product.description");
  const activeMobileCommerceTitle =
    activeMobileCommerceSection?.title ??
    (activeMobileCommerce === "buy"
      ? mobileBuySheetTitle
      : activeMobileCommerce === "watch"
        ? t("discovery.routes.itemDetail.mobile.watch.title")
        : mobileSellSheetTitle);
  const activeMobileCommerceDescription =
    activeMobileCommerceSection?.description ??
    (activeMobileCommerce === "buy"
      ? mobileBuySheetDescription
      : activeMobileCommerce === "watch"
        ? t("discovery.routes.itemDetail.mobile.watch.description")
        : activeMobileCommerce === "sell"
          ? mobileSellSheetDescription
          : undefined);
  const openMobileCommerce = (action: "buy" | "sell" | "watch", nextMarketIntent: MarketIntent) => {
    setMarketIntent(nextMarketIntent);
    setMarketBookTab(nextMarketIntent === "sell" ? "offers" : "listings");
    updateMarketIntentUrl(nextMarketIntent);
    setActiveMobileCommerce(action);
    trackRailIntentSelected(nextMarketIntent, "mobile_action_bar");
  };
  const mobileBuyAction = selectedProductId ? (
    <Button type="button" size="lg" onClick={() => openMobileCommerce("buy", "buy")}>
      {t("discovery.features.itemDetail.ui.itemDetailPage.buy.2")}
    </Button>
  ) : (
    <LinkButton href="#select-options" size="lg">
      {t("discovery.features.itemDetail.ui.itemDetailPage.select.options")}
    </LinkButton>
  );
  const mobileSellAction =
    (commerceSections?.mobile?.sell ?? commerceSections?.sell) ? (
      selectedProductId ? (
        <Button type="button" size="lg" onClick={() => openMobileCommerce("sell", "sell")}>
          {commerceSections.sellLabel ?? t("discovery.features.itemDetail.ui.itemDetailPage.sell.2")}
        </Button>
      ) : (
        <LinkButton href="#select-options" size="sm">
          {t("discovery.features.itemDetail.ui.itemDetailPage.choose.to.sell")}
        </LinkButton>
      )
    ) : null;
  const mobileWatchAction = commerceSections?.mobile?.watch ? (
    selectedProductId ? (
      <Button type="button" tone="secondary" size="lg" onClick={() => openMobileCommerce("watch", "watch")}>
        {commerceSections.watchLabel ?? t("discovery.features.itemDetail.ui.itemDetailPage.watch")}
      </Button>
    ) : (
      <LinkButton href="#select-options" tone="secondary" size="sm">
        {t("discovery.features.itemDetail.ui.itemDetailPage.choose.to.watch")}
      </LinkButton>
    )
  ) : null;
  const mobileCommerceActionBar = commerce ? (
    <CommerceActionBar
      summary={mobileCommerceSummary}
      primaryAction={mobileBuyAction}
      secondaryAction={mobileSellAction}
      tertiaryAction={mobileWatchAction}
    />
  ) : null;
  const mobileCommerceBottomSheet = commerce ? (
    <CommerceBottomSheet
      open={Boolean(activeMobileCommerce && activeMobileCommerceContent)}
      onOpenChange={(open) => {
        if (!open) {
          setActiveMobileCommerce(null);
        }
      }}
      title={activeMobileCommerceTitle}
      description={activeMobileCommerceDescription}
      footer={activeMobileCommerceSection?.footer}
    >
      {activeMobileCommerceContent}
    </CommerceBottomSheet>
  ) : null;
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
  const productOptionSelector =
    data.product_schema && data.product_schema.dimensions.length > 0 ? (
      <Card variant="feature">
        <Stack gap={3} id="select-options">
          <Stack gap={1}>
            <Text size="sm" weight="semibold">
              {t("discovery.features.itemDetail.ui.itemDetailPage.choose.options")}
            </Text>
          </Stack>
          <ProductSelector
            schema={data.product_schema}
            selections={selections}
            optionSummaries={optionSummaries}
            onSelectionChange={handleProductSelectionChange}
          />
          <Stack gap={1}>
            <Text size="sm" weight="semibold">
              {t("discovery.features.itemDetail.ui.itemDetailPage.chosen.options")}
            </Text>
            <ProductOptions
              options={productOptionsFromSelectionDetails(explicitSelectedProductSelectionDetails)}
              emptyLabel={currentOptionSummary}
              variant="chips"
            />
          </Stack>
        </Stack>
      </Card>
    ) : null;

  return (
    <>
      <Breadcrumbs
        items={[
          { label: t("discovery.features.itemDetail.ui.itemDetailPage.search"), href: "/search" },
          { label: data.title },
        ]}
      />

      <Container width="expanded" paddingX={0}>
        <MarketplaceProductDetailLayout
          summary={
            <Stack gap={4}>
              <Stack gap={3}>
                {data.blueprint ? (
                  <Text size="sm" weight="semibold" tone="accent">
                    {data.blueprint.name}
                  </Text>
                ) : null}

                <Stack gap={2}>
                  <Heading level={1}>{data.title}</Heading>
                  {data.subtitle ? (
                    <Text size="lg" tone="secondary">
                      {data.subtitle}
                    </Text>
                  ) : null}
                </Stack>
              </Stack>
            </Stack>
          }
          media={
            <Stack gap={5}>
              <ImageGallery
                images={images}
                aspectRatio="5/7"
                maxHeightClassName="max-w-[min(100%,17.25rem)] md:max-w-[min(100%,19.25rem)] [--gallery-max-height:27rem]"
                thumbnailPlacement="left"
                fallbackImage={{
                  src: imageFallback.url,
                  alt: imageFallback.alt,
                  srcSet: imageVariantSrcSet(imageFallback, "detail"),
                  sizes: "(min-width: 768px) 19.25rem, min(100vw, 17.25rem)",
                }}
                fallbackImageMode={imageFallback.usage}
                emptyState={
                  <Stack gap={3} align="center">
                    <Surface tone="muted" padding={4}>
                      <Icon name="image" size="lg" tone="secondary" />
                    </Surface>
                    <Stack gap={1} align="center">
                      <Text weight="semibold">
                        {t("discovery.features.itemDetail.ui.itemDetailPage.image.coming.soon")}
                      </Text>
                      <Text size="sm" tone="secondary">
                        {t("discovery.features.itemDetail.ui.itemDetailPage.catalog.imagery.has.not.been.added")}
                      </Text>
                    </Stack>
                  </Stack>
                }
              />
            </Stack>
          }
          market={
            <Stack gap={4}>
              {staleSelectionBanner}
              {productOptionSelector}
              <MarketplaceMarketSummary
                priceLabel={
                  marketIntent === "sell"
                    ? t("discovery.features.itemDetail.ui.itemDetailPage.best.offer")
                    : t("discovery.features.itemDetail.ui.itemDetailPage.lowest.ask")
                }
                price={marketSummaryPrice}
                note={marketNote}
                facts={marketSummaryFacts}
              />
            </Stack>
          }
          commerce={commerce}
          mobileActionBar={mobileCommerceActionBar}
        >
          <Stack gap={6}>
            <ItemDetailMarketBook
              marketBookTab={marketBookTab}
              onMarketBookTabChange={setMarketBookTab}
              visibleListings={visibleListings}
              itemMarketListings={itemMarketListings}
              matchingOffers={matchingOffers}
              itemOfferDemandMatches={itemOfferDemandMatches}
              hasActiveFilters={hasActiveFilters}
              selectedListing={selectedListing}
              selectedOffer={selectedOffer}
              selectedProductId={selectedProductId}
              viewerAccountId={viewerAccountId}
              data={data}
              detailItems={detailItems}
              getProductSelectionDetails={getProductSelectionDetails}
              onClearProductFilters={clearProductFilters}
              onSelectListing={selectMarketListing}
              onSelectOffer={selectMarketOffer}
            />
          </Stack>
        </MarketplaceProductDetailLayout>
        {mobileCommerceBottomSheet}
        <ReferenceDetailDialog
          reference={selectedReference}
          onOpenChange={(open) => {
            if (!open) {
              setSelectedReference(null);
            }
          }}
        />
      </Container>
    </>
  );
}
