import {
  useEffect,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  Banner,
  Badge,
  Breadcrumbs,
  Button,
  Card,
  CommerceActionBar,
  CommerceDrawer,
  Container,
  EmptyState,
  Grid,
  Heading,
  Icon,
  ImageGallery,
  Inline,
  KeyValueList,
  LinkButton,
  MarketplaceMarketSummary,
  MarketplaceProductDetailLayout,
  PageSection,
  Reveal,
  SegmentedControl,
  Stack,
  Stagger,
  Surface,
  Text,
} from "@chase-sets/design-system";
import type {
  DiscoveryItemDetail,
  DiscoveryMarketListing,
  DiscoveryOffer,
  DiscoveryAccountOfferMatch,
} from "../../../support/client-support/contracts";
import { discoveryAssetUrls } from "../../../support/client-support/assets";
import { uniqueDisplayValues } from "../../../support/item-support/unique-display-values";
import { ProductSelector } from "./product-selector";
import {
  createDiscoveryProductDescriptor,
  getOrderedActiveDimensions,
  isProductSelectionComplete,
  normalizeProductSearchOptionsForSchema,
  summarizeSelections,
} from "../domain/product-resolution";

export type ItemDetailMarketplaceSectionContext = Readonly<{
  itemId: string;
  selectedProductId: string | null;
  itemTitle: string;
  itemSubtitle: string | null;
  selectedProductOptions: readonly { dimensionId: string; optionId: string }[];
  selectedProductSummary: string | null;
  visibleListings: readonly DiscoveryMarketListing[];
  visibleOffers: readonly DiscoveryOffer[];
  visibleAccountOfferMatches: readonly DiscoveryAccountOfferMatch[];
  selectedListing: DiscoveryMarketListing | null;
  selectedOffer: DiscoveryOffer | null;
  selectedAccountOfferMatch: DiscoveryAccountOfferMatch | null;
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
  offer: ReactNode;
  sell?: ReactNode;
  mobile?: Partial<Record<"buy" | "offer" | "sell" | "list", ItemDetailMobileCommerceSection>>;
  sellLabel?: string;
  listLabel?: string;
}>;

function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "-";
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }

  return JSON.stringify(value);
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return `${new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "UTC",
  }).format(date)} UTC`;
}

function formatMoney(value: string | null): string {
  return value ? `$${value}` : "Unavailable";
}

function matchesSelectedOptions(
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
    listing.selected_options.some(
      (entry) => entry.dimensionId === dimensionId && entry.optionId === optionId,
    ),
  );
}

function applyOptionFilter(
  selections: Record<string, string>,
  dimensionId: string,
  optionId: string,
) {
  const nextSelections = { ...selections };

  if (optionId) {
    nextSelections[dimensionId] = optionId;
  } else {
    delete nextSelections[dimensionId];
  }

  return nextSelections;
}

function selectionsFromListing(
  listing:
    | Readonly<{
        selected_options: readonly { dimensionId: string; optionId: string }[];
      }>
    | undefined,
): Record<string, string> {
  if (!listing) {
    return {};
  }

  return Object.fromEntries(
    listing.selected_options.map((entry) => [entry.dimensionId, entry.optionId]),
  );
}

function handleSelectionKeyDown(
  event: KeyboardEvent<HTMLDivElement>,
  select: () => void,
) {
  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }

  event.preventDefault();
  select();
}

function getInitialSelections(data: DiscoveryItemDetail | null): Record<string, string> {
  if (!data?.product_schema) {
    return {};
  }

  const selections =
    data.market_listings.length === 1
      ? selectionsFromListing(data.market_listings[0])
      : {};

  return normalizeProductSearchOptionsForSchema(data.product_schema, selections);
}

function formatListingCount(count: number): string {
  return `${count} listing${count === 1 ? "" : "s"}`;
}

function formatSellerCount(count: number): string {
  return `${count} seller${count === 1 ? "" : "s"}`;
}

function formatOfferCount(count: number): string {
  return `${count} offer${count === 1 ? "" : "s"}`;
}

function formatBuyerCount(count: number): string {
  return `${count} buyer${count === 1 ? "" : "s"}`;
}

