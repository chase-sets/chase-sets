import { useState, useMemo } from "react";
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
import { discoveryApi } from "../../support/api/client";
import type { CategoryListResponse } from "../../categories/ui/contracts";
import type { DiscoverySearchResponse } from "./contracts";
import { ItemCard } from "./item-card";
import { SearchFilters } from "./search-filters";
import { useDebounce } from "../use-debounce";
import { useFetch } from "../../support/ui/use-fetch";

const PAGE_SIZE = 24;

const sortOptions = [
  { label: "Relevance", value: "relevance" },
  { label: "Title A-Z", value: "title_asc" },
  { label: "Title Z-A", value: "title_desc" },
  { label: "Newest", value: "newest" },
];

export function SearchPage() {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [sort, setSort] = useState("relevance");
  const [page, setPage] = useState(1);

  const debouncedSearch = useDebounce(search, 300);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (category) params.set("category", category);
    params.set("sort", sort);
    params.set("limit", String(PAGE_SIZE));
    params.set("offset", String((page - 1) * PAGE_SIZE));
    return params.toString();
  }, [debouncedSearch, category, sort, page]);

  const { data, loading, error } = useFetch<DiscoverySearchResponse>(
    () => discoveryApi.get(`/marketplace/items?${query}`),
    [query],
  );

  const { data: categoriesData } = useFetch<CategoryListResponse>(
    () => discoveryApi.get("/marketplace/categories"),
    [],
  );

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;

  return (
    <div className="grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
      <div className="hidden lg:block">
        <SearchFilters
          categories={categoriesData?.items ?? []}
          selectedCategory={category}
          onCategoryChange={(name) => { setCategory(name); setPage(1); }}
        />
      </div>

      <Stack gap={4}>
        <FilterBar>
          <SearchInput
            hideLabel
            placeholder="Search catalog items..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          />
          <Select
            hideLabel
            label="Sort"
            items={sortOptions}
            value={sort}
            onValueChange={setSort}
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
              description={search || category ? "Try adjusting your search or filters." : "No catalog items are available yet."}
              icon="search"
            />
          ) : data ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {data.items.map((item) => (
                  <Reveal key={item.item_id} preset="lift">
                    <ItemCard item={item} />
                  </Reveal>
                ))}
              </div>
              {totalPages > 1 ? (
                <Inline align="center">
                  <Pagination
                    page={page}
                    totalPages={totalPages}
                    onPageChange={setPage}
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





