import { formatDisplayIdentity, formatLanguageCodeLabel, formatMoney, t } from "@chase-sets/localization";
import { useEffect, useRef, useState } from "react";
import {
  Text,
  Heading,
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
  Slot,
  NoResultsRecovery,
  PlatformCredibilityCue,
  PromoStrip,
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
import { imageVariantSrcSet } from "../../../support/client-support/assets";
import { buildDiscoveryProductAssetImage } from "../../../support/client-support/product-assets";
import { productAlertSettingsHref } from "./product-alert-settings-link";

const AUTO_LOAD_ROOT_MARGIN = "900px";
const FACET_OPTION_SEARCH_THRESHOLD = 8;

const sortOptions = [
  { label: t("discovery.features.search.ui.searchPage.relevance"), value: "relevance" },
  { label: t("discovery.features.search.ui.searchPage.title.a.z"), value: "title_asc" },
  { label: t("discovery.features.search.ui.searchPage.title.z.a"), value: "title_desc" },
  { label: t("discovery.features.search.ui.searchPage.newest"), value: "newest" },
];

type DynamicSearchFilterSelection = Readonly<{
  kind: "field" | "reference" | "dimension";
  id: string;
  value: string;
}>;
type MarketActivityFilter = "" | "any" | "listings" | "offers";

const languageOptions = [
  { label: t("discovery.features.search.ui.searchPage.english"), value: "en" },
  { label: t("discovery.features.search.ui.searchPage.japanese"), value: "ja" },
];

const marketActivityOptions: Array<{ label: string; value: MarketActivityFilter }> = [
  { label: t("discovery.features.search.ui.searchPage.any.market.activity"), value: "" },
  { label: t("discovery.features.search.ui.searchPage.listings.or.offers"), value: "any" },
  { label: t("discovery.features.search.ui.searchPage.listings"), value: "listings" },
  { label: t("discovery.features.search.ui.searchPage.offers"), value: "offers" },
];

function formatPrice(item: DiscoverySearchItem): string | undefined {
  const lowestPrice = item.market_summary?.lowest_price_amount;

  return lowestPrice
    ? t("discovery.features.search.ui.searchPage.from.price", { price: formatMoney(lowestPrice, "USD") })
    : undefined;
}

function formatSearchResultMetadata(item: DiscoverySearchItem): string | undefined {
  if (!item.language_code || item.language_code === "en") {
    return undefined;
  }

  return formatLanguageCodeLabel(item.language_code);
}

function formatSearchIdentityLine(item: DiscoverySearchItem): string | undefined {
  return item.subtitle?.trim() || undefined;
}

function findLanguageLabel(language: string): string {
  return languageOptions.find((item) => item.value === language)?.label ?? language;
}

function findMarketActivityLabel(marketActivity: MarketActivityFilter): string {
  return marketActivityOptions.find((item) => item.value === marketActivity)?.label ?? marketActivity;
}

function formatFacetDescription(facet: DiscoveryFacetGroup): string {
  switch (facet.kind) {
    case "dimension":
      return t("discovery.features.search.ui.searchPage.dimension.facet.description");
    case "reference":
      return t("discovery.features.search.ui.searchPage.reference.facet.description");
    case "field":
    default:
      return t("discovery.features.search.ui.searchPage.field.facet.description");
  }
}

function facetOptionSearchProps(facet: DiscoveryFacetGroup) {
  return {
    searchable: facet.values.length > FACET_OPTION_SEARCH_THRESHOLD,
    searchLabel: t("discovery.features.search.ui.searchPage.facet.option.search.label", {
      facet: facet.label,
    }),
    searchPlaceholder: t("discovery.features.search.ui.searchPage.facet.option.search.placeholder", {
      facet: facet.label,
    }),
    searchEmptyLabel: t("discovery.features.search.ui.searchPage.facet.option.search.empty", {
      facet: facet.label,
    }),
  };
}

function buildDynamicAppliedFilters(
  facets: readonly DiscoveryFacetGroup[],
  dynamicFilters: readonly DynamicSearchFilterSelection[],
  onDynamicFilterChange: (value: DynamicSearchFilterSelection) => void,
) {
  return dynamicFilters.map((filter) => {
    const facet = facets.find((entry) => entry.kind === filter.kind && entry.id === filter.id);
    const value = facet?.values.find((entry) => entry.id === filter.value);
    const label =
      facet && value
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

function buildItemDetailHref(slug: string, dynamicFilters: readonly DynamicSearchFilterSelection[]) {
  const params = new URLSearchParams();

  for (const filter of dynamicFilters) {
    if (filter.kind === "dimension" && filter.id && filter.value) {
      params.append(`dimension.${filter.id}`, filter.value);
    }
  }

  const query = params.toString();

  return `/items/${slug}${query ? `?${query}` : ""}`;
}

function withMarketIntent(href: string, market: "buy" | "sell" | "watch") {
  const [pathname, query = ""] = href.split("?");
  const params = new URLSearchParams(query);
  params.set("market", market);
  const nextQuery = params.toString();

  return `${pathname}${nextQuery ? `?${nextQuery}` : ""}`;
}

export interface SearchPageProps {
  search: string;
  committedSearch?: string;
  category: string;
  tag?: string;
  language: string;
  marketActivity: MarketActivityFilter;
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
  onMarketActivityChange: (value: MarketActivityFilter) => void;
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
  error?: string | null;
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
  marketActivity,
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
  onMarketActivityChange,
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
  const liveListingItems = data?.items.filter((item) => item.market_summary?.active_listing_count).length ?? 0;
  const marketOnlyItems = data ? data.items.length - liveListingItems : 0;
  const catalogDepth = categories.reduce((total, current) => total + current.item_count, 0);
  const activeCategoryLabel =
    categories.find((item) => item.slug === category)?.name ??
    t("discovery.features.search.ui.searchPage.all.categories");
  const activeLanguageLabel = language
    ? findLanguageLabel(language)
    : t("discovery.features.search.ui.searchPage.all.languages");
  const activeMarketActivityLabel = marketActivity
    ? findMarketActivityLabel(marketActivity)
    : t("discovery.features.search.ui.searchPage.any.market.activity");
  const activeDynamicFilterCount = dynamicFilters.length;
  const dynamicFacets = data?.facets ?? [];
  const resultsSummary = t("discovery.features.search.ui.searchPage.results.summary", {
    count: exactTotal,
    category: activeCategoryLabel,
  });
  const hasFocusedResults =
    committedSearch.trim().length > 0 ||
    Boolean(category) ||
    Boolean(tag) ||
    Boolean(language) ||
    Boolean(marketActivity) ||
    activeDynamicFilterCount > 0 ||
    sort !== "relevance";
  const canLoadMore = Boolean(data?.nextCursor && onLoadMore);
  const dynamicAppliedFilters = buildDynamicAppliedFilters(data?.facets ?? [], dynamicFilters, onDynamicFilterChange);
  const progressiveFacetLabels = {
    showMoreLabel: t("discovery.features.search.ui.searchPage.facet.option.show.more"),
    showLessLabel: t("discovery.features.search.ui.searchPage.facet.option.show.less"),
  };
  const appliedFilters = [
    ...(committedSearch.trim()
      ? [
          {
            id: "search",
            label: t("discovery.features.search.ui.searchPage.search.filter.label", {
              search: committedSearch,
            }),
            onRemove: () => onSearchChange(""),
          },
        ]
      : []),
    ...(category
      ? [
          {
            id: "category",
            label: t("discovery.features.search.ui.searchPage.category.filter.label", {
              category: activeCategoryLabel,
            }),
            onRemove: () => onCategoryChange(""),
          },
        ]
      : []),
    ...(language
      ? [
          {
            id: "language",
            label: t("discovery.features.search.ui.searchPage.language.filter.label", {
              language: activeLanguageLabel,
            }),
            onRemove: () => onLanguageChange(""),
          },
        ]
      : []),
    ...(marketActivity
      ? [
          {
            id: "marketActivity",
            label: t("discovery.features.search.ui.searchPage.market.activity.filter.label", {
              marketActivity: activeMarketActivityLabel,
            }),
            onRemove: () => onMarketActivityChange(""),
          },
        ]
      : []),
    ...(tag
      ? [
          {
            id: "tag",
            label: t("discovery.features.search.ui.searchPage.tag.filter.label", {
              tag,
            }),
            onRemove: () => onTagClear?.(),
          },
        ]
      : []),
    ...(sort !== "relevance"
      ? [
          {
            id: "sort",
            label: t("discovery.features.search.ui.searchPage.sort.filter.label", {
              sort: sortOptions.find((item) => item.value === sort)?.label ?? sort,
            }),
            onRemove: () => onSortChange("relevance"),
          },
        ]
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
        {...progressiveFacetLabels}
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
        {...progressiveFacetLabels}
      />
      <MarketplaceFacetRail
        title={t("discovery.features.search.ui.searchPage.market.activity")}
        description={t("discovery.features.search.ui.searchPage.market.activity.description")}
        allLabel={t("discovery.features.search.ui.searchPage.any.market.activity")}
        items={marketActivityOptions
          .filter((item) => item.value)
          .map((item) => ({
            id: item.value,
            label: item.label,
          }))}
        selectedId={marketActivity}
        onSelect={(value) => onMarketActivityChange(value as MarketActivityFilter)}
        {...progressiveFacetLabels}
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
            {...facetOptionSearchProps(facet)}
            selectedIds={selectedValues}
            selectionMode="multiple"
            onSelect={(value) => {
              if (value) {
                onDynamicFilterChange({ kind: facet.kind, id: facet.id, value });
              } else {
                onDynamicFilterClear({ kind: facet.kind, id: facet.id });
              }
            }}
            {...progressiveFacetLabels}
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

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          onLoadMore();
        }
      },
      { rootMargin: AUTO_LOAD_ROOT_MARGIN },
    );

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
                {
                  label: t("discovery.features.search.ui.searchPage.results"),
                  value: exactTotal,
                  detail: activeCategoryLabel,
                },
                {
                  label: t("discovery.features.search.ui.searchPage.available.now"),
                  value: liveListingItems,
                  detail: t("discovery.features.search.ui.searchPage.with.active.listings"),
                },
                {
                  label: t("discovery.features.search.ui.searchPage.market.only.2"),
                  value: marketOnlyItems,
                  detail: t("discovery.features.search.ui.searchPage.tracked.items", { count: catalogDepth }),
                },
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
                  <Button type="button" size="sm" onClick={() => setMobileFiltersOpen(false)}>
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
                {...progressiveFacetLabels}
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
                {...progressiveFacetLabels}
              />
              <MarketplaceFacetChoiceGroup
                title={t("discovery.features.search.ui.searchPage.market.activity")}
                description={t("discovery.features.search.ui.searchPage.market.activity.description")}
                allLabel={t("discovery.features.search.ui.searchPage.any.market.activity")}
                items={marketActivityOptions
                  .filter((item) => item.value)
                  .map((item) => ({
                    id: item.value,
                    label: item.label,
                  }))}
                selectedId={marketActivity}
                onSelect={(value) => onMarketActivityChange(value as MarketActivityFilter)}
                allLeadingIcon="search"
                itemLeadingIcon="search"
                {...progressiveFacetLabels}
              />
              {dynamicFacets.map((facet) => {
                const selectedValues = selectedFacetValues(facet).map((value) => value.id);

                return (
                  <MarketplaceFacetChoiceGroup
                    key={`${facet.kind}:${facet.id}`}
                    title={facet.label}
                    description={formatFacetDescription(facet)}
                    allLabel={t("discovery.features.search.ui.searchPage.any.facet", { facet: facet.label })}
                    items={facet.values.map((value) => ({
                      id: value.id,
                      label: value.label,
                      count: value.count,
                    }))}
                    {...facetOptionSearchProps(facet)}
                    selectedIds={selectedValues}
                    selectionMode="multiple"
                    onSelect={(value) => {
                      if (value) {
                        onDynamicFilterChange({ kind: facet.kind, id: facet.id, value });
                      } else {
                        onDynamicFilterClear({ kind: facet.kind, id: facet.id });
                      }
                    }}
                    {...progressiveFacetLabels}
                  />
                );
              })}
            </MarketplaceFilterBottomSheet>
          </>
        ) : null}

        {error ? (
          <Banner tone="danger" title={t("discovery.features.search.ui.searchPage.error")} description={error} />
        ) : null}
        {bulkAdd?.error ? (
          <Banner
            tone="danger"
            title={t("discovery.features.search.ui.searchPage.bulk.error.title")}
            description={bulkAdd.error}
          />
        ) : null}

        {loading && !data ? (
          <LoadingSpinner label={t("discovery.features.search.ui.searchPage.searching")} />
        ) : data && data.items.length === 0 ? (
          <NoResultsRecovery
            title={t("discovery.features.search.ui.searchPage.no.items.found")}
            description={
              search || category || language || marketActivity || activeDynamicFilterCount > 0
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
              <LinkButton href={productAlertSettingsHref} tone="secondary">
                {t("discovery.features.search.ui.searchPage.save.search")}
              </LinkButton>
            }
          />
        ) : data ? (
          <>
            {data.retrievalMode === "rescue" ? (
              <Stack gap={1}>
                <Heading level={2} visualSize={4}>
                  {t("discovery.features.search.ui.searchPage.closest.matches")}
                </Heading>
                <Text size="sm" tone="secondary">
                  {data.lexicalCount
                    ? t("discovery.features.search.ui.searchPage.closest.matches.with.lexical", {
                        count: data.lexicalCount,
                      })
                    : t("discovery.features.search.ui.searchPage.closest.matches.semantic.only")}
                </Text>
              </Stack>
            ) : null}
            <Grid columns={{ base: 1, lg: 2, "2xl": 3 }} gap={4}>
              {data.items.map((item) => {
                const listingCount = item.market_summary?.active_listing_count ?? 0;
                const hasActiveListings = listingCount > 0;
                const itemDetailHref = buildItemDetailHref(item.slug, dynamicFilters);
                const displayIdentity = formatDisplayIdentity(item.title, item.subtitle);
                const productAssetImage = buildDiscoveryProductAssetImage(
                  item.product_asset_sets,
                  "search-card",
                  "(min-width: 768px) 164px, 124px",
                );
                const imageSrc =
                  productAssetImage?.src ??
                  item.image_urls[0] ??
                  (item.image_fallback?.usage === "permanent" ? item.image_fallback.url : undefined);
                const buyHref = withMarketIntent(itemDetailHref, "buy");
                const sellHref = withMarketIntent(itemDetailHref, "sell");
                const watchHref = withMarketIntent(itemDetailHref, "watch");
                const primaryIntent = hasActiveListings
                  ? {
                      href: buyHref,
                      label: t("discovery.features.search.ui.searchPage.buy.intent"),
                      accessibleLabel: t("discovery.features.search.ui.searchPage.buy"),
                    }
                  : {
                      href: sellHref,
                      label: t("discovery.features.search.ui.searchPage.sell.intent"),
                      accessibleLabel: t("discovery.features.search.ui.searchPage.sell"),
                    };
                const secondaryIntents = hasActiveListings
                  ? [
                      {
                        href: sellHref,
                        label: t("discovery.features.search.ui.searchPage.sell.intent"),
                        accessibleLabel: t("discovery.features.search.ui.searchPage.sell"),
                      },
                      {
                        href: watchHref,
                        label: t("discovery.features.search.ui.searchPage.watch.intent"),
                        accessibleLabel: t("discovery.features.search.ui.searchPage.watch"),
                      },
                    ]
                  : [
                      {
                        href: buyHref,
                        label: t("discovery.features.search.ui.searchPage.buy.intent"),
                        accessibleLabel: t("discovery.features.search.ui.searchPage.buy"),
                      },
                      {
                        href: watchHref,
                        label: t("discovery.features.search.ui.searchPage.watch.intent"),
                        accessibleLabel: t("discovery.features.search.ui.searchPage.watch"),
                      },
                    ];

                return (
                  <ListingCard
                    key={item.catalog_item_id}
                    cardLayout="search-result"
                    href={itemDetailHref}
                    title={item.title}
                    image={productAssetImage ?? undefined}
                    imageSrc={imageSrc}
                    imageSlot="compact-product"
                    imageAlt={displayIdentity}
                    imageFallbackSrc={item.image_fallback?.url}
                    imageFallbackAlt={displayIdentity}
                    imageFallbackSrcSet={imageVariantSrcSet(item.image_fallback, "card")}
                    imageFallbackSizes="(min-width: 1280px) 18rem, (min-width: 640px) 15rem, 100vw"
                    imageFallbackMode={item.image_fallback?.usage ?? "permanent"}
                    detailLinkLabel={t("localization.listingCard.view.details.for", { identity: displayIdentity })}
                    saveLabel={t("localization.listingCard.save", { identity: displayIdentity })}
                    savedLabel={t("localization.listingCard.saved", { identity: displayIdentity })}
                    watchingLabel={t("localization.listingCard.watching", { identity: displayIdentity })}
                    price={hasActiveListings ? formatPrice(item) : undefined}
                    subtitle={formatSearchIdentityLine(item)}
                    valueCue={formatSearchResultMetadata(item)}
                    primaryAction={
                      <LinkButton
                        href={primaryIntent.href}
                        aria-label={primaryIntent.accessibleLabel}
                        size="sm"
                        tone="primary"
                      >
                        {primaryIntent.label}
                      </LinkButton>
                    }
                    secondaryAction={
                      <Inline gap={1}>
                        {secondaryIntents.map((intent) => (
                          <LinkButton
                            key={intent.accessibleLabel}
                            href={intent.href}
                            aria-label={intent.accessibleLabel}
                            tone="ghost"
                            size="sm"
                          >
                            {intent.label}
                          </LinkButton>
                        ))}
                      </Inline>
                    }
                  />
                );
              })}
            </Grid>
            {hasFocusedResults ? (
              <SavedSearchPrompt
                title={t("discovery.features.search.ui.searchPage.save.this.search")}
                description={t("discovery.features.search.ui.searchPage.get.alerts.when.supply.matches")}
                action={
                  <LinkButton href={productAlertSettingsHref} tone="secondary" size="sm">
                    {t("discovery.features.search.ui.searchPage.save.search")}
                  </LinkButton>
                }
              />
            ) : null}
            {canLoadMore || loadingMore || loadMoreError ? (
              <Stack gap={3}>
                <Slot ref={loadMoreRef} purpose="observer" />
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
              <Button type="button" tone="ghost" onClick={() => setBulkSheetOpen(false)}>
                {t("discovery.features.search.ui.searchPage.close")}
              </Button>
              {bulkActionData?.status === "bulk-added" ? (
                <LinkButton href="/account/cart">{t("discovery.features.search.ui.searchPage.review.cart")}</LinkButton>
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
            <Grid columns={{ base: 1, sm: 3 }} gap={3}>
              <Stack gap={1}>
                <Text element="div" weight="semibold">
                  {bulkPreview.totalMatches ?? bulkPreview.eligibleCount + bulkPreview.skippedCount}
                </Text>
                <Text size="sm" tone="secondary">
                  {t("discovery.features.search.ui.searchPage.bulk.matches")}
                </Text>
              </Stack>
              <Stack gap={1}>
                <Text element="div" weight="semibold">
                  {bulkPreview.eligibleCount}
                </Text>
                <Text size="sm" tone="secondary">
                  {t("discovery.features.search.ui.searchPage.bulk.ready")}
                </Text>
              </Stack>
              <Stack gap={1}>
                <Text element="div" weight="semibold">
                  {bulkPreview.skippedCount}
                </Text>
                <Text size="sm" tone="secondary">
                  {t("discovery.features.search.ui.searchPage.bulk.need.options")}
                </Text>
              </Stack>
            </Grid>
            {bulkPreview.skippedItems.length > 0 ? (
              <Banner
                tone="info"
                title={t("discovery.features.search.ui.searchPage.bulk.skipped.title")}
                description={bulkPreview.skippedItems
                  .slice(0, 3)
                  .map((item) => item.message)
                  .join(" ")}
              />
            ) : null}
          </Stack>
        </CommerceSheet>
      ) : null}
    </SearchResultsLayout>
  );
}
