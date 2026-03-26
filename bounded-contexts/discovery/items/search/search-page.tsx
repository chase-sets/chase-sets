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
  Stagger,
  Inline,
  Text,
} from "@chase-sets/design-system";
import type { DiscoveryCategoryItem } from "../../categories/ui/contracts";
import type { DiscoverySearchResponse } from "../client-support/contracts";
import { ItemCard } from "./item-card";
import { SearchFilters } from "./search-filters";
import { useDebounce } from "./use-debounce";

const PAGE_SIZE = 24;

const sortOptions = [
  { label: "Relevance", value: "relevance" },
  { label: "Title A-Z", value: "title_asc" },
  { label: "Title Z-A", value: "title_desc" },
  { label: "Newest", value: "newest" },
];

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

  return (
    <div className="grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
      <div className="hidden lg:block">
        <SearchFilters
          categories={categories}
          selectedCategory={category}
          onCategoryChange={(name) => {
            onCategoryChange(name);
            onPageChange(1);
          }}
        />
      </div>

      <Stack gap={4}>
        <FilterBar>
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
            onValueChange={(value) => {
              onSortChange(value);
              onPageChange(1);
            }}
          />
        </FilterBar>

        <Stagger>
          {data ? (
            <Text size="sm" tone="secondary">
              {data.total} {data.total === 1 ? "result" : "results"} found
            </Text>
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
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {data.items.map((item) => (
                  <Reveal key={item.item_id} preset="lift">
                    <ItemCard item={item} href={`/items/${item.item_id}`} />
                  </Reveal>
                ))}
              </div>
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
        </Stagger>
      </Stack>
    </div>
  );
}
