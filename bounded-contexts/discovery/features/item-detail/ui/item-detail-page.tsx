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
  ComparisonList,
  ComparisonListCell,
  ComparisonListHeader,
  ComparisonListPrice,
  ComparisonListRow,
  ComparisonListRowGrid,
  Container,
  Dialog,
  Heading,
  Icon,
  ImageGallery,
  Inline,
  KeyValueList,
  LinkButton,
  AccountReputationSummary,
  MarketplaceEmptyState,
  MarketplaceMarketSummary,
  MarketplaceProductDetailLayout,
  PageSection,
  ProductOptions,
  RatingSummary,
  ReferenceInfoDialog,
  ReferenceInfoTrigger,
  SegmentedControl,
  Stack,
  Surface,
  Tabs,
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
import { buildReferenceDetailRows, formatReferenceTypeLabel, type ReferenceDetailRow } from "./reference-detail-rows";

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

type MarketIntent = "buy" | "sell" | "watch";
type MarketBookTab = "listings" | "offers" | "sales" | "details";

function productOptionsFromSelectionDetails(selections: readonly { label: ReactNode; value: ReactNode }[]) {
  return selections.map((selection) => ({
    dimensionLabel: selection.label,
    optionLabel: selection.value,
  }));
}

function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "-";
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (typeof value === "object" && "values" in value) {
    const values = (value as { values?: Record<string, string> }).values ?? {};
    return values.en ?? Object.values(values)[0] ?? "-";
  }

  return JSON.stringify(value);
}

function formatReferenceAttributes(attributes: unknown): Array<{ key: string; value: string }> {
  if (typeof attributes !== "object" || attributes === null || Array.isArray(attributes)) {
    return [];
  }

  return Object.entries(attributes).map(([key, value]) => ({ key, value: formatFieldValue(value) }));
}

