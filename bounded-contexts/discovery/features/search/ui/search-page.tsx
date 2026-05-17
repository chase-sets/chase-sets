import { formatLanguageCodeLabel, t } from "@chase-sets/localization";
import { useEffect, useRef, useState } from "react";
import {
  AppliedFilterChips,
  Button,
  CommerceSheet,
  SearchInput,
  Select,
  LoadingSpinner,
  Banner,
  Stack,
  Inline,
  SearchResultsLayout,
  Grid,
  LinkButton,
  ListingCard,
  NoResultsRecovery,
  PlatformCredibilityCue,
  PromoStrip,
  ProgressiveDisclosureGroup,
  MarketplaceFacetChoiceGroup,
  MarketplaceFacetRail,
  MarketplaceFilterBottomSheet,
  MarketplaceLandingHero,
  MarketplaceMobileFilterBar,
  SavedSearchPrompt,
  SearchControlBar,
} from "@chase-sets/design-system";
import type { DiscoveryCategoryItem } from "../../categories/ui/contracts";
import type {
  DiscoveryFacetGroup,
  DiscoverySearchItem,
  DiscoverySearchResponse,
} from "../../../support/client-support/contracts";
import type { DiscoveryBulkCartPreview } from "../read-model/queries";
import { discoveryAssetUrls, imageVariantSrcSet } from "../../../support/client-support/assets";
import {
  buildDiscoveryProductAssetSrcSet,
  selectDiscoveryProductAssetUrl,
} from "../../../support/client-support/product-assets";
import { uniqueDisplayValues } from "../../../support/item-support/unique-display-values";

const AUTO_LOAD_ROOT_MARGIN = "900px";

const sortOptions = [
  { label: t("discovery.features.search.ui.searchPage.relevance"), value: "relevance" },
  { label: t("discovery.features.search.ui.searchPage.title.a.z"), value: "title_asc" },
  { label: t("discovery.features.search.ui.searchPage.title.z.a"), value: "title_desc" },
  { label: t("discovery.features.search.ui.searchPage.newest"), value: "newest" },
];

type DynamicSearchFilterSelection = Readonly<{
  kind: "field" | "dimension";
  id: string;
  value: string;
}>;

const languageOptions = [
  { label: t("discovery.features.search.ui.searchPage.english"), value: "en" },
  { label: t("discovery.features.search.ui.searchPage.japanese"), value: "ja" },
];

function formatListingMeta(item: DiscoverySearchItem): string {
  const listingCount = item.market_summary?.active_listing_count ?? 0;
  const visibleQuantity = item.market_summary?.total_visible_quantity ?? 0;

  if (listingCount === 0) {
    return t("discovery.features.search.ui.searchPage.no.active.listings");
  }

  return t("discovery.features.search.ui.searchPage.listing.meta", {
    listingCount,
    listingLabel: t(
      listingCount === 1
        ? "discovery.features.search.ui.searchPage.listing.singular"
        : "discovery.features.search.ui.searchPage.listing.plural",
    ),
    visibleQuantity,
  });
}

function formatPrice(item: DiscoverySearchItem): string {
  const lowestPrice = item.market_summary?.lowest_price_amount;

  return lowestPrice
    ? t("discovery.features.search.ui.searchPage.from.price", { price: `$${lowestPrice}` })
    : t("discovery.features.search.ui.searchPage.market.open");
}

function formatAvailability(item: DiscoverySearchItem): string {
  const visibleQuantity = item.market_summary?.total_visible_quantity ?? 0;

  return visibleQuantity > 0
    ? t("discovery.features.search.ui.searchPage.available.quantity", {
        visibleQuantity,
      })
    : t("discovery.features.search.ui.searchPage.offer.or.list.yours");
}

function formatSellerSignal(item: DiscoverySearchItem): string {
  const listingCount = item.market_summary?.active_listing_count ?? 0;

  return listingCount > 0
    ? t("discovery.features.search.ui.searchPage.verified.marketplace.sellers")
    : t("discovery.features.search.ui.searchPage.supply.wanted");
}

