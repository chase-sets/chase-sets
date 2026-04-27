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
  { label: "Relevance", value: "relevance" },
  { label: "Title A-Z", value: "title_asc" },
  { label: "Title Z-A", value: "title_desc" },
  { label: "Newest", value: "newest" },
];

function formatListingMeta(item: DiscoverySearchItem): string {
  const listingCount = item.market_summary?.active_listing_count ?? 0;
  const visibleQuantity = item.market_summary?.total_visible_quantity ?? 0;

  if (listingCount === 0) {
    return "No active listings";
  }

  return `${listingCount} listing${listingCount === 1 ? "" : "s"} • ${visibleQuantity} available`;
}

function formatPrice(item: DiscoverySearchItem): string {
  const lowestPrice = item.market_summary?.lowest_price_amount;

  return lowestPrice ? `From $${lowestPrice}` : "Market only";
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

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;
  const featuredCategories = categories.slice(0, 5);
  const liveListingItems =
    data?.items.filter((item) => item.market_summary?.active_listing_count).length ?? 0;
  const marketOnlyItems = data ? data.items.length - liveListingItems : 0;
  const catalogDepth = categories.reduce(
    (total, current) => total + current.item_count,
    0,
  );
  const activeCategoryLabel = category || "All Categories";
  const hasFocusedResults =
    search.trim().length > 0 || Boolean(category) || sort !== "relevance" || page > 1;

  return (
    <SearchResultsLayout
      filters={
        <MarketplaceFacetRail
          items={categories.map((item) => ({
            id: item.name,
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
                { label: "Marketplace", tone: "accent" },
                { label: "Verified supply", tone: "success" },
              ]}
              title="Find cards, comics, figures, sneakers, and memorabilia worth chasing."
              description="Search live supply, compare active markets, and move from discovery to item detail with buyer confidence built in."
              search={
                <SearchInput
                  label="Marketplace search"
                  hideLabel
                  placeholder="Search Pikachu, Spider-Man, Jordan, vintage packs..."
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                />
              }
              filters={[
                {
                  id: "",
                  label: "All",
                  selected: !category,
                  onSelect: () => onCategoryChange(""),
                },
                ...featuredCategories.map((item) => ({
                  id: item.name,
                  label: item.name,
                  selected: category === item.name,
                  onSelect: () => onCategoryChange(item.name),
                })),
              ]}
              metrics={[
                { label: "Results", value: data?.total ?? 0, detail: activeCategoryLabel },
                { label: "Available Now", value: liveListingItems, detail: "With active listings" },
                { label: "Market Only", value: marketOnlyItems, detail: `${catalogDepth} tracked items` },
              ]}
            />
            <PromoStrip
              icon="shield"
              title="Buyer confidence is built into discovery."
              description="Verified supply, transparent pricing, and item-level market history help buyers move with confidence."
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
              placeholder="Search catalog items..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
            <Select
              hideLabel
              label="Sort"
              items={sortOptions}
              value={sort}
              onValueChange={onSortChange}
            />
          </FilterBar>
        ) : null}

        {error ? <Banner tone="danger" title="Error" description={error} /> : null}

        {loading && !data ? (
          <LoadingSpinner label="Searching..." />
        ) : data && data.items.length === 0 ? (
          <EmptyState
            title="No items found"
            description={
              search || category
                ? "Try adjusting your search or filters."
                : "No catalog items are available yet."
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
                      href={`/items/${item.catalog_item_id}`}
                      title={item.title}
                      subtitle={item.subtitle ?? item.blueprint_name}
                      description={item.description}
                      imageSrc={item.image_urls[0]}
                      imageAlt={item.title}
                      fallbackImageSrc={discoveryAssetUrls.defaultProductImage}
                      fallbackImageAlt="Pokemon card back"
                      status={listingCount > 0 ? "available" : "marketOnly"}
                      price={formatPrice(item)}
                      meta={formatListingMeta(item)}
                      actionLabel={listingCount > 0 ? "View listings" : "Watch market"}
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
