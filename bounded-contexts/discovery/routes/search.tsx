import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import {
  redirect,
  useLoaderData,
  useNavigate,
  useNavigation,
  useSearchParams,
} from "react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { useRealtimePatchedSnapshot } from "@chase-sets/platform-runtime/realtime-react";
import { createDiscoveryRequestApiClient } from "../support/request-support/api-client";
import type { DiscoverySearchResponse } from "../support/request-support/api-client";
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
  sort: "relevance",
  page: 1,
  data: null,
  categories: [],
} as const;

function buildSearchQuery({
  search,
  category,
  sort,
  page,
}: {
  search: string;
  category: string;
  sort: string;
  page: number;
}) {
  const params = new URLSearchParams();
  if (search) {
    params.set("search", search);
  }
  if (category) {
    params.set("category", category);
  }
  params.set("sort", sort);
  params.set("limit", String(PAGE_SIZE));
  params.set("offset", String((page - 1) * PAGE_SIZE));
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
  const search = url.searchParams.get("q") ?? url.searchParams.get("search") ?? "";
  const categoryParam = params.categorySlug ?? url.searchParams.get("category") ?? "";
  const sort = url.searchParams.get("sort") ?? "relevance";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1"));
  const api = createDiscoveryRequestApiClient(request);

  const [categoryBySlug, categories] = await Promise.all([
    categoryParam ? api.getCategoryBySlug(categoryParam).catch(() => null) : Promise.resolve(null),
    api.listCategories(),
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

  const data = await api.searchItems(buildSearchQuery({ search, category, sort, page }));
  const canonicalPath = params.categorySlug && resolvedCategory
    ? buildCategoryPath(resolvedCategory.slug, url.searchParams)
    : buildCategoryPath("", url.searchParams);

  return {
    search,
    category,
    sort,
    page,
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
  const realtimeData = useRealtimePatchedSnapshot<DiscoverySearchResponse | null>({
    initialSnapshot: data.data,
    snapshotKey: JSON.stringify([data.search, data.category, data.sort, data.page, data.data]),
    topics: discoveryRealtimeRouteTopics.search().topics,
    applyPatch: applyDiscoverySearchPatch,
    onSyncRequired: reloadForRealtimeSync,
  });
  let draftSearch = draftSearchState.value;

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
    sort?: string;
    page?: number;
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

      if (nextValues.page !== undefined) {
        if (nextValues.page > 1) {
          next.set("page", String(nextValues.page));
        } else {
          next.delete("page");
        }
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
    sort?: string;
    page?: number;
  }) {
    clearSearchTimer();
    const search = pendingSearchRef.current ?? draftSearchRef.current;
    pendingSearchRef.current = search;
    updateSearchParams({ search, ...nextValues });
  }

  return (
    <SearchPage
      search={draftSearch}
      committedSearch={data.search}
      category={data.category}
      sort={data.sort}
      page={data.page}
      data={realtimeData}
      categories={[...data.categories]}
      loading={navigation.state !== "idle"}
      restoreSearchFocus={restoreSearchFocusRef.current}
      onSearchChange={handleSearchChange}
      onCategoryChange={(value) => handleImmediateSearchParamChange({ category: value })}
      onSortChange={(value) => handleImmediateSearchParamChange({ sort: value })}
      onPageChange={(value) => handleImmediateSearchParamChange({ page: value })}
    />
  );
}

function reloadForRealtimeSync() {
  if (typeof window !== "undefined") {
    window.location.reload();
  }
}
