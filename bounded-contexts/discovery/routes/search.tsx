import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import {
  redirect,
  useLoaderData,
  useNavigate,
  useNavigation,
  useSearchParams,
} from "react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { useRealtimePatchedSnapshot } from "@chase-sets/platform-runtime/realtime-react";
import { createDiscoveryRequestApiClient } from "../support/request-support/api-client";
import type {
  CategoryListResponse,
  DiscoverySearchResponse,
} from "../support/request-support/api-client";
import { applyDiscoverySearchPatch } from "../support/client-support/realtime-market";
import { SearchPage } from "../features/search/ui/search-page";
import { discoveryRealtimeRouteTopics } from "../support/realtime-support/topics";

const PAGE_SIZE = 24;
const SEARCH_DEBOUNCE_MS = 300;
const MARKETPLACE_DESCRIPTION =
  t("discovery.routes.search.browse.the.chase.sets.marketplace.with");
const EMPTY_SEARCH_RESULT = {
  search: "",
  category: "",
  language: "",
  sort: "relevance",
  page: 1,
  dynamicFilters: [],
  data: null,
  categories: [],
} as const;
const EMPTY_CATEGORY_LIST: CategoryListResponse = {
  items: [],
  total: 0,
  count: 0,
};
const EMPTY_DISCOVERY_SEARCH_RESPONSE: DiscoverySearchResponse = {
  items: [],
  facets: [],
  total: 0,
  count: 0,
  nextCursor: null,
};
const EMPTY_EXTRA_PAGES: readonly DiscoverySearchResponse[] = [];

type DynamicSearchFilterSelection = Readonly<{
  kind: "field" | "dimension";
  id: string;
  value: string;
}>;

function buildSearchQuery({
  search,
  category,
  language,
  sort,
  cursor,
  dynamicFilters,
}: {
  search: string;
  category: string;
  language: string;
  sort: string;
  cursor?: string | null;
  dynamicFilters: readonly DynamicSearchFilterSelection[];
}) {
  const params = new URLSearchParams();
  if (search) {
    params.set("search", search);
  }
  if (category) {
    params.set("category", category);
  }
  if (language) {
    params.set("language", language);
  }
  params.set("sort", sort);
  params.set("limit", String(PAGE_SIZE));
  if (cursor) {
    params.set("cursor", cursor);
  }
  appendDynamicSearchFilters(params, dynamicFilters);
  return params.toString();
}

function buildCategoryPath(categorySlug: string, current: URLSearchParams) {
  const next = new URLSearchParams(current);
  next.delete("category");
  next.delete("page");
  const query = next.toString();

  return `${categorySlug ? `/categories/${categorySlug}` : "/search"}${query ? `?${query}` : ""}`;
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  if (url.searchParams.has("page")) {
    url.searchParams.delete("page");
    throw redirect(`${url.pathname}${url.search ? url.search : ""}`, { status: 301 });
  }

  const search = url.searchParams.get("q") ?? url.searchParams.get("search") ?? "";
  const categoryParam = params.categorySlug ?? url.searchParams.get("category") ?? "";
  const language = url.searchParams.get("language") ?? "";
  const sort = url.searchParams.get("sort") ?? "relevance";
  const dynamicFilters = readDynamicSearchFilters(url.searchParams);
  const api = createDiscoveryRequestApiClient(request);

  const [categoryBySlug, categories] = await Promise.all([
    categoryParam ? api.getCategoryBySlug(categoryParam).catch(() => null) : Promise.resolve(null),
    api.listCategories().catch(() => EMPTY_CATEGORY_LIST),
  ]);
  const resolvedCategory = categoryBySlug ?? categories.items.find(
    (item) =>
      item.name === categoryParam ||
      item.key === categoryParam ||
      item.category_id === categoryParam,
  ) ?? null;
  const category = resolvedCategory?.slug ?? categoryParam;

  if (params.categorySlug && resolvedCategory && params.categorySlug !== resolvedCategory.slug) {
    throw redirect(buildCategoryPath(resolvedCategory.slug, url.searchParams), { status: 301 });
  }

  if (!params.categorySlug && url.searchParams.has("category") && resolvedCategory) {
    throw redirect(buildCategoryPath(resolvedCategory.slug, url.searchParams), { status: 301 });
  }

  const data = await api.searchItems(
    buildSearchQuery({ search, category, language, sort, dynamicFilters }),
  ).catch(() => EMPTY_DISCOVERY_SEARCH_RESPONSE);
  const canonicalPath = params.categorySlug && resolvedCategory
    ? buildCategoryPath(resolvedCategory.slug, url.searchParams)
    : buildCategoryPath("", url.searchParams);

  return {
    search,
    category,
    language,
    sort,
    dynamicFilters,
    data,
    categories: categories.items,
    canonicalUrl: new URL(canonicalPath, url.origin).toString(),
  };
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  ...buildOpenGraphMeta({
    title: data?.search
      ? t("discovery.routes.search.search.meta.title", { search: data.search })
      : t("discovery.routes.search.marketplace.search"),
    description: MARKETPLACE_DESCRIPTION,
  }),
  ...(data?.canonicalUrl
    ? [{ tagName: "link", rel: "canonical", href: data.canonicalUrl }]
    : []),
];

