import { formatLanguageCodeLabel, t } from "@chase-sets/localization";
import {
  AppliedFilterChips,
  SearchInput,
  Select,
  Pagination,
  LoadingSpinner,
  Banner,
  Button,
  Stack,
  Inline,
  SearchResultsLayout,
  Grid,
  LinkButton,
  ListingCard,
  NoResultsRecovery,
  PlatformCredibilityCue,
  PromoStrip,
  MarketplaceFacetRail,
  MarketplaceLandingHero,
  SavedSearchPrompt,
  SearchControlBar,
} from "@chase-sets/design-system";
import type { DiscoveryCategoryItem } from "../../categories/ui/contracts";
import type {
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

export interface SearchPageProps {
  search: string;
  committedSearch?: string;
  category: string;
  language: string;
  sort: string;
  page: number;
  data: DiscoverySearchResponse | null;
  categories: DiscoveryCategoryItem[];
  loading?: boolean;
  error?: string | null;
  restoreSearchFocus?: boolean;
  onSearchChange: (value: string) => void;
  onCategoryChange: (value: string) => void;
  onLanguageChange: (value: string) => void;
  onSortChange: (value: string) => void;
  onPageChange: (page: number) => void;
}

export function SearchPage({
  search,
  committedSearch = search,
  category,
  language,
  sort,
  page,
  data,
  categories,
  loading = false,
  error = null,
  restoreSearchFocus = false,
  onSearchChange,
  onCategoryChange,
  onLanguageChange,
  onSortChange,
  onPageChange,
}: SearchPageProps) {
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
  const hasFocusedResults =
    committedSearch.trim().length > 0 || Boolean(category) || Boolean(language) || sort !== "relevance" || page > 1;
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
  ];

  return (
    <SearchResultsLayout
      filters={
        hasFocusedResults ? null : (
          <MarketplaceFacetRail
          items={categories.map((item) => ({
            id: item.slug,
            label: item.name,
            count: item.item_count,
          }))}
          selectedId={category}
          onSelect={onCategoryChange}
          />
        )
      }
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
            filters={
              <Inline gap={2} align="end">
                <Select
                  label={t("discovery.features.search.ui.searchPage.language")}
                  items={[
                    { label: t("discovery.features.search.ui.searchPage.all.languages"), value: ALL_LANGUAGES },
                    ...languageOptions,
                  ]}
                  value={language || ALL_LANGUAGES}
                  onValueChange={(value) => onLanguageChange(value === ALL_LANGUAGES ? "" : value)}
                />
                <LinkButton href="/search" tone="secondary" size="sm">
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
            summary={t("discovery.features.search.ui.searchPage.results.summary", {
              count: exactTotal,
              category: activeCategoryLabel,
            })}
          />
        ) : null}

        {error ? <Banner tone="danger" title={t("discovery.features.search.ui.searchPage.error")} description={error} /> : null}

        {loading && !data ? (
          <LoadingSpinner label={t("discovery.features.search.ui.searchPage.searching")} />
        ) : data && data.items.length === 0 ? (
          <NoResultsRecovery
            title={t("discovery.features.search.ui.searchPage.no.items.found")}
            description={
              search || category || language
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
            <Grid columns={{ base: 1, sm: 2, xl: 3 }} gap={4}>
              {data.items.map((item) => {
                const listingCount = item.market_summary?.active_listing_count ?? 0;
                const hasActiveListings = listingCount > 0;

                return (
                  <ListingCard
                    key={item.catalog_item_id}
                    href={`/items/${item.slug}`}
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
                      <LinkButton href={`/items/${item.slug}`} size="sm">
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
              <Inline>
                <Button
                  tone={!category ? "primary" : "ghost"}
                  size="sm"
                  leadingIcon="grid"
                  onClick={() => onCategoryChange("")}
                >
                  {t("discovery.features.search.ui.searchPage.all.categories")}
                </Button>
                {featuredCategories.map((item) => (
                  <Button
                    key={item.slug}
                    tone={category === item.slug ? "primary" : "ghost"}
                    size="sm"
                    leadingIcon="tag"
                onClick={() => onCategoryChange(item.slug)}
              >
                {t("discovery.features.search.ui.searchPage.category.count.label", {
                  category: item.name,
                  count: item.item_count,
                })}
              </Button>
                ))}
              </Inline>
            ) : null}
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
