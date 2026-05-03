import { t } from "@chase-sets/localization";
import { useEffect, useState } from "react";
import {
  SearchInput,
  Select,
  FilterBar,
  Pagination,
  EmptyState,
  LoadingSpinner,
  Banner,
  Reveal,
  Stack,
  Inline,
  SearchResultsLayout,
  Grid,
  PromoStrip,
  MarketplaceFacetRail,
  MarketplaceLandingHero,
  MarketplaceProductCard,
} from "@chase-sets/design-system";
import type { DiscoveryCategoryItem } from "../../categories/ui/contracts";
import type {
  DiscoverySearchItem,
  DiscoverySearchResponse,
} from "../../../support/client-support/contracts";
import { discoveryAssetUrls } from "../../../support/client-support/assets";
import { uniqueDisplayValues } from "../../../support/item-support/unique-display-values";
import { useDebounce } from "./use-debounce";

const PAGE_SIZE = 24;

const sortOptions = [
  { label: t("discovery.features.search.ui.searchPage.relevance"), value: "relevance" },
  { label: t("discovery.features.search.ui.searchPage.title.a.z"), value: "title_asc" },
  { label: t("discovery.features.search.ui.searchPage.title.z.a"), value: "title_desc" },
  { label: t("discovery.features.search.ui.searchPage.newest"), value: "newest" },
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
    : t("discovery.features.search.ui.searchPage.market.only");
}

export interface SearchPageProps {
  search: string;
  category: string;
  sort: string;
  page: number;
  data: DiscoverySearchResponse | null;
  categories: DiscoveryCategoryItem[];
  loading?: boolean;
  error?: string | null;
  onSearchChange: (value: string) => void;
  onCategoryChange: (value: string) => void;
  onSortChange: (value: string) => void;
  onPageChange: (page: number) => void;
}

export function SearchPage({
  search,
  category,
  sort,
  page,
  data,
  categories,
  loading = false,
  error = null,
  onSearchChange,
  onCategoryChange,
  onSortChange,
  onPageChange,
}: SearchPageProps) {
  const [searchInput, setSearchInput] = useState(search);
  const debouncedSearch = useDebounce(searchInput, 300);

  useEffect(() => {
    setSearchInput(search);
  }, [search]);

  useEffect(() => {
    if (debouncedSearch !== search) {
      onSearchChange(debouncedSearch);
    }
  }, [debouncedSearch, onSearchChange, search]);

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
  const hasFocusedResults =
    search.trim().length > 0 || Boolean(category) || sort !== "relevance" || page > 1;

  return (
    <SearchResultsLayout
      filters={
        <MarketplaceFacetRail
          items={categories.map((item) => ({
            id: item.slug,
            label: item.name,
            count: item.item_count,
          }))}
          selectedId={category}
          onSelect={onCategoryChange}
        />
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
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
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
          <FilterBar sticky={false}>
            <SearchInput
              hideLabel
              placeholder={t("discovery.features.search.ui.searchPage.search.catalog.items")}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
            <Select
              hideLabel
              label={t("discovery.features.search.ui.searchPage.sort")}
              items={sortOptions}
              value={sort}
              onValueChange={onSortChange}
            />
          </FilterBar>
        ) : null}

        {error ? <Banner tone="danger" title={t("discovery.features.search.ui.searchPage.error")} description={error} /> : null}

        {loading && !data ? (
          <LoadingSpinner label={t("discovery.features.search.ui.searchPage.searching")} />
        ) : data && data.items.length === 0 ? (
          <EmptyState
            title={t("discovery.features.search.ui.searchPage.no.items.found")}
            description={
              search || category
                ? t("discovery.features.search.ui.searchPage.try.adjusting.your.search.or.filters")
                : t("discovery.features.search.ui.searchPage.no.catalog.items.are.available.yet")
            }
            icon="search"
          />
        ) : data ? (
          <>
            <Grid columns={{ base: 1, sm: 2, xl: 4 }} gap={4}>
              {data.items.map((item) => {
                const listingCount = item.market_summary?.active_listing_count ?? 0;

                return (
                  <Reveal key={item.catalog_item_id} preset="lift">
                    <MarketplaceProductCard
                      href={`/items/${item.slug}`}
                      title={item.title}
                      subtitle={item.subtitle ?? item.blueprint_name}
                      description={item.description}
                      imageSrc={item.image_urls[0]}
                      imageAlt={item.title}
                      fallbackImageSrc={discoveryAssetUrls.defaultProductImage}
                      fallbackImageAlt={t("discovery.features.search.ui.searchPage.pokemon.card.back")}
                      status={listingCount > 0 ? "available" : "marketOnly"}
                      price={formatPrice(item)}
                      meta={formatListingMeta(item)}
                      actionLabel={listingCount > 0 ? t("discovery.features.search.ui.searchPage.view.listings") : t("discovery.features.search.ui.searchPage.watch.market")}
                      categoryTags={uniqueDisplayValues(item.category_names)}
                      metadataTags={uniqueDisplayValues(item.tags).slice(0, 3)}
                    />
                  </Reveal>
                );
              })}
            </Grid>
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