export default function DiscoverySearchRoute() {
  const data = useLoaderData<typeof loader>() ?? EMPTY_SEARCH_RESULT;

  return (
    <DiscoverySearchRealtimeView
      data={data}
    />
  );
}

type DiscoverySearchRouteData =
  | typeof EMPTY_SEARCH_RESULT
  | Awaited<ReturnType<typeof loader>>;

function DiscoverySearchRealtimeView({ data }: { data: DiscoverySearchRouteData }) {
  const navigate = useNavigate();
  const navigation = useNavigation();
  const [searchParams, setSearchParams] = useSearchParams();
  const draftSearchRef = useRef(data.search);
  const pendingSearchRef = useRef<string | null>(null);
  const restoreSearchFocusRef = useRef(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [draftSearchState, setDraftSearchState] = useState(() => ({
    committedSearch: data.search,
    value: data.search,
  }));
  const dynamicFilters = data.dynamicFilters ?? [];
  const resultSetKey = JSON.stringify([data.search, data.category, data.language, data.sort, dynamicFilters]);
  const resultSetKeyRef = useRef(resultSetKey);
  const [extraPageState, setExtraPageState] = useState<{
    key: string;
    pages: DiscoverySearchResponse[];
  }>({ key: resultSetKey, pages: [] });
  const [loadMoreState, setLoadMoreState] = useState<{
    loading: boolean;
    error: string | null;
  }>({ loading: false, error: null });
  const loadMoreInFlightRef = useRef(false);
  let draftSearch = draftSearchState.value;
  const activeExtraPages = extraPageState.key === resultSetKey
    ? extraPageState.pages
    : EMPTY_EXTRA_PAGES;
  const accumulatedData = useMemo(
    () => mergeDiscoverySearchResponses(data.data, activeExtraPages),
    [activeExtraPages, data.data],
  );
  const accumulatedSnapshotKey = JSON.stringify([
    resultSetKey,
    data.data?.nextCursor,
    activeExtraPages.length,
    activeExtraPages.at(-1)?.nextCursor,
  ]);
  const visibleData = useRealtimePatchedSnapshot<DiscoverySearchResponse | null>({
    initialSnapshot: accumulatedData,
    snapshotKey: accumulatedSnapshotKey,
    topics: discoveryRealtimeRouteTopics.search().topics,
    applyPatch: applyDiscoverySearchPatch,
    onSyncRequired: reloadForRealtimeSync,
  });

  useEffect(() => {
    resultSetKeyRef.current = resultSetKey;
    loadMoreInFlightRef.current = false;
    setExtraPageState({ key: resultSetKey, pages: [] });
    setLoadMoreState({ loading: false, error: null });
  }, [resultSetKey]);

  if (
    draftSearchState.committedSearch !== data.search &&
    (pendingSearchRef.current === null || pendingSearchRef.current === data.search)
  ) {
    pendingSearchRef.current = null;
    draftSearchRef.current = data.search;
    draftSearch = data.search;
    setDraftSearchState({
      committedSearch: data.search,
      value: data.search,
    });
  }

  const clearSearchTimer = useCallback(() => {
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current);
      searchTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearSearchTimer, [clearSearchTimer]);

  const updateSearchParams = useCallback((nextValues: {
    search?: string;
    category?: string;
    language?: string;
    sort?: string;
    dynamicFilter?: DynamicSearchFilterSelection;
    dynamicFilterClear?: Omit<DynamicSearchFilterSelection, "value">;
  }, replace = false) => {
    if (nextValues.category !== undefined) {
      const current = new URLSearchParams(searchParams);
      const search = pendingSearchRef.current ?? draftSearchRef.current;
      if (search) {
        current.set("q", search);
        current.delete("search");
      } else {
        current.delete("q");
        current.delete("search");
      }
      current.delete("page");
      navigate(buildCategoryPath(nextValues.category, current), { preventScrollReset: true });
      return;
    }

    setSearchParams((current) => {
      const next = new URLSearchParams(current);

      if (nextValues.search !== undefined) {
        if (nextValues.search) {
          next.set("q", nextValues.search);
          next.delete("search");
        } else {
          next.delete("q");
          next.delete("search");
        }
        next.delete("page");
      }

      if (nextValues.sort !== undefined) {
        if (nextValues.sort && nextValues.sort !== "relevance") {
          next.set("sort", nextValues.sort);
        } else {
          next.delete("sort");
        }
        next.delete("page");
      }

      if (nextValues.language !== undefined) {
        if (nextValues.language) {
          next.set("language", nextValues.language);
        } else {
          next.delete("language");
        }
        next.delete("page");
      }

      if (nextValues.dynamicFilter !== undefined) {
        toggleDynamicSearchFilter(next, nextValues.dynamicFilter);
        next.delete("page");
      }

      if (nextValues.dynamicFilterClear !== undefined) {
        next.delete(dynamicSearchFilterKey({ ...nextValues.dynamicFilterClear, value: "" }));
        next.delete("page");
      }

      return next;
    }, { preventScrollReset: true, replace });
  }, [navigate, searchParams, setSearchParams]);

  function handleSearchChange(value: string) {
    restoreSearchFocusRef.current = true;
    draftSearchRef.current = value;
    pendingSearchRef.current = value;
    setDraftSearchState((current) => ({ ...current, value }));
    clearSearchTimer();
    searchTimerRef.current = setTimeout(() => {
      updateSearchParams({ search: pendingSearchRef.current ?? "" }, true);
    }, SEARCH_DEBOUNCE_MS);
  }

  function handleImmediateSearchParamChange(nextValues: {
    category?: string;
    language?: string;
    sort?: string;
    dynamicFilter?: DynamicSearchFilterSelection;
    dynamicFilterClear?: Omit<DynamicSearchFilterSelection, "value">;
  }) {
    clearSearchTimer();
    const search = pendingSearchRef.current ?? draftSearchRef.current;
    pendingSearchRef.current = search;
    updateSearchParams({ search, ...nextValues });
  }

  const handleLoadMore = useCallback(async () => {
    if (!visibleData?.nextCursor || loadMoreInFlightRef.current) {
      return;
    }

    const requestKey = resultSetKeyRef.current;
    const query = buildSearchQuery({
      search: data.search,
      category: data.category,
      language: data.language,
      sort: data.sort,
      dynamicFilters,
      cursor: visibleData.nextCursor,
    });

    loadMoreInFlightRef.current = true;
    setLoadMoreState({ loading: true, error: null });
    try {
      const response = await fetch(`/api/marketplace/items?${query}`, {
        credentials: "include",
      });
      if (!response.ok) {
        throw new Error(`Search request failed with ${response.status}.`);
      }

      const nextPage = await response.json() as DiscoverySearchResponse;
      if (resultSetKeyRef.current !== requestKey) {
        return;
      }

      setExtraPageState((current) => current.key === requestKey
        ? { key: current.key, pages: [...current.pages, nextPage] }
        : current);
      setLoadMoreState({ loading: false, error: null });
    } catch {
      if (resultSetKeyRef.current === requestKey) {
        setLoadMoreState({
          loading: false,
          error: t("discovery.features.search.ui.searchPage.load.more.error.description"),
        });
      }
    } finally {
      if (resultSetKeyRef.current === requestKey) {
        loadMoreInFlightRef.current = false;
      }
    }
  }, [
    data.category,
    data.language,
    data.search,
    data.sort,
    dynamicFilters,
    visibleData?.nextCursor,
  ]);

  return (
    <SearchPage
      search={draftSearch}
      committedSearch={data.search}
      category={data.category}
      language={data.language}
      sort={data.sort}
      dynamicFilters={dynamicFilters}
      data={visibleData}
      categories={[...data.categories]}
      loading={navigation.state !== "idle"}
      loadingMore={loadMoreState.loading}
      loadMoreError={loadMoreState.error}
      restoreSearchFocus={restoreSearchFocusRef.current}
      onSearchChange={handleSearchChange}
      onCategoryChange={(value) => handleImmediateSearchParamChange({ category: value })}
      onLanguageChange={(value) => handleImmediateSearchParamChange({ language: value })}
      onSortChange={(value) => handleImmediateSearchParamChange({ sort: value })}
      onDynamicFilterChange={(value) => handleImmediateSearchParamChange({ dynamicFilter: value })}
      onDynamicFilterClear={(value) => handleImmediateSearchParamChange({ dynamicFilterClear: value })}
      onLoadMore={handleLoadMore}
    />
  );
}

function mergeDiscoverySearchResponses(
  firstPage: DiscoverySearchResponse | null,
  extraPages: readonly DiscoverySearchResponse[],
): DiscoverySearchResponse | null {
  if (!firstPage) {
    return null;
  }

  const items: DiscoverySearchResponse["items"] = [];
  const seen = new Set<string>();
  for (const page of [firstPage, ...extraPages]) {
    for (const item of page.items) {
      if (!seen.has(item.catalog_item_id)) {
        seen.add(item.catalog_item_id);
        items.push(item);
      }
    }
  }

  return {
    ...firstPage,
    items,
    count: items.length,
    nextCursor: extraPages.at(-1)?.nextCursor ?? firstPage.nextCursor,
  };
}

function reloadForRealtimeSync() {
  if (typeof window !== "undefined") {
    window.location.reload();
  }
}

function readDynamicSearchFilters(searchParams: URLSearchParams): DynamicSearchFilterSelection[] {
  return [...searchParams.entries()]
    .flatMap(([key, value]): DynamicSearchFilterSelection[] => {
      if (key.startsWith("field.") && value) {
        return [{ kind: "field", id: key.slice("field.".length), value }];
      }
      if (key.startsWith("dimension.") && value) {
        return [{ kind: "dimension", id: key.slice("dimension.".length), value }];
      }
      return [];
    })
    .filter((filter) => filter.id.length > 0 && filter.value.length > 0);
}

function appendDynamicSearchFilters(
  searchParams: URLSearchParams,
  filters: readonly DynamicSearchFilterSelection[],
) {
  for (const filter of filters) {
    searchParams.append(dynamicSearchFilterKey(filter), filter.value);
  }
}

function toggleDynamicSearchFilter(
  searchParams: URLSearchParams,
  filter: DynamicSearchFilterSelection,
) {
  const key = dynamicSearchFilterKey(filter);
  const nextValues = searchParams
    .getAll(key)
    .filter((value) => value !== filter.value);

  if (nextValues.length === searchParams.getAll(key).length) {
    nextValues.push(filter.value);
  }

  searchParams.delete(key);
  for (const value of nextValues) {
    searchParams.append(key, value);
  }
}

function dynamicSearchFilterKey(filter: DynamicSearchFilterSelection): string {
  return `${filter.kind}.${filter.id}`;
}