function formatItemLanguage(item: DiscoverySearchItem): string {
  return formatLanguageCodeLabel(item.language_code);
}

function findLanguageLabel(language: string): string {
  return languageOptions.find((item) => item.value === language)?.label ?? language;
}

function formatValueCue(item: DiscoverySearchItem): string | undefined {
  const listingCount = item.market_summary?.active_listing_count ?? 0;

  return listingCount > 0
    ? undefined
    : t("discovery.features.search.ui.searchPage.make.an.offer.or.list.yours");
}

function formatFacetDescription(facet: DiscoveryFacetGroup): string {
  return facet.kind === "dimension"
    ? t("discovery.features.search.ui.searchPage.dimension.facet.description")
    : t("discovery.features.search.ui.searchPage.field.facet.description");
}

function buildDynamicAppliedFilters(
  facets: readonly DiscoveryFacetGroup[],
  dynamicFilters: readonly DynamicSearchFilterSelection[],
  onDynamicFilterChange: (value: DynamicSearchFilterSelection) => void,
) {
  return dynamicFilters.map((filter) => {
    const facet = facets.find((entry) => entry.kind === filter.kind && entry.id === filter.id);
    const value = facet?.values.find((entry) => entry.id === filter.value);
    const label = facet && value
      ? t("discovery.features.search.ui.searchPage.dynamic.filter.label", {
          facet: facet.label,
          value: value.label,
        })
      : t("discovery.features.search.ui.searchPage.dynamic.filter.label", {
          facet: filter.id,
          value: filter.value,
        });

    return {
      id: `${filter.kind}:${filter.id}:${filter.value}`,
      label,
      onRemove: () => onDynamicFilterChange(filter),
    };
  });
}

function buildItemDetailHref(
  slug: string,
  dynamicFilters: readonly DynamicSearchFilterSelection[],
) {
  const params = new URLSearchParams();

  for (const filter of dynamicFilters) {
    if (filter.kind === "dimension" && filter.id && filter.value) {
      params.append(`dimension.${filter.id}`, filter.value);
    }
  }

  const query = params.toString();

  return `/items/${slug}${query ? `?${query}` : ""}`;
}

export interface SearchPageProps {
  search: string;
  committedSearch?: string;
  category: string;
  tag?: string;
  language: string;
  sort: string;
  dynamicFilters: readonly DynamicSearchFilterSelection[];
  data: DiscoverySearchResponse | null;
  categories: DiscoveryCategoryItem[];
  loading?: boolean;
  loadingMore?: boolean;
  loadMoreError?: string | null;
  error?: string | null;
  bulkAdd?: BulkAddSearchState;
  restoreSearchFocus?: boolean;
  onSearchChange: (value: string) => void;
  onCategoryChange: (value: string) => void;
  onTagClear?: () => void;
  onLanguageChange: (value: string) => void;
  onSortChange: (value: string) => void;
  onDynamicFilterChange: (value: DynamicSearchFilterSelection) => void;
  onDynamicFilterClear: (value: Omit<DynamicSearchFilterSelection, "value">) => void;
  onLoadMore?: () => void;
}

export type BulkAddSearchActionData =
  | Readonly<{ status: "bulk-preview"; preview: DiscoveryBulkCartPreview }>
  | Readonly<{
      status: "bulk-added";
      preview: DiscoveryBulkCartPreview;
      addedLineCount: number;
      mergedLineCount: number;
      failedLineCount: number;
      requestedLineCount: number;
    }>;

export type BulkAddSearchState = Readonly<{
  status: "idle" | "submitting";
  data?: BulkAddSearchActionData;
  onPreview: () => void;
  onCommit: () => void;
}>;

function selectedFacetValues(facet: DiscoveryFacetGroup) {
  return facet.values.filter((value) => value.selected);
}