function getLowestPrice(listings: readonly DiscoveryMarketListing[]): string | null {
  return listings.reduce<string | null>((lowest, listing) => {
    if (lowest === null) {
      return listing.price_amount;
    }

    return Number.parseFloat(listing.price_amount) < Number.parseFloat(lowest)
      ? listing.price_amount
      : lowest;
  }, null);
}

function getHighestOfferPrice(offers: readonly DiscoveryOffer[]): string | null {
  return offers.reduce<string | null>((highest, offer) => {
    if (highest === null) {
      return offer.price_amount;
    }

    return Number.parseFloat(offer.price_amount) > Number.parseFloat(highest)
      ? offer.price_amount
      : highest;
  }, null);
}

function getBestOffer(
  offers: readonly DiscoveryOffer[],
): DiscoveryOffer | null {
  return offers.find((offer) => offer.status === "submitted") ?? offers[0] ?? null;
}

function getBestAccountOfferMatch(
  offers: readonly DiscoveryAccountOfferMatch[],
): DiscoveryAccountOfferMatch | null {
  return sortAccountOfferMatchesForReview(
    offers.filter((offer) => offer.status === "submitted" && offer.can_fulfill),
  )[0] ?? null;
}

function sortAccountOfferMatchesForReview(
  offers: readonly DiscoveryAccountOfferMatch[],
): DiscoveryAccountOfferMatch[] {
  return [...offers].sort((left, right) => {
    const fulfillableDelta = Number(right.can_fulfill) - Number(left.can_fulfill);
    if (fulfillableDelta !== 0) {
      return fulfillableDelta;
    }

    const priceDelta =
      Number.parseFloat(right.price_amount) - Number.parseFloat(left.price_amount);
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

function offerStatusTone(status: string): "accent" | "neutral" | "success" {
  switch (status) {
    case "submitted":
      return "accent";
    case "accepted":
      return "success";
    default:
      return "neutral";
  }
}

function buildProductOptionSummaries({
  listings,
  productSchema,
  selections,
}: {
  listings: readonly DiscoveryMarketListing[];
  productSchema: NonNullable<DiscoveryItemDetail["product_schema"]>;
  selections: Record<string, string>;
}): Record<string, Record<string, string>> {
  return Object.fromEntries(
    getOrderedActiveDimensions(productSchema, selections).map((dimension) => {
      const selectionsWithoutDimension = { ...selections };
      delete selectionsWithoutDimension[dimension.dimensionId];

      const matchingOtherSelections = listings.filter((listing) =>
        matchesSelectedOptions(listing, selectionsWithoutDimension),
      );

      return [
        dimension.dimensionId,
        Object.fromEntries(
          dimension.allowedOptions.map((option) => {
            const matchingOption = matchingOtherSelections.filter((listing) =>
              listing.selected_options.some(
                (entry) =>
                  entry.dimensionId === dimension.dimensionId &&
                  entry.optionId === option.optionId,
              ),
            );

            return [
              option.optionId,
              matchingOption.length > 0
                ? `${matchingOption.length} from ${formatMoney(
                    getLowestPrice(matchingOption),
                  )}`
                : "none",
            ];
          }),
        ),
      ];
    }),
  );
}

export function ItemDetailPage({
  data,
  notFound = false,
  error = null,
  accountOfferMatches = [],
  renderCommerce,
}: {
  data: DiscoveryItemDetail | null;
  notFound?: boolean;
  error?: string | null;
  accountOfferMatches?: readonly DiscoveryAccountOfferMatch[];
  renderCommerce?: (
    context: ItemDetailMarketplaceSectionContext,
  ) => ItemDetailCommerceSections | null;
}) {
  const [selections, setSelections] = useState<Record<string, string>>(() =>
    getInitialSelections(data),
  );
  const [selectedListingId, setSelectedListingId] = useState<string | null>(null);
  const [selectedOfferId, setSelectedOfferId] = useState<string | null>(null);
  const [marketIntent, setMarketIntent] = useState<"buy" | "sell">("buy");
  const [activeMobileCommerce, setActiveMobileCommerce] = useState<
    "buy" | "offer" | "sell" | "list" | null
  >(null);

  useEffect(() => {
    setSelections(getInitialSelections(data));
    setSelectedListingId(null);
    setSelectedOfferId(null);
  }, [data]);

  if (error) {
    return <Banner tone="danger" title="Error" description={error} />;
  }

  if (!data) {
    return (
      <Banner
        tone="danger"
        title={notFound ? "Not found" : "Error"}
        description={
          notFound
            ? "This item could not be found."
            : "This item is not available right now."
        }
      />
    );
  }

  const images = data.image_urls.map((url, index) => ({
    src: url,
    alt: `${data.title} image ${index + 1}`,
  }));
  const explicitSelectedOptions = data.product_schema
    ? summarizeSelections(data.product_schema, selections)
    : [];
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
        .filter(
          (
            selection,
          ): selection is { dimensionId: string; optionId: string } => selection !== null,
        )
    : [];
  const explicitSelectedProductSummary =
    explicitSelectedOptions.length > 0
      ? explicitSelectedOptions.map((selection) => selection.optionLabel).join(" / ")
      : null;
  const hasActiveFilters = Object.keys(selections).length > 0;
  const hasCompleteProductSelection = data.product_schema
    ? isProductSelectionComplete(data.product_schema, selections)
    : true;
  const categories = [
    ...new Map(
      data.categories.map((category) => [category.categoryId, category] as const),
    ).values(),
  ];
  const tags = uniqueDisplayValues(data.tags);
  const visibleListings = data.market_listings.filter((listing) =>
    data.product_schema ? matchesSelectedOptions(listing, selections) : true,
  );
  const selectedListing =
    visibleListings.find((listing) => listing.listing_id === selectedListingId) ??
    visibleListings[0] ??
    null;
  const singleMatchingListing =
    !hasCompleteProductSelection && visibleListings.length === 1
      ? visibleListings[0]
      : null;
  const initialSelectedProductId = hasCompleteProductSelection
    ? createDiscoveryProductDescriptor({
        catalogItemId: data.catalog_item_id,
        productSchema: data.product_schema,
        selection: explicitSelectedProductOptions,
      }).productId
    : selectedListing?.product_id ?? singleMatchingListing?.product_id ?? null;
  const matchingOffers = (data.buyer_offer_matches ?? [])
    .filter((offer) => offer.catalog_catalog_item_id === data.catalog_item_id)
    .filter((offer) =>
      initialSelectedProductId
        ? offer.product_id === initialSelectedProductId
        : data.product_schema
          ? matchesSelectedOptions(offer, selections)
          : true,
    );
  const matchingAccountOfferMatches = sortAccountOfferMatchesForReview(accountOfferMatches
    .filter((offer) => offer.catalog_catalog_item_id === data.catalog_item_id)
    .filter((offer) =>
      initialSelectedProductId
        ? offer.product_id === initialSelectedProductId
        : data.product_schema
          ? matchesSelectedOptions(offer, selections)
          : true,
    )
  );
  const sellerOfferById = new Map(
    matchingAccountOfferMatches.map((offer) => [offer.offer_id, offer] as const),
  );
  const selectedOffer =
    matchingOffers.find((offer) => offer.offer_id === selectedOfferId) ??
    matchingOffers[0] ??
    null;
  const selectedAccountOfferMatch = selectedOffer
    ? matchingAccountOfferMatches.find(
        (offer) => offer.offer_id === selectedOffer.offer_id,
      ) ?? null
    : matchingAccountOfferMatches[0] ?? null;
  const selectedProductId =
    initialSelectedProductId ??
    (marketIntent === "sell" ? selectedOffer?.product_id ?? null : null);
  const selectedOfferForProduct =
    marketIntent === "sell" ? selectedOffer : null;
  const selectedProductOptions =
    hasCompleteProductSelection || (!selectedListing && !selectedOfferForProduct && !singleMatchingListing)
      ? explicitSelectedProductOptions
      : selectedListing?.selected_options ??
        selectedOfferForProduct?.selected_options ??
        singleMatchingListing?.selected_options ??
        explicitSelectedProductOptions;
  const selectedProductSummary =
    explicitSelectedProductSummary ??
    selectedListing?.product_summary ??
    selectedOfferForProduct?.product_summary ??
    singleMatchingListing?.product_summary ??
    null;
  const bestListing =
    selectedProductId
      ? visibleListings.find((listing) => listing.product_id === selectedProductId) ?? null
      : null;
  const bestOffer = getBestOffer(matchingOffers);
  const bestAccountOfferMatch = getBestAccountOfferMatch(matchingAccountOfferMatches);
  const sellerCount = new Set(
    visibleListings.map((listing) => listing.account_id),
  ).size;
  const buyerCount = new Set(
    matchingOffers.map((offer) => offer.buyer_account_id),
  ).size;
  const selectedMarketSummary = {
    lowest_price_amount: getLowestPrice(visibleListings),
    active_listing_count: visibleListings.length,
    total_visible_quantity: visibleListings.reduce(
      (sum, listing) => sum + listing.visible_quantity,
      0,
    ),
  };
  const optionSummaries = data.product_schema
    ? buildProductOptionSummaries({
        listings: data.market_listings,
        productSchema: data.product_schema,
        selections,
      })
    : {};
  const metadataItems = [
    ...(categories.length > 0
      ? [
          {
            key: "Categories",
            value: categories.map((category) => category.name).join(", "),
          },
        ]
      : []),
    ...(tags.length > 0
      ? [
          {
            key: "Tags",
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
      key: "Last updated",
      value: formatUpdatedAt(data.updated_at),
    },
  ];
  const detailItems = [
    ...data.field_values.map((fieldValue) => ({
      key: fieldValue.fieldName,
      value: formatFieldValue(fieldValue.value),
    })),
    ...metadataItems,
  ];
  const marketplaceContext = {
    itemId: data.catalog_item_id,
    selectedProductId,
    itemTitle: data.title,
    itemSubtitle: data.subtitle,
    selectedProductOptions,
    selectedProductSummary,
    visibleListings,
    visibleOffers: matchingOffers,
    visibleAccountOfferMatches: matchingAccountOfferMatches,
    selectedListing,
    selectedOffer,
    selectedAccountOfferMatch,
    bestListing,
    bestOffer,
    bestAccountOfferMatch,
  } satisfies ItemDetailMarketplaceSectionContext;
  const commerceSections = renderCommerce?.(marketplaceContext) ?? null;
  const commerceContent = commerceSections
    ? marketIntent === "sell" && commerceSections.sell
      ? commerceSections.sell
      : (
        <Stack gap={4}>
          {commerceSections.buy}
          {commerceSections.offer}
        </Stack>
      )
    : null;
  const renderMarketIntentControl = (ariaLabel: string, fullWidth = false) => (
    <SegmentedControl
      aria-label={ariaLabel}
      fullWidth={fullWidth}
      items={[
        { value: "buy", label: "Buy" },
        { value: "sell", label: "Sell" },
      ]}
      value={marketIntent}
      onValueChange={(value) =>
        setMarketIntent(value === "sell" ? "sell" : "buy")
      }
    />
  );
  const commerce = commerceContent ? (
    <Stack gap={3}>
      {renderMarketIntentControl("Choose market intent")}
      {commerceContent}
    </Stack>
  ) : null;
  const productSummary =
    selectedProductSummary ??
    (singleMatchingListing ? "1 matching listing" : "All listings");
  const mobileCommerceSummary = selectedProductSummary ?? "Choose options";
  const marketNote =
    marketIntent === "sell"
      ? selectedProductSummary ??
        (hasActiveFilters ? "Filtered offers" : "All offers")
      : selectedProductSummary ??
        (hasActiveFilters ? "Filtered active listings" : "All active listings");
  const marketSummaryPrice =
    marketIntent === "sell"
      ? formatMoney(getHighestOfferPrice(matchingOffers))
      : formatMoney(selectedMarketSummary.lowest_price_amount);
  const marketSummaryFacts =
    marketIntent === "sell"
      ? [
          {
            label: "Requested",
            value: matchingOffers.reduce(
              (sum, offer) => sum + offer.quantity_requested,
              0,
            ),
          },
          {
            label: "Offers",
            value: formatOfferCount(matchingOffers.length),
          },
          {
            label: "Buyers",
            value: formatBuyerCount(buyerCount),
          },
        ]
      : [
          {
            label: "Available",
            value: selectedMarketSummary.total_visible_quantity,
          },
          {
            label: "Listings",
            value: formatListingCount(selectedMarketSummary.active_listing_count),
          },
          {
            label: "Sellers",
            value: formatSellerCount(sellerCount),
          },
        ];
  const activeMobileCommerceSection = activeMobileCommerce
    ? commerceSections?.mobile?.[activeMobileCommerce]
    : null;
  const activeMobileCommerceContent =
    activeMobileCommerceSection?.content ??
    (activeMobileCommerce === "buy"
      ? commerceSections?.buy
      : activeMobileCommerce === "offer"
        ? commerceSections?.offer
        : activeMobileCommerce === "sell"
          ? commerceSections?.sell
          : null);
  const activeMobileCommerceTitle =
    activeMobileCommerceSection?.title ??
    (activeMobileCommerce === "buy"
      ? "Buy selected product"
      : activeMobileCommerce === "offer"
        ? "Make offer"
        : activeMobileCommerce === "list"
          ? commerceSections?.listLabel ?? "List"
          : commerceSections?.sellLabel ?? "Sell");
  const activeMobileCommerceDescription =
    activeMobileCommerceSection?.description ?? mobileCommerceSummary;
  const mobileBuyAction = selectedProductId ? (
    <Button
      type="button"
      size="sm"
      onClick={() => setActiveMobileCommerce("buy")}
    >
      Buy
    </Button>
  ) : (
    <LinkButton href="#select-options" size="sm">
      Select options
    </LinkButton>
  );
  const mobileOfferAction = selectedProductId ? (
    <Button
      type="button"
      tone="secondary"
      size="sm"
      onClick={() => setActiveMobileCommerce("offer")}
    >
      Make offer
    </Button>
  ) : (
    <LinkButton href="#select-options" tone="secondary" size="sm">
      Choose to offer
    </LinkButton>
  );
  const mobileSellAction = (commerceSections?.mobile?.sell ?? commerceSections?.sell) ? (
    selectedProductId ? (
      <Button
        type="button"
        size="sm"
        onClick={() => setActiveMobileCommerce("sell")}
      >
        {commerceSections.sellLabel ?? "Sell"}
      </Button>
    ) : (
      <LinkButton href="#select-options" size="sm">
        Choose to sell
      </LinkButton>
    )
  ) : null;
  const mobileListAction = commerceSections?.mobile?.list ? (
    selectedProductId ? (
      <Button
        type="button"
        tone="secondary"
        size="sm"
        onClick={() => setActiveMobileCommerce("list")}
      >
        {commerceSections.listLabel ?? "List"}
      </Button>
    ) : (
      <LinkButton href="#select-options" tone="secondary" size="sm">
        Choose to list
      </LinkButton>
    )
  ) : null;
  const mobileCommerceActionBar = commerce ? (
    <CommerceActionBar
      intentControl={renderMarketIntentControl("Choose mobile market intent", true)}
      summary={mobileCommerceSummary}
      primaryAction={marketIntent === "sell" ? mobileSellAction : mobileBuyAction}
      secondaryAction={marketIntent === "sell" ? mobileListAction : mobileOfferAction}
    />
  ) : null;
  const mobileCommerceDrawer = commerce ? (
    <CommerceDrawer
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
    </CommerceDrawer>
  ) : null;

  return (
    <Stagger>
      <Breadcrumbs
        items={[
          { label: "Search", href: "/search" },
          { label: data.title },
        ]}
      />

      <Container width="expanded" paddingX={0}>
        <Reveal preset="lift">
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

                {data.product_schema && data.product_schema.dimensions.length > 0 ? (
                  <Card variant="feature">
                    <Stack gap={3} id="select-options">
                      <Stack gap={1}>
                        <Text size="sm" weight="semibold">
                          Choose options
                        </Text>
                        <Text size="sm" tone="secondary">
                          {productSummary}
                        </Text>
                      </Stack>
                      <ProductSelector
                        schema={data.product_schema}
                        selections={selections}
                        optionSummaries={optionSummaries}
                        onSelectionChange={(dimensionId, optionId) =>
                          setSelections((current) =>
                            normalizeProductSearchOptionsForSchema(
                              data.product_schema!,
                              applyOptionFilter(current, dimensionId, optionId),
                            ),
                          )
                        }
                      />
                      {selectedListing?.product_summary ? (
                        <Text size="sm" tone="secondary">
                          Matched listing: {selectedListing.product_summary}
                        </Text>
                      ) : null}
                    </Stack>
                  </Card>
                ) : null}
              </Stack>
            }
            media={
              <Stack gap={5}>
                <ImageGallery
                  images={images}
                  aspectRatio="5/7"
                  fallbackImage={{
                    src: discoveryAssetUrls.defaultProductImage,
                    alt: "Pokemon card back",
                  }}
                  maxHeightClassName="[--gallery-max-height:34rem]"
                  emptyState={
                    <Stack gap={3} align="center">
                      <Surface tone="muted" padding={4}>
                        <Icon name="image" size="lg" tone="secondary" />
                      </Surface>
                      <Stack gap={1} align="center">
                        <Text weight="semibold">Image coming soon</Text>
                        <Text size="sm" tone="secondary">
                          Catalog imagery has not been added yet.
                        </Text>
                      </Stack>
                    </Stack>
                  }
                />

                {data.description ? (
                  <PageSection title="Description">
                    <Text>{data.description}</Text>
                  </PageSection>
                ) : null}

                {detailItems.length > 0 ? (
                  <PageSection title="Details">
                    <KeyValueList
                      density="compact"
                      items={detailItems}
                    />
                  </PageSection>
                ) : null}

              </Stack>
            }
            market={
              <MarketplaceMarketSummary
                price={marketSummaryPrice}
                note={marketNote}
                facts={marketSummaryFacts}
              />
            }
            commerce={commerce}
            mobileActionBar={mobileCommerceActionBar}
          >
            <Stack gap={6}>
              {marketIntent === "buy" ? (
                <Reveal preset="lift">
                  <PageSection title="Listings">
                    <Stack gap={3}>
                      <Inline gap={2}>
                        <Text size="sm" tone="secondary">
                          {hasActiveFilters ? (
                            <>
                              {visibleListings.length} of {data.market_listings.length}{" "}
                              listing{data.market_listings.length === 1 ? "" : "s"}
                            </>
                          ) : (
                            <>
                              {visibleListings.length} active listing
                              {visibleListings.length === 1 ? "" : "s"}
                            </>
                          )}
                        </Text>
                        {hasActiveFilters ? (
                          <Button
                            type="button"
                            tone="ghost"
                            size="sm"
                            onClick={() => setSelections({})}
                          >
                            Clear filters
                          </Button>
                        ) : null}
                      </Inline>
                      {visibleListings.length > 0 ? (
                        visibleListings.map((listing) => {
                          const isSelected =
                            selectedListing?.listing_id === listing.listing_id;
                          const selectListing = () => {
                            setSelectedListingId(listing.listing_id);
                            if (data.product_schema) {
                              setSelections(
                                normalizeProductSearchOptionsForSchema(
                                  data.product_schema,
                                  selectionsFromListing(listing),
                                ),
                              );
                            }
                          };

                          return (
                            <Card
                              key={listing.listing_id}
                              glow={isSelected}
                              interactive
                              role="button"
                              tabIndex={0}
                              aria-pressed={isSelected}
                              onClick={selectListing}
                              onKeyDown={(event) =>
                                handleSelectionKeyDown(event, selectListing)
                              }
                            >
                              <Grid columns={{ base: 1, md: 3 }} gap={3}>
                                <Stack gap={1}>
                                  <Inline gap={2}>
                                    <Text weight="semibold">
                                      {formatMoney(listing.price_amount)}
                                    </Text>
                                    {isSelected ? (
                                      <Badge tone="success">Selected</Badge>
                                    ) : null}
                                  </Inline>
                                  <Text size="sm" tone="secondary">
                                    {listing.seller_display_name ?? "Seller"}
                                  </Text>
                                </Stack>
                                <Stack gap={1}>
                                  <Text size="sm" tone="secondary">
                                    Available
                                  </Text>
                                  <Text>{listing.visible_quantity}</Text>
                                </Stack>
                                <Stack gap={1}>
                                  <Text size="sm" tone="secondary">
                                    Product
                                  </Text>
                                  <Text>{listing.product_summary ?? "Standard"}</Text>
                                </Stack>
                              </Grid>
                            </Card>
                          );
                        })
                      ) : (
                        <EmptyState
                          title="No active listings"
                          description={
                            data.market_listings.length > 0
                              ? "No active listings match these filters."
                              : "Sellers have not published inventory for this item yet."
                          }
                          icon="package"
                          actions={
                            <>
                              {selectedProductId ? (
                                <LinkButton href="#make-offer" size="sm">
                                  Make offer
                                </LinkButton>
                              ) : (
                                <LinkButton href="#select-options" size="sm">
                                  Choose options
                                </LinkButton>
                              )}
                              {hasActiveFilters ? (
                                <Button
                                  type="button"
                                  tone="secondary"
                                  size="sm"
                                  onClick={() => setSelections({})}
                                >
                                  Clear filters
                                </Button>
                              ) : null}
                            </>
                          }
                        />
                      )}
                    </Stack>
                  </PageSection>
                </Reveal>
              ) : (
                <Reveal preset="lift">
                  <PageSection title="Offers">
                    <Stack gap={3}>
                      <Inline gap={2}>
                        <Text size="sm" tone="secondary">
                          {matchingOffers.length} matching offer
                          {matchingOffers.length === 1 ? "" : "s"}
                        </Text>
                        {hasActiveFilters ? (
                          <Button
                            type="button"
                            tone="ghost"
                            size="sm"
                            onClick={() => setSelections({})}
                          >
                            Clear filters
                          </Button>
                        ) : null}
                      </Inline>
                      {matchingOffers.length > 0 ? (
                        matchingOffers.map((offer) => {
                          const sellerOffer = sellerOfferById.get(offer.offer_id);
                          const isSelected =
                            selectedOffer?.offer_id === offer.offer_id;
                          const selectOffer = () => {
                            setSelectedOfferId(offer.offer_id);
                            if (data.product_schema) {
                              setSelections(
                                normalizeProductSearchOptionsForSchema(
                                  data.product_schema,
                                  selectionsFromListing(offer),
                                ),
                              );
                            }
                          };

                          return (
                            <Card
                              key={offer.offer_id}
                              glow={isSelected}
                              interactive
                              role="button"
                              tabIndex={0}
                              aria-pressed={isSelected}
                              onClick={selectOffer}
                              onKeyDown={(event) =>
                                handleSelectionKeyDown(event, selectOffer)
                              }
                            >
                              <Grid columns={{ base: 1, md: 4 }} gap={3}>
                                <Stack gap={1}>
                                  <Inline gap={2}>
                                    <Text weight="semibold">
                                    {formatMoney(offer.price_amount)}
                                  </Text>
                                  {isSelected ? <Badge tone="success">Selected</Badge> : null}
                                </Inline>
                                <Text size="sm" tone="secondary">
                                  {offer.buyer_display_name ?? offer.buyer_account_id}
                                  </Text>
                                </Stack>
                                <Stack gap={1}>
                                  <Text size="sm" tone="secondary">
                                    Quantity
                                  </Text>
                                  <Text>{offer.quantity_requested}</Text>
                                </Stack>
                                <Stack gap={1}>
                                  <Text size="sm" tone="secondary">
                                    Product
                                  </Text>
                                  <Text>{offer.product_summary ?? "Standard"}</Text>
                                </Stack>
                                <Stack gap={1}>
                                  <Text size="sm" tone="secondary">
                                    Status
                                  </Text>
                                  <Inline gap={2}>
                                    <Badge tone={offerStatusTone(offer.status)}>
                                      {offer.status}
                                    </Badge>
                                    {sellerOffer ? (
                                      <Badge tone={sellerOffer.can_fulfill ? "success" : "warning"}>
                                        {sellerOffer.can_fulfill ? "Can fulfill" : "Needs supply"}
                                      </Badge>
                                    ) : null}
                                    {sellerOffer?.in_sell_list ? (
                                      <Badge tone="accent">In sell list</Badge>
                                    ) : null}
                                  </Inline>
                                </Stack>
                              </Grid>
                            </Card>
                          );
                        })
                      ) : (
                        <EmptyState
                          title="No matching offers"
                          description={
                            data.buyer_offer_matches.length > 0
                              ? "No offers match these filters."
                              : "Buyers have not placed offers for this item yet."
                          }
                          icon="package"
                        />
                      )}
                    </Stack>
                  </PageSection>
                </Reveal>
              )}
            </Stack>
          </MarketplaceProductDetailLayout>
          {mobileCommerceDrawer}
        </Reveal>
      </Container>
    </Stagger>
  );
}