function formatRelationshipType(value: string): string {
  return value
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function ReferenceValueCue({
  row,
  onSelectReference,
}: {
  row: ReferenceDetailRow;
  onSelectReference: (reference: DiscoveryReferenceRecordRef) => void;
}) {
  if (!row.reference) {
    return <>{formatFieldValue(row.value)}</>;
  }

  return (
    <ReferenceInfoTrigger
      onClick={() => onSelectReference(row.reference!)}
      aria-label={t("discovery.features.itemDetail.ui.itemDetailPage.reference.value.aria", {
        label: row.label,
        value: row.reference.name,
      })}
    >
      {row.reference.name}
    </ReferenceInfoTrigger>
  );
}

function ReferenceDetailDialog({
  reference,
  onOpenChange,
}: {
  reference: DiscoveryReferenceRecordRef | null;
  onOpenChange: (open: boolean) => void;
}) {
  if (!reference) {
    return null;
  }

  const attributes = formatReferenceAttributes(reference.attributes);
  const relationships = reference.relationships.map((relationship) => ({
    key: formatRelationshipType(relationship.relationshipType),
    value: relationship.reference?.name ?? relationship.referenceId,
  }));

  return (
    <ReferenceInfoDialog
      open
      onOpenChange={onOpenChange}
      title={reference.name}
      description={formatReferenceTypeLabel(reference.typeKey)}
      closeLabel={t("discovery.features.itemDetail.ui.itemDetailPage.close.reference.detail")}
      sections={[
        {
          items: [
            {
              key: t("discovery.features.itemDetail.ui.itemDetailPage.reference.type"),
              value: formatReferenceTypeLabel(reference.typeKey),
            },
            {
              key: t("discovery.features.itemDetail.ui.itemDetailPage.reference.status"),
              value: reference.status,
            },
            {
              key: t("discovery.features.itemDetail.ui.itemDetailPage.reference.key"),
              value: reference.key,
            },
          ],
        },
        {
          title: t("discovery.features.itemDetail.ui.itemDetailPage.reference.attributes"),
          items: attributes,
          emptyState: t("discovery.features.itemDetail.ui.itemDetailPage.reference.no.attributes"),
        },
        {
          title: t("discovery.features.itemDetail.ui.itemDetailPage.reference.relationships"),
          items: relationships,
          emptyState: t("discovery.features.itemDetail.ui.itemDetailPage.reference.no.relationships"),
        },
      ]}
    />
  );
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
  return value ? `$${value}` : t("discovery.features.itemDetail.ui.itemDetailPage.unavailable");
}

function toSafeNumber(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function toFiniteNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function getListingAvailableQuantity(
  listing: Pick<DiscoveryMarketListing, "visible_quantity" | "quantity_cap">,
): number {
  return toFiniteNumber(listing.visible_quantity) ?? toFiniteNumber(listing.quantity_cap) ?? 0;
}

function formatListingAvailability(listing: Pick<DiscoveryMarketListing, "visible_quantity" | "quantity_cap">): string {
  const availableQuantity = getListingAvailableQuantity(listing);

  return availableQuantity > 0
    ? t("discovery.features.itemDetail.ui.itemDetailPage.listing.available.count", {
        count: availableQuantity,
      })
    : t("discovery.features.itemDetail.ui.itemDetailPage.unavailable");
}

function formatOfferRequestedQuantity(offer: Pick<DiscoveryOffer, "quantity_requested">): string {
  return t("discovery.features.itemDetail.ui.itemDetailPage.offer.requested.count", {
    count: offer.quantity_requested,
  });
}

function formatListingPurchaseLimit(
  listing: Pick<DiscoveryMarketListing, "max_units_per_order" | "max_units_per_day" | "max_units_per_customer_account">,
): string | null {
  if (listing.max_units_per_customer_account) {
    return `Limit ${listing.max_units_per_customer_account} per customer`;
  }
  if (listing.max_units_per_day) {
    return `Limit ${listing.max_units_per_day} per day`;
  }
  if (listing.max_units_per_order) {
    return `Limit ${listing.max_units_per_order} per order`;
  }
  return null;
}

function formatCompactProductSummary(
  summary: string | null | undefined,
  selections: readonly { label: string; value: string }[],
  fallback: string,
): string {
  const selectionSummary = selections
    .map((selection) => selection.value.trim())
    .filter(Boolean)
    .join(" · ");
  const source = selectionSummary || summary?.trim();

  return (source || fallback)
    .replace(/\s*\/\s*/g, " · ")
    .replace(/\s*\|\s*/g, " · ")
    .replace(/\s*·\s*/g, " · ");
}

function parseRating(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const rating = Number(value);
  return Number.isFinite(rating) ? rating : null;
}

function ListingTrustSignal({
  accountName,
  feedbackHref,
  rating,
  reviewCount = 0,
}: {
  accountName: string;
  feedbackHref?: string | null;
  rating?: string | null;
  reviewCount?: number;
}) {
  const parsedRating = parseRating(rating);

  return (
    <AccountReputationSummary
      accountName={accountName}
      href={feedbackHref}
      averageRating={parsedRating}
      reviewCount={reviewCount}
    />
  );
}

function isLowestPriceListing(listing: DiscoveryMarketListing, listings: readonly DiscoveryMarketListing[]): boolean {
  const listingPrice = toPriceNumber(listing.price_amount);
  const lowestPrice = toPriceNumber(getLowestPrice(listings) ?? "");

  return listingPrice !== null && lowestPrice !== null && listingPrice === lowestPrice;
}

function isBestOffer(offer: DiscoveryOffer, offers: readonly DiscoveryOffer[]): boolean {
  const offerPrice = toPriceNumber(offer.price_amount);
  const highestPrice = toPriceNumber(getHighestOfferPrice(offers) ?? "");

  return offerPrice !== null && highestPrice !== null && offerPrice === highestPrice;
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
    listing.selected_options.some((entry) => entry.dimensionId === dimensionId && entry.optionId === optionId),
  );
}

function applyOptionFilter(selections: Record<string, string>, dimensionId: string, optionId: string) {
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

  return Object.fromEntries(listing.selected_options.map((entry) => [entry.dimensionId, entry.optionId]));
}

function getInitialSelections(
  data: DiscoveryItemDetail | null,
  marketIntent: MarketIntent,
  initialSelectedOptions: readonly { dimensionId: string; optionId: string }[] = [],
  hasInitialSelectedOptionFilters = false,
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

  const sourceEntries = marketIntent === "sell" ? data.offer_demand_matches : data.market_listings;
  const selections = sourceEntries.length === 1 ? selectionsFromListing(sourceEntries[0]) : {};

  return normalizeProductSearchOptionsForSchema(data.product_schema, selections);
}

function updateMarketIntentUrl(marketIntent: "buy" | "sell" | "watch") {
  if (typeof window === "undefined") {
    return;
  }

  const url = new URL(window.location.href);
  url.searchParams.set("market", marketIntent);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

function formatListingCount(count: number): string {
  return t(
    count === 1
      ? "discovery.features.itemDetail.ui.itemDetailPage.listing.count.singular"
      : "discovery.features.itemDetail.ui.itemDetailPage.listing.count.plural",
    { count },
  );
}

function formatSellerCount(count: number): string {
  return t(
    count === 1
      ? "discovery.features.itemDetail.ui.itemDetailPage.seller.count.singular"
      : "discovery.features.itemDetail.ui.itemDetailPage.seller.count.plural",
    { count },
  );
}

function formatOfferCount(count: number): string {
  return t(
    count === 1
      ? "discovery.features.itemDetail.ui.itemDetailPage.offer.count.singular"
      : "discovery.features.itemDetail.ui.itemDetailPage.offer.count.plural",
    { count },
  );
}

function formatBuyerCount(count: number): string {
  return t(
    count === 1
      ? "discovery.features.itemDetail.ui.itemDetailPage.buyer.count.singular"
      : "discovery.features.itemDetail.ui.itemDetailPage.buyer.count.plural",
    { count },
  );
}

function getLowestPrice(listings: readonly DiscoveryMarketListing[]): string | null {
  return listings.reduce<string | null>((lowest, listing) => {
    if (lowest === null) {
      return listing.price_amount;
    }

    return Number.parseFloat(listing.price_amount) < Number.parseFloat(lowest) ? listing.price_amount : lowest;
  }, null);
}

function getHighestOfferPrice(offers: readonly DiscoveryOffer[]): string | null {
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

function sortListingsByBuyerPrice(listings: readonly DiscoveryMarketListing[]): DiscoveryMarketListing[] {
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

function sortOffersBySellerPrice(offers: readonly DiscoveryOffer[]): DiscoveryOffer[] {
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

function getBestOffer(offers: readonly DiscoveryOffer[]): DiscoveryOffer | null {
  return offers.find((offer) => offer.status === "submitted") ?? offers[0] ?? null;
}

function getBestAccountOfferMatch(offers: readonly DiscoveryAccountOfferMatch[]): DiscoveryAccountOfferMatch | null {
  return (
    sortAccountOfferMatchesForReview(offers.filter((offer) => offer.status === "submitted" && offer.can_fulfill))[0] ??
    null
  );
}

function sortAccountOfferMatchesForReview(offers: readonly DiscoveryAccountOfferMatch[]): DiscoveryAccountOfferMatch[] {
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

function buildProductOptionSummaries({
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

export function ItemDetailPage({
  data,
  notFound = false,
  error = null,
  accountOfferMatches = [],
  viewerAccountId = null,
  initialMarketIntent = "buy",
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
  initialSelectedOptions,
  hasInitialSelectedOptionFilters,
  renderCommerce,
}: {
  data: DiscoveryItemDetail;
  accountOfferMatches: readonly DiscoveryAccountOfferMatch[];
  viewerAccountId: string | null;
  initialMarketIntent: MarketIntent;
  initialSelectedOptions: readonly { dimensionId: string; optionId: string }[];
  hasInitialSelectedOptionFilters: boolean;
  renderCommerce?: (context: ItemDetailMarketplaceSectionContext) => ItemDetailCommerceSections | null;
}) {
  const initialSelectedOptionsKey = JSON.stringify(initialSelectedOptions);
  const [selectedReference, setSelectedReference] = useState<DiscoveryReferenceRecordRef | null>(null);
  const [selections, setSelections] = useState<Record<string, string>>(() =>
    getInitialSelections(data, initialMarketIntent, initialSelectedOptions, hasInitialSelectedOptionFilters),
  );
  const [selectedListingId, setSelectedListingId] = useState<string | null>(null);
  const [selectedOfferId, setSelectedOfferId] = useState<string | null>(null);
  const [marketIntent, setMarketIntent] = useState<MarketIntent>(initialMarketIntent);
  const [activeMobileCommerce, setActiveMobileCommerce] = useState<"buy" | "sell" | "watch" | null>(null);
  const [marketBookTab, setMarketBookTab] = useState<MarketBookTab>(
    initialMarketIntent === "sell" ? "offers" : "listings",
  );

  useEffect(() => {
    setSelections(
      getInitialSelections(data, initialMarketIntent, initialSelectedOptions, hasInitialSelectedOptionFilters),
    );
    setSelectedListingId(null);
    setSelectedOfferId(null);
    setMarketIntent(initialMarketIntent);
    setMarketBookTab(initialMarketIntent === "sell" ? "offers" : "listings");
    setActiveMobileCommerce(null);
  }, [data.catalog_item_id, initialMarketIntent, initialSelectedOptionsKey, hasInitialSelectedOptionFilters]);

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
  const categories = [...new Map(data.categories.map((category) => [category.categoryId, category] as const)).values()];
  const tags = uniqueDisplayValues(data.tags);
  const buyableMarketListings = itemMarketListings.filter((listing) => getListingAvailableQuantity(listing) > 0);
  const visibleListings = sortListingsByBuyerPrice(
    buyableMarketListings.filter((listing) =>
      data.product_schema ? matchesSelectedOptions(listing, selections) : true,
    ),
  );
  const selectedListing =
    visibleListings.find((listing) => listing.listing_id === selectedListingId) ?? visibleListings[0] ?? null;
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
  const selectedOffer =
    matchingOffers.find((offer) => offer.offer_id === selectedOfferId) ?? defaultSellerOffer ?? bestOffer ?? null;
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
    bestListing,
    bestOffer,
    bestAccountOfferMatch,
  } satisfies ItemDetailMarketplaceSectionContext;
  const commerceSections = renderCommerce?.(marketplaceContext) ?? null;
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
  const activeMobileCommerceTitle =
    activeMobileCommerceSection?.title ??
    (activeMobileCommerce === "buy"
      ? t("discovery.features.itemDetail.ui.itemDetailPage.buy.selected.product")
      : activeMobileCommerce === "watch"
        ? (commerceSections?.watchLabel ?? t("discovery.features.itemDetail.ui.itemDetailPage.watch"))
        : (commerceSections?.sellLabel ?? t("discovery.features.itemDetail.ui.itemDetailPage.sell")));
  const activeMobileCommerceDescription = activeMobileCommerceSection?.description;
  const openMobileCommerce = (action: "buy" | "sell" | "watch", nextMarketIntent: MarketIntent) => {
    setMarketIntent(nextMarketIntent);
    setMarketBookTab(nextMarketIntent === "sell" ? "offers" : "listings");
    updateMarketIntentUrl(nextMarketIntent);
    setActiveMobileCommerce(action);
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
            onSelectionChange={(dimensionId, optionId) =>
              setSelections((current) =>
                normalizeProductSearchOptionsForSchema(
                  data.product_schema!,
                  applyOptionFilter(current, dimensionId, optionId),
                ),
              )
            }
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
            <PageSection title={t("discovery.features.itemDetail.ui.itemDetailPage.market.book")}>
              <Tabs
                value={marketBookTab}
                onValueChange={(value) =>
                  setMarketBookTab(value === "offers" || value === "sales" || value === "details" ? value : "listings")
                }
                items={[
                  {
                    value: "listings",
                    label: t("discovery.features.itemDetail.ui.itemDetailPage.listings.2"),
                    content: (
                      <Stack gap={3}>
                        <Inline gap={2}>
                          <Text size="sm" tone="secondary">
                            {hasActiveFilters
                              ? t("discovery.features.itemDetail.ui.itemDetailPage.filtered.listing.count", {
                                  visibleCount: visibleListings.length,
                                  totalCount: itemMarketListings.length,
                                  listingLabel: t(
                                    itemMarketListings.length === 1
                                      ? "discovery.features.itemDetail.ui.itemDetailPage.listing.singular"
                                      : "discovery.features.itemDetail.ui.itemDetailPage.listing.plural",
                                  ),
                                })
                              : t("discovery.features.itemDetail.ui.itemDetailPage.active.listing.count", {
                                  count: visibleListings.length,
                                  listingLabel: t(
                                    visibleListings.length === 1
                                      ? "discovery.features.itemDetail.ui.itemDetailPage.listing.singular"
                                      : "discovery.features.itemDetail.ui.itemDetailPage.listing.plural",
                                  ),
                                })}
                          </Text>
                          {hasActiveFilters ? (
                            <Button type="button" tone="ghost" size="sm" onClick={() => setSelections({})}>
                              {t("discovery.features.itemDetail.ui.itemDetailPage.clear.filters")}
                            </Button>
                          ) : null}
                        </Inline>
                        {visibleListings.length > 0 ? (
                          <ComparisonList>
                            <ComparisonListHeader
                              labels={[
                                t("discovery.features.itemDetail.ui.itemDetailPage.price"),
                                t("discovery.features.itemDetail.ui.itemDetailPage.seller"),
                                t("discovery.features.itemDetail.ui.itemDetailPage.product"),
                                t("discovery.features.itemDetail.ui.itemDetailPage.action"),
                              ]}
                            />
                            {visibleListings.map((listing) => {
                              const isSelected = selectedListing?.listing_id === listing.listing_id;
                              const purchaseLimit = formatListingPurchaseLimit(listing);
                              const isLowestPrice = isLowestPriceListing(listing, visibleListings);
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
                              const sellerName =
                                listing.seller_display_name ??
                                t("discovery.features.itemDetail.ui.itemDetailPage.seller");
                              const sellerFeedbackHref = listing.seller_slug
                                ? `/accounts/${listing.seller_slug}#feedback`
                                : null;
                              const compactProductSummary = formatCompactProductSummary(
                                listing.product_summary,
                                getProductSelectionDetails(listing.selected_options),
                                t("discovery.features.itemDetail.ui.itemDetailPage.standard"),
                              );

                              return (
                                <ComparisonListRow
                                  key={listing.listing_id}
                                  selected={isSelected}
                                  aria-label={t("discovery.features.itemDetail.ui.itemDetailPage.listing.row.label", {
                                    price: formatMoney(listing.price_amount),
                                    seller: sellerName,
                                  })}
                                >
                                  <ComparisonListRowGrid>
                                    <ComparisonListCell>
                                      <Inline gap={2}>
                                        <ComparisonListPrice>{formatMoney(listing.price_amount)}</ComparisonListPrice>
                                        {isLowestPrice ? (
                                          <Badge tone="success">
                                            {t("discovery.features.itemDetail.ui.itemDetailPage.lowest.price")}
                                          </Badge>
                                        ) : null}
                                      </Inline>
                                    </ComparisonListCell>
                                    <ComparisonListCell area="account">
                                      <ListingTrustSignal
                                        accountName={sellerName}
                                        feedbackHref={sellerFeedbackHref}
                                        rating={listing.seller_average_rating}
                                        reviewCount={listing.seller_review_count ?? 0}
                                      />
                                    </ComparisonListCell>
                                    <ComparisonListCell area="product">
                                      <ProductOptions
                                        options={productOptionsFromSelectionDetails(
                                          getProductSelectionDetails(listing.selected_options),
                                        )}
                                        emptyLabel={compactProductSummary}
                                        variant="compact"
                                        size="sm"
                                        truncate
                                      />
                                      <Text element="span" size="xs" tone="secondary" weight="medium">
                                        {formatListingAvailability(listing)}
                                      </Text>
                                      {purchaseLimit ? (
                                        <Stack gap={1}>
                                          <Badge tone="neutral">{purchaseLimit}</Badge>
                                        </Stack>
                                      ) : null}
                                    </ComparisonListCell>
                                    <ComparisonListCell area="action">
                                      <Button
                                        type="button"
                                        tone={isSelected ? "primary" : "secondary"}
                                        size="sm"
                                        aria-pressed={isSelected}
                                        aria-label={t(
                                          isSelected
                                            ? "discovery.features.itemDetail.ui.itemDetailPage.selected.listing.action"
                                            : "discovery.features.itemDetail.ui.itemDetailPage.select.listing.action",
                                          { seller: sellerName, price: formatMoney(listing.price_amount) },
                                        )}
                                        leadingIcon={isSelected ? "check" : undefined}
                                        onClick={selectListing}
                                      >
                                        {isSelected
                                          ? t("discovery.features.itemDetail.ui.itemDetailPage.selected")
                                          : t("discovery.features.itemDetail.ui.itemDetailPage.select")}
                                      </Button>
                                    </ComparisonListCell>
                                  </ComparisonListRowGrid>
                                </ComparisonListRow>
                              );
                            })}
                          </ComparisonList>
                        ) : (
                          <MarketplaceEmptyState
                            title={t("discovery.features.itemDetail.ui.itemDetailPage.no.active.listings")}
                            description={
                              itemMarketListings.length > 0
                                ? t(
                                    "discovery.features.itemDetail.ui.itemDetailPage.no.active.listings.match.these.filters",
                                  )
                                : t(
                                    "discovery.features.itemDetail.ui.itemDetailPage.sellers.have.not.published.inventory.for",
                                  )
                            }
                            recoveryActions={
                              <>
                                {selectedProductId ? (
                                  <LinkButton href="#make-offer" size="sm">
                                    {t("discovery.features.itemDetail.ui.itemDetailPage.make.offer.3")}
                                  </LinkButton>
                                ) : (
                                  <LinkButton href="#select-options" size="sm">
                                    {t("discovery.features.itemDetail.ui.itemDetailPage.choose.options.2")}
                                  </LinkButton>
                                )}
                                {hasActiveFilters ? (
                                  <Button type="button" tone="secondary" size="sm" onClick={() => setSelections({})}>
                                    {t("discovery.features.itemDetail.ui.itemDetailPage.clear.filters.2")}
                                  </Button>
                                ) : null}
                              </>
                            }
                          />
                        )}
                      </Stack>
                    ),
                  },
                  {
                    value: "offers",
                    label: t("discovery.features.itemDetail.ui.itemDetailPage.offers.2"),
                    content: (
                      <Stack gap={3}>
                        <Inline gap={2}>
                          <Text size="sm" tone="secondary">
                            {t("discovery.features.itemDetail.ui.itemDetailPage.matching.offer.count", {
                              count: matchingOffers.length,
                              offerLabel: t(
                                matchingOffers.length === 1
                                  ? "discovery.features.itemDetail.ui.itemDetailPage.offer.singular"
                                  : "discovery.features.itemDetail.ui.itemDetailPage.offer.plural",
                              ),
                            })}
                          </Text>
                          {hasActiveFilters ? (
                            <Button type="button" tone="ghost" size="sm" onClick={() => setSelections({})}>
                              {t("discovery.features.itemDetail.ui.itemDetailPage.clear.filters.3")}
                            </Button>
                          ) : null}
                        </Inline>
                        {matchingOffers.length > 0 ? (
                          <ComparisonList>
                            <ComparisonListHeader
                              labels={[
                                t("discovery.features.itemDetail.ui.itemDetailPage.price"),
                                t("discovery.features.itemDetail.ui.itemDetailPage.buyer"),
                                t("discovery.features.itemDetail.ui.itemDetailPage.product"),
                                t("discovery.features.itemDetail.ui.itemDetailPage.action"),
                              ]}
                            />
                            {matchingOffers.map((offer) => {
                              const isViewerOffer =
                                viewerAccountId !== null && offer.buyer_account_id === viewerAccountId;
                              const isSelected = selectedOffer?.offer_id === offer.offer_id;
                              const isBestOfferPrice = isBestOffer(offer, matchingOffers);
                              const buyerName = offer.buyer_display_name ?? offer.buyer_account_id;
                              const buyerFeedbackHref = offer.buyer_slug
                                ? `/accounts/${offer.buyer_slug}#feedback`
                                : null;
                              const compactProductSummary = formatCompactProductSummary(
                                offer.product_summary,
                                getProductSelectionDetails(offer.selected_options),
                                t("discovery.features.itemDetail.ui.itemDetailPage.standard.2"),
                              );
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
                                <ComparisonListRow
                                  key={offer.offer_id}
                                  selected={isSelected}
                                  aria-label={t("discovery.features.itemDetail.ui.itemDetailPage.offer.row.label", {
                                    price: formatMoney(offer.price_amount),
                                    buyer: buyerName,
                                  })}
                                >
                                  <ComparisonListRowGrid>
                                    <ComparisonListCell>
                                      <Inline gap={2}>
                                        <ComparisonListPrice>{formatMoney(offer.price_amount)}</ComparisonListPrice>
                                        {isBestOfferPrice ? (
                                          <Badge tone="success">
                                            {t("discovery.features.itemDetail.ui.itemDetailPage.best.offer")}
                                          </Badge>
                                        ) : null}
                                        {isViewerOffer ? (
                                          <Badge tone="accent">
                                            {t("discovery.features.itemDetail.ui.itemDetailPage.your.offer")}
                                          </Badge>
                                        ) : null}
                                      </Inline>
                                    </ComparisonListCell>
                                    <ComparisonListCell area="account">
                                      <AccountReputationSummary
                                        accountName={buyerName}
                                        href={buyerFeedbackHref}
                                        averageRating={offer.buyer_average_rating}
                                        reviewCount={offer.buyer_review_count ?? 0}
                                        ratingLabel={t(
                                          "discovery.features.itemDetail.ui.itemDetailPage.buyer.reputation",
                                        )}
                                        onLinkClick={(event) => event.stopPropagation()}
                                      />
                                      {isViewerOffer ? (
                                        <Text size="xs" tone="secondary">
                                          {t("discovery.features.itemDetail.ui.itemDetailPage.own.offer.visibility")}
                                        </Text>
                                      ) : null}
                                    </ComparisonListCell>
                                    <ComparisonListCell area="product">
                                      <ProductOptions
                                        options={productOptionsFromSelectionDetails(
                                          getProductSelectionDetails(offer.selected_options),
                                        )}
                                        emptyLabel={compactProductSummary}
                                        variant="compact"
                                        size="sm"
                                        truncate
                                      />
                                      <Text element="span" size="xs" tone="secondary" weight="medium">
                                        {formatOfferRequestedQuantity(offer)}
                                      </Text>
                                    </ComparisonListCell>
                                    <ComparisonListCell area="action">
                                      <Button
                                        type="button"
                                        tone={isSelected ? "primary" : "secondary"}
                                        size="sm"
                                        aria-pressed={isSelected}
                                        aria-label={t(
                                          isSelected
                                            ? "discovery.features.itemDetail.ui.itemDetailPage.selected.offer.action"
                                            : "discovery.features.itemDetail.ui.itemDetailPage.select.offer.action",
                                          { buyer: buyerName, price: formatMoney(offer.price_amount) },
                                        )}
                                        leadingIcon={isSelected ? "check" : undefined}
                                        onClick={selectOffer}
                                      >
                                        {isSelected
                                          ? t("discovery.features.itemDetail.ui.itemDetailPage.selected")
                                          : t("discovery.features.itemDetail.ui.itemDetailPage.select")}
                                      </Button>
                                    </ComparisonListCell>
                                  </ComparisonListRowGrid>
                                </ComparisonListRow>
                              );
                            })}
                          </ComparisonList>
                        ) : (
                          <MarketplaceEmptyState
                            title={t("discovery.features.itemDetail.ui.itemDetailPage.no.matching.offers")}
                            description={
                              itemOfferDemandMatches.length > 0
                                ? t("discovery.features.itemDetail.ui.itemDetailPage.no.offers.match.these.filters")
                                : t("discovery.features.itemDetail.ui.itemDetailPage.buyers.have.not.placed.offers.for")
                            }
                          />
                        )}
                      </Stack>
                    ),
                  },
                  {
                    value: "sales",
                    label: t("discovery.features.itemDetail.ui.itemDetailPage.sales"),
                    content: (
                      <MarketplaceEmptyState
                        title={t("discovery.features.itemDetail.ui.itemDetailPage.sales.history")}
                        description={t("discovery.features.itemDetail.ui.itemDetailPage.sales.history.unavailable")}
                      />
                    ),
                  },
                  {
                    value: "details",
                    label: t("discovery.features.itemDetail.ui.itemDetailPage.details"),
                    content:
                      data.description || detailItems.length > 0 ? (
                        <Stack gap={4}>
                          {data.description ? (
                            <Stack gap={2}>
                              <Heading level={3}>
                                {t("discovery.features.itemDetail.ui.itemDetailPage.description")}
                              </Heading>
                              <Text>{data.description}</Text>
                            </Stack>
                          ) : null}
                          {detailItems.length > 0 ? <KeyValueList density="compact" items={detailItems} /> : null}
                        </Stack>
                      ) : (
                        <MarketplaceEmptyState
                          title={t("discovery.features.itemDetail.ui.itemDetailPage.details")}
                          description={t("discovery.features.itemDetail.ui.itemDetailPage.no.additional.details")}
                        />
                      ),
                  },
                ]}
              />
            </PageSection>
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
