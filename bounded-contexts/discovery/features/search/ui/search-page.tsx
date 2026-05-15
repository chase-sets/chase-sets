import { formatLanguageCodeLabel, t } from "@chase-sets/localization";
import { useState } from "react";
import {
  AppliedFilterChips,
  Button,
  SearchInput,
  Select,
  Pagination,
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
  MarketplaceFacetChoiceGroup,
  MarketplaceFacetRail,
  MarketplaceLandingHero,
  MarketplaceMobileFilterBar,
  MarketplaceMobileFilterDrawer,
  SavedSearchPrompt,
  SearchControlBar,
} from "@chase-sets/design-system";
import type { DiscoveryCategoryItem } from "../../categories/ui/contracts";
import type {
  DiscoveryFacetGroup,
  DiscoverySearchItem,
  DiscoverySearchResponse,
} from "../../../support/client-support/contracts";
import { discoveryAssetUrls } from "../../../support/client-support/assets";
import { uniqueDisplayValues } from "../../../support/item-support/unique-display-values";

const PAGE_SIZE = 24;

const sortOptions = [
  { label: t("discovery.features.search.ui.searchPage.relevance"), value: "relevance" },
  { label: t("discovery.features.search.ui.searchPage.title.a.z"), value: "title_asc" },
  { label: t("discovery.features.search.ui.searchPage.title.z.a"), value: "title_desc" },
  { label: t("discovery.features.search.ui.searchPage.newest"), value: "newest" },
];

const ALL_LANGUAGES = "__all__";

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
  language: string;
  sort: string;
  page: number;
  dynamicFilters: readonly DynamicSearchFilterSelection[];
  data: DiscoverySearchResponse | null;
  categories: DiscoveryCategoryItem[];
  loading?: boolean;
  error?: string | null;
  restoreSearchFocus?: boolean;
  onSearchChange: (value: string) => void;
  onCategoryChange: (value: string) => void;
  onLanguageChange: (value: string) => void;
  onSortChange: (value: string) => void;
  onDynamicFilterChange: (value: DynamicSearchFilterSelection) => void;
  onDynamicFilterClear: (value: Omit<DynamicSearchFilterSelection, "value">) => void;
  onPageChange: (page: number) => void;
}

export function SearchPage({
  search,
  committedSearch = search,
  category,
  language,
  sort,
  page,
  dynamicFilters,
  data,
  categories,
  loading = false,
  error = null,
  restoreSearchFocus = false,
  onSearchChange,
  onCategoryChange,
  onLanguageChange,
  onSortChange,
  onDynamicFilterChange,
  onDynamicFilterClear,
  onPageChange,
}: SearchPageProps) {
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const exactTotal = data?.total ?? data?.items.length ?? 0;
  const totalPages = data?.total ? Math.ceil(data.total / PAGE_SIZE) : 0;
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
  const resultsSummary = t("discovery.features.search.ui.searchPage.results.summary", {
    count: exactTotal,
    category: activeCategoryLabel,
  });
  const hasFocusedResults =
    committedSearch.trim().length > 0 || Boolean(category) || Boolean(language) || activeDynamicFilterCount > 0 || sort !== "relevance" || page > 1;
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
  const categoryFacet = (
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
      {(data?.facets ?? []).map((facet) => {
        const selectedValues = facet.values.filter((value) => value.selected).map((value) => value.id);
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

  return (
    <SearchResultsLayout
      filters={categoryFacet}
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
            filterControlsVisibility="desktop"
            filters={
              <Select
                label={t("discovery.features.search.ui.searchPage.language")}
                items={[
                  { label: t("discovery.features.search.ui.searchPage.all.languages"), value: ALL_LANGUAGES },
                  ...languageOptions,
                ]}
                value={language || ALL_LANGUAGES}
                onValueChange={(value) => onLanguageChange(value === ALL_LANGUAGES ? "" : value)}
              />
            }
            actions={
              <LinkButton href="/search" tone="secondary">
                {t("discovery.features.search.ui.searchPage.clear.all.filters")}
              </LinkButton>
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
            <MarketplaceMobileFilterDrawer
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
              {(data?.facets ?? []).map((facet) => {
                const selectedValues = facet.values.filter((value) => value.selected).map((value) => value.id);

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
                    selectedIds={selectedValues}
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
            </MarketplaceMobileFilterDrawer>
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

                return (
                  <ListingCard
                    key={item.catalog_item_id}
                    href={itemDetailHref}
                    title={item.title}
                    imageSrc={item.image_urls[0] ?? discoveryAssetUrls.defaultProductImage}
                    imageAlt={item.title}
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
            {totalPages > 1 ? (
              <Inline align="center">
                <Pagination
                  page={page}
                  totalPages={totalPages}
                  onPageChange={onPageChange}
                />
              </Inline>
            ) : null}
          </>
        ) : null}
      </Stack>
    </SearchResultsLayout>
  );
}