function notifyCartCountChanged(quantity: number) {
  if (typeof window === "undefined" || quantity <= 0) {
    return;
  }

  window.dispatchEvent(
    new CustomEvent("chase-sets:cart-count-changed", {
      detail: { countDelta: quantity },
    }),
  );
}

export function SearchPage({
  search,
  committedSearch = search,
  category,
  tag = "",
  language,
  sort,
  dynamicFilters,
  data,
  categories,
  loading = false,
  loadingMore = false,
  loadMoreError = null,
  error = null,
  bulkAdd,
  restoreSearchFocus = false,
  onSearchChange,
  onCategoryChange,
  onTagClear,
  onLanguageChange,
  onSortChange,
  onDynamicFilterChange,
  onDynamicFilterClear,
  onLoadMore,
}: SearchPageProps) {
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const [bulkSheetOpen, setBulkSheetOpen] = useState(false);
  const exactTotal = data?.total ?? data?.items.length ?? 0;
  const featuredCategories = categories.slice(0, 5);
  const liveListingItems =
    data?.items.filter((item) => item.market_summary?.active_listing_count).length ?? 0;
  const marketOnlyItems = data ? data.items.length - liveListingItems : 0;
  const catalogDepth = categories.reduce(
    (total, current) => total + current.item_count,
    0,
  );
  const activeCategoryLabel =
    categories.find((item) => item.slug === category)?.name ?? t("discovery.features.search.ui.searchPage.all.categories");
  const activeLanguageLabel = language ? findLanguageLabel(language) : t("discovery.features.search.ui.searchPage.all.languages");
  const activeDynamicFilterCount = dynamicFilters.length;
  const dynamicFacets = data?.facets ?? [];
  const resultsSummary = t("discovery.features.search.ui.searchPage.results.summary", {
    count: exactTotal,
    category: activeCategoryLabel,
  });
  const hasFocusedResults =
    committedSearch.trim().length > 0 || Boolean(category) || Boolean(tag) || Boolean(language) || activeDynamicFilterCount > 0 || sort !== "relevance";
  const canLoadMore = Boolean(data?.nextCursor && onLoadMore);
  const dynamicAppliedFilters = buildDynamicAppliedFilters(
    data?.facets ?? [],
    dynamicFilters,
    onDynamicFilterChange,
  );
  const appliedFilters = [
    ...(committedSearch.trim()
      ? [{
          id: "search",
          label: t("discovery.features.search.ui.searchPage.search.filter.label", {
            search: committedSearch,
          }),
          onRemove: () => onSearchChange(""),
        }]
      : []),
    ...(category
      ? [{
          id: "category",
          label: t("discovery.features.search.ui.searchPage.category.filter.label", {
            category: activeCategoryLabel,
          }),
          onRemove: () => onCategoryChange(""),
        }]
      : []),
    ...(language
      ? [{
          id: "language",
          label: t("discovery.features.search.ui.searchPage.language.filter.label", {
            language: activeLanguageLabel,
          }),
          onRemove: () => onLanguageChange(""),
        }]
      : []),
    ...(tag
      ? [{
          id: "tag",
          label: t("discovery.features.search.ui.searchPage.tag.filter.label", {
            tag,
          }),
          onRemove: () => onTagClear?.(),
        }]
      : []),
    ...(sort !== "relevance"
      ? [{
          id: "sort",
          label: t("discovery.features.search.ui.searchPage.sort.filter.label", {
            sort: sortOptions.find((item) => item.value === sort)?.label ?? sort,
          }),
          onRemove: () => onSortChange("relevance"),
        }]
      : []),
    ...dynamicAppliedFilters,
  ];
  const filterRail = (
    <Stack gap={3}>
      <MarketplaceFacetRail
        items={categories.map((item) => ({
          id: item.slug,
          label: item.name,
          count: item.item_count,
        }))}
        selectedId={category}
        onSelect={onCategoryChange}
      />
      <MarketplaceFacetRail
        title={t("discovery.features.search.ui.searchPage.language")}
        description={t("discovery.features.search.ui.searchPage.mobile.language.description")}
        allLabel={t("discovery.features.search.ui.searchPage.all.languages")}
        items={languageOptions.map((item) => ({
          id: item.value,
          label: item.label,
        }))}
        selectedId={language}
        onSelect={onLanguageChange}
      />
      {dynamicFacets.map((facet) => {
        const selectedValues = selectedFacetValues(facet).map((value) => value.id);

        return (
          <MarketplaceFacetRail
            key={`${facet.kind}:${facet.id}`}
            title={facet.label}
            description={formatFacetDescription(facet)}
            allLabel={t("discovery.features.search.ui.searchPage.any.facet", { facet: facet.label })}
            items={facet.values.map((value) => ({
              id: value.id,
              label: value.label,
              count: value.count,
            }))}
            selectedIds={selectedValues}
            selectionMode="multiple"
            onSelect={(value) => {
              if (value) {
                onDynamicFilterChange({ kind: facet.kind, id: facet.id, value });
              } else {
                onDynamicFilterClear({ kind: facet.kind, id: facet.id });
              }
            }}
          />
        );
      })}
    </Stack>
  );
  const bulkActionData = bulkAdd?.data;
  const bulkPreview = bulkActionData?.preview;
  const bulkBusy = bulkAdd?.status === "submitting";
  const bulkCanPreview = Boolean(bulkAdd && hasFocusedResults && data && data.items.length > 0);
  const bulkCanCommit = Boolean(
    bulkAdd &&
      bulkPreview &&
      !bulkPreview.overLimit &&
      bulkPreview.eligibleCount > 0 &&
      bulkActionData?.status !== "bulk-added",
  );

  useEffect(() => {
    if (bulkActionData) {
      setBulkSheetOpen(true);
    }
    if (bulkActionData?.status === "bulk-added") {
      notifyCartCountChanged(bulkActionData.addedLineCount + bulkActionData.mergedLineCount);
    }
  }, [bulkActionData]);

  useEffect(() => {
    if (!canLoadMore || loadingMore || loadMoreError || !onLoadMore) {
      return undefined;
    }

    const target = loadMoreRef.current;
    if (!target || typeof IntersectionObserver === "undefined") {
      return undefined;
    }

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        onLoadMore();
      }
    }, { rootMargin: AUTO_LOAD_ROOT_MARGIN });

    observer.observe(target);
    return () => observer.disconnect();
  }, [canLoadMore, loadingMore, loadMoreError, onLoadMore]);

  return (
    <SearchResultsLayout
      filters={filterRail}
      summary={
        hasFocusedResults ? null : (
          <Stack gap={6}>
            <MarketplaceLandingHero
              badges={[
                { label: t("discovery.features.search.ui.searchPage.marketplace"), tone: "accent" },
                { label: t("discovery.features.search.ui.searchPage.verified.supply"), tone: "success" },
              ]}
              title={t("discovery.features.search.ui.searchPage.find.cards.comics.figures.sneakers.and")}
              description={t("discovery.features.search.ui.searchPage.search.live.supply.compare.active.markets")}
              search={
                <SearchInput
                  label={t("discovery.features.search.ui.searchPage.marketplace.search")}
                  hideLabel
                  placeholder={t("discovery.features.search.ui.searchPage.search.pikachu.spider.man.jordan.vintage")}
                  value={search}
                  onChange={(e) => onSearchChange(e.target.value)}
                />
              }
              filters={[
                {
                  id: "",
                  label: t("discovery.features.search.ui.searchPage.all"),
                  selected: !category,
                  onSelect: () => onCategoryChange(""),
                },
                ...featuredCategories.map((item) => ({
                  id: item.slug,
                  label: item.name,
                  selected: category === item.slug,
                  onSelect: () => onCategoryChange(item.slug),
                })),
              ]}
              metrics={[
                { label: t("discovery.features.search.ui.searchPage.results"), value: exactTotal, detail: activeCategoryLabel },
                { label: t("discovery.features.search.ui.searchPage.available.now"), value: liveListingItems, detail: t("discovery.features.search.ui.searchPage.with.active.listings") },
                { label: t("discovery.features.search.ui.searchPage.market.only.2"), value: marketOnlyItems, detail: t("discovery.features.search.ui.searchPage.tracked.items", { count: catalogDepth }) },
              ]}
            />
            <PromoStrip
              icon="shield"
              title={t("discovery.features.search.ui.searchPage.buyer.confidence.is.built.into.discovery")}
              description={t("discovery.features.search.ui.searchPage.verified.supply.transparent.pricing.and.item")}
            />
          </Stack>
        )
      }
    >
      <Stack gap={hasFocusedResults ? 6 : 4}>
        {hasFocusedResults ? (
          <SearchControlBar
            search={
              <SearchInput
                hideLabel
                placeholder={t("discovery.features.search.ui.searchPage.search.catalog.items")}
                value={search}
                autoFocus={restoreSearchFocus}
                onChange={(e) => onSearchChange(e.target.value)}
              />
            }
            sort={
              <Select
                hideLabel
                label={t("discovery.features.search.ui.searchPage.sort")}
                items={sortOptions}
                value={sort}
                onValueChange={onSortChange}
              />
            }
            actions={
              <Inline gap={2}>
                {bulkAdd ? (
                  <Button
                    type="button"
                    tone="secondary"
                    disabled={!bulkCanPreview || bulkBusy}
                    loading={bulkBusy}
                    onClick={bulkAdd.onPreview}
                  >
                    {t("discovery.features.search.ui.searchPage.add.matching.to.cart")}
                  </Button>
                ) : null}
                <LinkButton href="/search" tone="secondary">
                  {t("discovery.features.search.ui.searchPage.clear.all.filters")}
                </LinkButton>
              </Inline>
            }
            appliedFilters={
              <AppliedFilterChips
                filters={appliedFilters}
                clearAction={
                  appliedFilters.length ? (
                    <LinkButton href="/search" tone="ghost" size="sm">
                      {t("discovery.features.search.ui.searchPage.clear.all")}
                    </LinkButton>
                  ) : null
                }
                removeLabel={(label) =>
                  t("discovery.features.search.ui.searchPage.remove.filter", {
                    filter: String(label),
                  })
                }
              />
            }
            summary={resultsSummary}
          />
        ) : null}
        {hasFocusedResults ? (
          <>
            <MarketplaceMobileFilterBar
              title={t("discovery.features.search.ui.searchPage.filters")}
              summary={resultsSummary}
              activeFilterCount={appliedFilters.length}
              activeFilterLabel={t("discovery.features.search.ui.searchPage.active.filter.count", {
                count: appliedFilters.length,
              })}
              openLabel={t("discovery.features.search.ui.searchPage.open.filters")}
              onOpen={() => setMobileFiltersOpen(true)}
              clearAction={
                appliedFilters.length ? (
                  <LinkButton href="/search" tone="ghost" size="sm">
                    {t("discovery.features.search.ui.searchPage.clear.all")}
                  </LinkButton>
                ) : null
              }
            />
            <MarketplaceFilterBottomSheet
              open={mobileFiltersOpen}
              onOpenChange={setMobileFiltersOpen}
              title={t("discovery.features.search.ui.searchPage.filters")}
              description={t("discovery.features.search.ui.searchPage.mobile.filters.description")}
              closeLabel={t("discovery.features.search.ui.searchPage.close.filters")}
              resultSummary={resultsSummary}
              footer={
                <Inline gap={2} align="end">
                  <LinkButton href="/search" tone="ghost" size="sm">
                    {t("discovery.features.search.ui.searchPage.clear.all")}
                  </LinkButton>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => setMobileFiltersOpen(false)}
                  >
                    {t("discovery.features.search.ui.searchPage.show.results")}
                  </Button>
                </Inline>
              }
            >
              <MarketplaceFacetChoiceGroup
                title={t("discovery.features.search.ui.searchPage.browse.categories")}
                description={t("discovery.features.search.ui.searchPage.mobile.categories.description")}
                allLabel={t("discovery.features.search.ui.searchPage.all.categories")}
                items={categories.map((item) => ({
                  id: item.slug,
                  label: item.name,
                  count: item.item_count,
                }))}
                selectedId={category}
                onSelect={onCategoryChange}
              />
              <MarketplaceFacetChoiceGroup
                title={t("discovery.features.search.ui.searchPage.language")}
                description={t("discovery.features.search.ui.searchPage.mobile.language.description")}
                allLabel={t("discovery.features.search.ui.searchPage.all.languages")}
                items={languageOptions.map((item) => ({
                  id: item.value,
                  label: item.label,
                }))}
                selectedId={language}
                onSelect={(value) => onLanguageChange(value)}
                allLeadingIcon="book"
                itemLeadingIcon="book"
              />
              {dynamicFacets.length > 0 ? (
                <ProgressiveDisclosureGroup
                  title={t("discovery.features.search.ui.searchPage.advanced.filters")}
                  description={t("discovery.features.search.ui.searchPage.mobile.filters.description")}
                  defaultValue={dynamicFacets
                    .filter((facet) => selectedFacetValues(facet).length > 0)
                    .map((facet) => `${facet.kind}:${facet.id}`)}
                  items={dynamicFacets.map((facet) => {
                    const selectedValues = selectedFacetValues(facet).map((value) => value.id);

                    return {
                      value: `${facet.kind}:${facet.id}`,
                      title: facet.label,
                      description: formatFacetDescription(facet),
                      summary: selectedValues.length > 0
                        ? t("discovery.features.search.ui.searchPage.selected.facet.values", {
                            count: selectedValues.length,
                          })
                        : undefined,
                      content: (
                        <MarketplaceFacetChoiceGroup
                          title={t("discovery.features.search.ui.searchPage.facet.choices", { facet: facet.label })}
                          description={formatFacetDescription(facet)}
                          allLabel={t("discovery.features.search.ui.searchPage.any.facet", { facet: facet.label })}
                          items={facet.values.map((value) => ({
                            id: value.id,
                            label: value.label,
                            count: value.count,
                          }))}
                          selectedIds={selectedValues}
                          selectionMode="multiple"
                          onSelect={(value) => {
                            if (value) {
                              onDynamicFilterChange({ kind: facet.kind, id: facet.id, value });
                            } else {
                              onDynamicFilterClear({ kind: facet.kind, id: facet.id });
                            }
                          }}
                        />
                      ),
                    };
                  })}
                />
              ) : null}
            </MarketplaceFilterBottomSheet>
          </>
        ) : null}

        {error ? <Banner tone="danger" title={t("discovery.features.search.ui.searchPage.error")} description={error} /> : null}

        {loading && !data ? (
          <LoadingSpinner label={t("discovery.features.search.ui.searchPage.searching")} />
        ) : data && data.items.length === 0 ? (
          <NoResultsRecovery
            title={t("discovery.features.search.ui.searchPage.no.items.found")}
            description={
              search || category || language || activeDynamicFilterCount > 0
                ? t("discovery.features.search.ui.searchPage.try.adjusting.your.search.or.filters")
                : t("discovery.features.search.ui.searchPage.no.catalog.items.are.available.yet")
            }
            recommendations={featuredCategories.slice(0, 3).map((item) => item.name)}
            trustCue={
              <PlatformCredibilityCue
                title={t("discovery.features.search.ui.searchPage.saved.search.recovery.title")}
                description={t("discovery.features.search.ui.searchPage.saved.search.recovery.description")}
              />
            }
            resetAction={
              <LinkButton href="/search" tone="secondary">
                {t("discovery.features.search.ui.searchPage.all.categories")}
              </LinkButton>
            }
            savedSearchAction={
              <LinkButton href="/account/saved-searches" tone="secondary">
                {t("discovery.features.search.ui.searchPage.save.search")}
              </LinkButton>
            }
          />
        ) : data ? (
          <>
            <Grid
              columns={hasFocusedResults ? { base: 1, lg: 2, "2xl": 3 } : { base: 1, sm: 2, xl: 3 }}
              gap={4}
            >
              {data.items.map((item) => {
                const listingCount = item.market_summary?.active_listing_count ?? 0;
                const hasActiveListings = listingCount > 0;
                const itemDetailHref = buildItemDetailHref(item.slug, dynamicFilters);
                const imageSrc =
                  selectDiscoveryProductAssetUrl(item.product_asset_sets, "search-card") ??
                  item.image_urls[0] ??
                  (item.image_fallback?.usage === "permanent" ? item.image_fallback.url : undefined) ??
                  discoveryAssetUrls.defaultProductImage;
                const imageSrcSet = buildDiscoveryProductAssetSrcSet(
                  item.product_asset_sets,
                  "search-card",
                );

                return (
                  <ListingCard
                    key={item.catalog_item_id}
                    href={itemDetailHref}
                    title={item.title}
                    imageSrc={imageSrc}
                    imageSrcSet={imageSrcSet}
                    imageSizes="(min-width: 1536px) 160px, (min-width: 640px) 160px, 100vw"
                    imageAlt={item.title}
                    imageFallbackSrc={item.image_fallback?.url ?? discoveryAssetUrls.defaultProductImage}
                    imageFallbackAlt={item.image_fallback?.alt ?? t("discovery.features.search.ui.searchPage.default.product.image")}
                    imageFallbackSrcSet={imageVariantSrcSet(item.image_fallback, "card")}
                    imageFallbackSizes="(min-width: 1280px) 18rem, (min-width: 640px) 15rem, 100vw"
                    imageFallbackMode={item.image_fallback?.usage ?? "permanent"}
                    price={formatPrice(item)}
                    priceDetail={formatListingMeta(item)}
                    sellerName={formatSellerSignal(item)}
                    sellerTrustLabel={
                      hasActiveListings
                        ? t("discovery.features.search.ui.searchPage.verified.supply")
                        : t("discovery.features.search.ui.searchPage.offers.open")
                    }
                    sellerVerified={hasActiveListings}
                    fulfillment={formatAvailability(item)}
                    availability={item.blueprint_name ?? item.subtitle ?? uniqueDisplayValues(item.category_names)[0] ?? t("discovery.features.search.ui.searchPage.marketplace")}
                    condition={formatItemLanguage(item)}
                    valueCue={formatValueCue(item)}
                    promotion={
                      hasActiveListings
                        ? t("discovery.features.search.ui.searchPage.available.now")
                        : t("discovery.features.search.ui.searchPage.supply.wanted")
                    }
                    primaryAction={
                      <LinkButton href={itemDetailHref} size="sm">
                        {hasActiveListings
                          ? t("discovery.features.search.ui.searchPage.view.details")
                          : t("discovery.features.search.ui.searchPage.view.market")}
                      </LinkButton>
                    }
                    secondaryAction={false}
                  />
                );
              })}
            </Grid>
            {hasFocusedResults ? (
              <SavedSearchPrompt
                title={t("discovery.features.search.ui.searchPage.save.this.search")}
                description={t("discovery.features.search.ui.searchPage.get.alerts.when.supply.matches")}
                action={
                  <LinkButton href="/account/saved-searches" tone="secondary" size="sm">
                    {t("discovery.features.search.ui.searchPage.save.search")}
                  </LinkButton>
                }
              />
            ) : null}
            {canLoadMore || loadingMore || loadMoreError ? (
              <Stack gap={3}>
                <div ref={loadMoreRef} aria-hidden="true" />
                {loadMoreError ? (
                  <Banner
                    tone="danger"
                    title={t("discovery.features.search.ui.searchPage.load.more.error.title")}
                    description={loadMoreError}
                  />
                ) : null}
                {loadingMore ? (
                  <Inline align="center">
                    <LoadingSpinner label={t("discovery.features.search.ui.searchPage.loading.more.results")} />
                  </Inline>
                ) : null}
                {canLoadMore ? (
                  <Inline align="center">
                    <Button
                      type="button"
                      tone={loadMoreError ? "secondary" : "ghost"}
                      disabled={loadingMore}
                      onClick={onLoadMore}
                    >
                      {loadMoreError
                        ? t("discovery.features.search.ui.searchPage.retry.loading.results")
                        : t("discovery.features.search.ui.searchPage.load.more.results")}
                    </Button>
                  </Inline>
                ) : null}
              </Stack>
            ) : null}
          </>
        ) : null}
      </Stack>
      {bulkAdd && bulkPreview ? (
        <CommerceSheet
          open={bulkSheetOpen}
          onOpenChange={setBulkSheetOpen}
          title={
            bulkActionData?.status === "bulk-added"
              ? t("discovery.features.search.ui.searchPage.bulk.added.title")
              : t("discovery.features.search.ui.searchPage.bulk.preview.title")
          }
          description={t("discovery.features.search.ui.searchPage.bulk.preview.description", {
            eligible: bulkPreview.eligibleCount,
            skipped: bulkPreview.skippedCount,
          })}
          footer={
            <Inline gap={2} align="end">
              <Button
                type="button"
                tone="ghost"
                onClick={() => setBulkSheetOpen(false)}
              >
                {t("discovery.features.search.ui.searchPage.close")}
              </Button>
              {bulkActionData?.status === "bulk-added" ? (
                <LinkButton href="/account/cart">
                  {t("discovery.features.search.ui.searchPage.review.cart")}
                </LinkButton>
              ) : (
                <Button
                  type="button"
                  disabled={!bulkCanCommit || bulkBusy}
                  loading={bulkBusy}
                  onClick={bulkAdd.onCommit}
                >
                  {t("discovery.features.search.ui.searchPage.add.eligible.products")}
                </Button>
              )}
            </Inline>
          }
        >
          <Stack gap={4}>
            {bulkPreview.overLimit ? (
              <Banner
                tone="warning"
                title={t("discovery.features.search.ui.searchPage.bulk.over.limit.title")}
                description={t("discovery.features.search.ui.searchPage.bulk.over.limit.description", {
                  limit: bulkPreview.limit,
                })}
              />
            ) : null}
            {bulkActionData?.status === "bulk-added" ? (
              <Banner
                tone={bulkActionData.failedLineCount > 0 ? "warning" : "success"}
                title={t("discovery.features.search.ui.searchPage.bulk.added.summary", {
                  added: bulkActionData.addedLineCount,
                  merged: bulkActionData.mergedLineCount,
                })}
                description={t("discovery.features.search.ui.searchPage.bulk.added.description", {
                  failed: bulkActionData.failedLineCount,
                })}
              />
            ) : null}
            <div className="grid gap-3 text-sm text-muted-foreground sm:grid-cols-3">
              <div>
                <div className="font-semibold text-foreground">{bulkPreview.totalMatches ?? bulkPreview.eligibleCount + bulkPreview.skippedCount}</div>
                <div>{t("discovery.features.search.ui.searchPage.bulk.matches")}</div>
              </div>
              <div>
                <div className="font-semibold text-foreground">{bulkPreview.eligibleCount}</div>
                <div>{t("discovery.features.search.ui.searchPage.bulk.ready")}</div>
              </div>
              <div>
                <div className="font-semibold text-foreground">{bulkPreview.skippedCount}</div>
                <div>{t("discovery.features.search.ui.searchPage.bulk.need.options")}</div>
              </div>
            </div>
            {bulkPreview.skippedItems.length > 0 ? (
              <Banner
                tone="info"
                title={t("discovery.features.search.ui.searchPage.bulk.skipped.title")}
                description={bulkPreview.skippedItems.slice(0, 3).map((item) => item.message).join(" ")}
              />
            ) : null}
          </Stack>
        </CommerceSheet>
      ) : null}
    </SearchResultsLayout>
  );
}
