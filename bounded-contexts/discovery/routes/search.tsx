import { t } from "@chase-sets/localization";
import type { ClientLoaderFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import {
  type ActionFunctionArgs,
  redirect,
  useLoaderData,
  useLocation,
  useNavigate,
  useNavigation,
  useSearchParams,
} from "react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { formatDisplayIdentity } from "@chase-sets/localization";
import type { SavedListProductSelection } from "@chase-sets/collections/server";
import { useRealtimePatchedSnapshot } from "@chase-sets/platform-runtime/realtime-react";
import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { defineFormAction, type FormActionContext } from "@chase-sets/platform-runtime/http";
import { createDiscoveryRequestApiClient } from "../support/request-support/api-client";
import type { DiscoveryBulkCartPreview, DiscoverySearchResponse } from "../support/request-support/api-client";
import {
  appendAnonymousCartCookie,
  createCheckoutRequestApiClient,
  ensureAnonymousCartId,
} from "@chase-sets/checkout/server";
import { applyDiscoverySearchPatch } from "../support/client-support/realtime-market";
import { SearchPage } from "../features/search/ui/search-page";
import { EMPTY_CATEGORY_LIST, EMPTY_DISCOVERY_SEARCH_RESPONSE } from "../features/search/ui/route-data-defaults";
import {
  buildSearchResultSetKey,
  persistSearchRestoration,
  restoreSearchRestoration,
} from "../features/search/ui/search-scroll-restoration";
import {
  cacheSearchLoaderData,
  readCachedSearchLoaderData,
  searchLoaderCacheKey,
} from "../features/search/ui/search-loader-cache";
import { discoveryRealtimeRouteTopics } from "../support/realtime-support/topics";
import { useDiscoveryRealtimeRevalidation } from "../support/realtime-support/revalidation";
import {
  createDiscoveryProductDescriptor,
  summarizeSelections,
} from "../features/saved-list-addition/api/product-selection";
import {
  commitSavedListAddition,
  loadSavedListClaimPreparation,
  prepareSavedListAddition,
  savedListActionError,
} from "../support/request-support/saved-list-addition";

const PAGE_SIZE = 24;
const HOME_FEATURED_CATEGORY_LIMIT = 4;
const HOME_NEW_ARRIVALS_LIMIT = 3;
export const SEARCH_DEBOUNCE_MS = 300;
export const PRICE_FILTER_DEBOUNCE_MS = 500;
const MARKETPLACE_DESCRIPTION = t("discovery.routes.search.browse.the.chase.sets.marketplace.with");
const EMPTY_SEARCH_RESULT = {
  search: "",
  category: "",
  tag: "",
  language: "",
  marketActivity: "",
  priceMin: "",
  priceMax: "",
  inStock: false,
  sort: "relevance",
  dynamicFilters: [],
  data: null,
  categories: [],
  homeMerchandising: null,
  savedListClaim: { preparation: null, error: null },
} as const;
const EMPTY_EXTRA_PAGES: readonly DiscoverySearchResponse[] = [];

type DynamicSearchFilterSelection = Readonly<{
  kind: "field" | "reference" | "dimension";
  id: string;
  value: string;
}>;
type MarketActivityFilter = "" | "any" | "listings" | "offers";

function buildSearchQuery({
  search,
  category,
  tag,
  language,
  marketActivity,
  priceMin,
  priceMax,
  inStock,
  sort,
  cursor,
  limit = PAGE_SIZE,
  dynamicFilters,
}: {
  search: string;
  category: string;
  tag: string;
  language: string;
  marketActivity: MarketActivityFilter;
  priceMin: string;
  priceMax: string;
  inStock: boolean;
  sort: string;
  cursor?: string | null;
  limit?: number;
  dynamicFilters: readonly DynamicSearchFilterSelection[];
}) {
  const params = new URLSearchParams();
  if (search) {
    params.set("search", search);
  }
  if (category) {
    params.set("category", category);
  }
  if (tag) {
    params.set("tag", tag);
  }
  if (language) {
    params.set("language", language);
  }
  if (marketActivity) {
    params.set("marketActivity", marketActivity);
  }
  if (priceMin) {
    params.set("priceMin", priceMin);
  }
  if (priceMax) {
    params.set("priceMax", priceMax);
  }
  if (inStock) {
    params.set("inStock", "true");
  }
  params.set("sort", sort);
  params.set("limit", String(limit));
  if (cursor) {
    params.set("cursor", cursor);
  } else {
    params.set("includeTotal", "true");
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
  const tag = url.searchParams.get("tag") ?? "";
  const language = url.searchParams.get("language") ?? "";
  const marketActivity = readMarketActivityFilter(url.searchParams);
  const priceMin = readPriceFilter(url.searchParams, "priceMin");
  const priceMax = readPriceFilter(url.searchParams, "priceMax");
  const inStock = url.searchParams.get("inStock") === "true";
  const sort = url.searchParams.get("sort") ?? "relevance";
  const dynamicFilters = readDynamicSearchFilters(url.searchParams);
  const isHomeLanding =
    url.pathname === "/" &&
    !search &&
    !categoryParam &&
    !tag &&
    !language &&
    !marketActivity &&
    !priceMin &&
    !priceMax &&
    !inStock &&
    sort === "relevance" &&
    dynamicFilters.length === 0;
  const api = createDiscoveryRequestApiClient(request);

  const [categoryBySlug, categories] = await Promise.all([
    categoryParam ? api.getCategoryBySlug(categoryParam).catch(() => null) : Promise.resolve(null),
    api.listCategories().catch(() => EMPTY_CATEGORY_LIST),
  ]);
  const resolvedCategory =
    categoryBySlug ??
    categories.items.find(
      (item) => item.name === categoryParam || item.key === categoryParam || item.category_id === categoryParam,
    ) ??
    null;
  const category = resolvedCategory?.slug ?? categoryParam;

  if (params.categorySlug && resolvedCategory && params.categorySlug !== resolvedCategory.slug) {
    throw redirect(buildCategoryPath(resolvedCategory.slug, url.searchParams), { status: 301 });
  }

  if (!params.categorySlug && url.searchParams.has("category") && resolvedCategory) {
    throw redirect(buildCategoryPath(resolvedCategory.slug, url.searchParams), { status: 301 });
  }

  const [data, newArrivals, savedListClaim] = await Promise.all([
    api
      .searchItems(
        buildSearchQuery({
          search,
          category,
          tag,
          language,
          marketActivity,
          priceMin,
          priceMax,
          inStock,
          sort,
          dynamicFilters,
        }),
      )
      .catch(() => EMPTY_DISCOVERY_SEARCH_RESPONSE),
    isHomeLanding
      ? api
          .searchItems(
            buildSearchQuery({
              search: "",
              category: "",
              tag: "",
              language: "",
              marketActivity: "",
              priceMin: "",
              priceMax: "",
              inStock: false,
              sort: "newest",
              limit: HOME_NEW_ARRIVALS_LIMIT,
              dynamicFilters: [],
            }),
          )
          .catch(() => EMPTY_DISCOVERY_SEARCH_RESPONSE)
      : Promise.resolve(EMPTY_DISCOVERY_SEARCH_RESPONSE),
    loadSavedListClaimPreparation(request, (product) => product.productId),
  ]);
  const canonicalPath =
    params.categorySlug && resolvedCategory
      ? buildCategoryPath(resolvedCategory.slug, url.searchParams)
      : buildCategoryPath("", url.searchParams);

  return {
    search,
    category,
    tag,
    language,
    marketActivity,
    priceMin,
    priceMax,
    inStock,
    sort,
    dynamicFilters,
    data,
    categories: categories.items,
    homeMerchandising: isHomeLanding
      ? {
          featuredCategories: [...categories.items]
            .sort((left, right) => left.display_order - right.display_order)
            .slice(0, HOME_FEATURED_CATEGORY_LIMIT),
          newArrivals: newArrivals.items,
        }
      : null,
    canonicalUrl: new URL(canonicalPath, url.origin).toString(),
    savedListClaim,
  };
}

/**
 * Restore the Result Set instantly on back/forward navigation.
 *
 * React Router forces a loader run whenever it re-enters a route it had unmounted
 * (`isNewLoader` sees the missing loader data), so a shopper returning from item detail
 * would otherwise block on a full server round-trip before the cached results and scroll
 * context could paint. Under merge-queue backend load that round-trip was the ~7.4s
 * restoration stall. When a still-fresh payload for this exact Result Set URL is cached
 * we serve it without a refetch; otherwise we defer to the authoritative server loader.
 */
export async function clientLoader({ request, serverLoader }: ClientLoaderFunctionArgs) {
  const loadFromServer = () => serverLoader<typeof loader>();
  const cached = readCachedSearchLoaderData<Awaited<ReturnType<typeof loadFromServer>>>(
    getSearchSessionStorage(),
    searchLoaderCacheKey(request.url),
  );
  return cached ?? loadFromServer();
}

type BulkAddActionData =
  | Readonly<{ status: "bulk-preview"; preview: DiscoveryBulkCartPreview }>
  | Readonly<{
      status: "bulk-added";
      preview: DiscoveryBulkCartPreview;
      addedLineCount: number;
      mergedLineCount: number;
      failedLineCount: number;
      requestedLineCount: number;
    }>;

async function handleAction(intent: string, { request, params, formData }: FormActionContext) {
  if (intent === "commit-saved-list") {
    return commitSavedListAddition(request, formData);
  }
  if (intent === "prepare-saved-list") {
    try {
      const discoveryApi = createDiscoveryRequestApiClient(request);
      const slug = String(formData.get("slug") ?? "");
      const item = await discoveryApi.getItemDetail(slug);
      const url = new URL(request.url);
      const selections = Object.fromEntries(
        readDynamicSearchFilters(url.searchParams)
          .filter((filter) => filter.kind === "dimension")
          .map((filter) => [filter.id, filter.value]),
      );
      let descriptor;
      try {
        descriptor = createDiscoveryProductDescriptor({
          catalogItemId: item.catalog_item_id,
          productSchema: item.product_schema,
          selection: Object.entries(selections).map(([dimensionId, optionId]) => ({ dimensionId, optionId })),
        });
      } catch {
        const href = buildSearchItemDetailHref(slug, new URL(request.url).searchParams);
        return Response.json({ status: "options-required", href } satisfies BulkOrSavedListActionData);
      }
      const summary = item.product_schema
        ? summarizeSelections(item.product_schema, selections)
            .map((selection) => `${selection.dimensionName}: ${selection.optionLabel}`)
            .join(", ")
        : "";
      return prepareSavedListAddition({
        request,
        product: {
          catalogItemId: item.catalog_item_id as SavedListProductSelection["catalogItemId"],
          productId: descriptor.productId as SavedListProductSelection["productId"],
          selectedOptions: descriptor.selection,
        },
        productLabel: [formatDisplayIdentity(item.title, item.subtitle), summary].filter(Boolean).join(" · "),
        sourceSurface: "search",
      });
    } catch (error) {
      return savedListActionError(error);
    }
  }
  if (intent !== "preview-bulk-add" && intent !== "commit-bulk-add") {
    return Response.json({ error: t("discovery.routes.search.unsupported.search.action") }, { status: 400 });
  }

  const discoveryApi = createDiscoveryRequestApiClient(request);
  const checkoutApi = createCheckoutRequestApiClient(request);
  const url = new URL(request.url);
  const search = url.searchParams.get("q") ?? url.searchParams.get("search") ?? "";
  const category = params.categorySlug ?? url.searchParams.get("category") ?? "";
  const tag = url.searchParams.get("tag") ?? "";
  const language = url.searchParams.get("language") ?? "";
  const marketActivity = readMarketActivityFilter(url.searchParams);
  const priceMin = readPriceFilter(url.searchParams, "priceMin");
  const priceMax = readPriceFilter(url.searchParams, "priceMax");
  const inStock = url.searchParams.get("inStock") === "true";
  const sort = url.searchParams.get("sort") ?? "relevance";
  const dynamicFilters = readDynamicSearchFilters(url.searchParams);
  const preview = await discoveryApi.previewBulkAddSearchResults(
    buildSearchQuery({
      search,
      category,
      tag,
      language,
      marketActivity,
      priceMin,
      priceMax,
      inStock,
      sort,
      dynamicFilters,
    }),
  );

  if (intent === "preview-bulk-add" || preview.overLimit || preview.lines.length === 0) {
    return Response.json({ status: "bulk-preview", preview } satisfies BulkAddActionData);
  }

  const actor = await resolveActorFromAuthApi({ request });
  const lines = preview.lines.map((line) => ({
    catalogItemId: line.catalog_item_id,
    productId: line.product_id,
    itemTitle: line.title,
    itemSubtitle: line.subtitle,
    itemImageUrl: line.image_url,
    itemImageSrcSet: line.image_srcset,
    itemImageLoadingUrl: line.image_loading_url,
    itemImageLoadingAlt: line.image_loading_alt,
    itemImageLoadingSrcSet: line.image_loading_srcset,
    selectedOptions: line.selected_options,
    productSummary: line.product_summary,
    quantity: line.quantity,
    fulfillmentMode: "optimize" as const,
    lockedListingId: null,
  }));

  if (!actor) {
    const anonymousCartId = ensureAnonymousCartId(request);
    const result = await checkoutApi.addGuestCartLines(anonymousCartId, { lines });
    const response = Response.json({
      status: "bulk-added",
      preview,
      addedLineCount: result.addedLineCount,
      mergedLineCount: result.mergedLineCount,
      failedLineCount: result.failedLineCount,
      requestedLineCount: result.requestedLineCount,
    } satisfies BulkAddActionData);
    appendAnonymousCartCookie(response.headers, anonymousCartId, request);
    return response;
  }

  const result = await checkoutApi.addCartLines({ lines });
  return Response.json({
    status: "bulk-added",
    preview,
    addedLineCount: result.addedLineCount,
    mergedLineCount: result.mergedLineCount,
    failedLineCount: result.failedLineCount,
    requestedLineCount: result.requestedLineCount,
  } satisfies BulkAddActionData);
}

export const action = defineFormAction({
  intents: {
    "commit-saved-list": (context) => handleAction("commit-saved-list", context),
    "prepare-saved-list": (context) => handleAction("prepare-saved-list", context),
    "preview-bulk-add": (context) => handleAction("preview-bulk-add", context),
    "commit-bulk-add": (context) => handleAction("commit-bulk-add", context),
  },
  onUnknownIntent: (context) => handleAction("", context),
});

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  ...buildOpenGraphMeta({
    title: data?.search
      ? t("discovery.routes.search.search.meta.title", { search: data.search })
      : t("discovery.routes.search.marketplace.search"),
    description: MARKETPLACE_DESCRIPTION,
  }),
  ...(data?.canonicalUrl ? [{ tagName: "link", rel: "canonical", href: data.canonicalUrl }] : []),
];

export default function DiscoverySearchRoute() {
  const data = useLoaderData<typeof loader>() ?? EMPTY_SEARCH_RESULT;

  return <DiscoverySearchRealtimeView data={data} />;
}

type DiscoverySearchRouteData = typeof EMPTY_SEARCH_RESULT | Awaited<ReturnType<typeof loader>>;

function DiscoverySearchRealtimeView({ data }: { data: DiscoverySearchRouteData }) {
  const revalidateForRealtimeSync = useDiscoveryRealtimeRevalidation();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const draftSearchRef = useRef(data.search);
  const pendingSearchRef = useRef<string | null>(null);
  const draftPriceRef = useRef({ min: data.priceMin, max: data.priceMax });
  const pendingPriceRef = useRef<{ min: string; max: string } | null>(null);
  const restoreSearchFocusRef = useRef(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const priceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Kept fresh every render so the debounce timer below can observe the router's
  // *current* state when it fires, not the state captured when the timer was armed.
  const navigationRef = useRef(navigation);
  navigationRef.current = navigation;
  const pathnameRef = useRef(location.pathname);
  pathnameRef.current = location.pathname;
  const [draftSearchState, setDraftSearchState] = useState(() => ({
    committedSearch: data.search,
    value: data.search,
  }));
  const [draftPriceState, setDraftPriceState] = useState(() => ({
    committedMin: data.priceMin,
    committedMax: data.priceMax,
    min: data.priceMin,
    max: data.priceMax,
  }));
  const dynamicFilters = data.dynamicFilters ?? [];
  const resultSetKey = buildSearchResultSetKey({
    search: data.search,
    category: data.category,
    tag: data.tag,
    language: data.language,
    marketActivity: data.marketActivity,
    priceMin: data.priceMin,
    priceMax: data.priceMax,
    inStock: data.inStock,
    sort: data.sort,
    dynamicFilters,
  });
  const resultSetKeyRef = useRef(resultSetKey);
  const pendingScrollRestorationRef = useRef<{
    key: string;
    pageCount: number;
    scrollY: number;
  } | null>(null);
  const lastObservedScrollYRef = useRef(0);
  const [extraPageState, setExtraPageState] = useState<{
    key: string;
    pages: DiscoverySearchResponse[];
  }>({ key: resultSetKey, pages: [] });
  const extraPageStateRef = useRef(extraPageState);
  extraPageStateRef.current = extraPageState;
  const [loadMoreState, setLoadMoreState] = useState<{
    loading: boolean;
    error: string | null;
  }>({ loading: false, error: null });
  const [bulkAddState, setBulkAddState] = useState<{
    status: "idle" | "submitting";
    data?: BulkAddActionData;
    error?: string | null;
  }>({ status: "idle" });
  const loadMoreInFlightRef = useRef(false);
  const bulkAddRequestIdRef = useRef(0);
  let draftSearch = draftSearchState.value;
  let draftPriceMin = draftPriceState.min;
  let draftPriceMax = draftPriceState.max;
  const activeExtraPages = extraPageState.key === resultSetKey ? extraPageState.pages : EMPTY_EXTRA_PAGES;
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
    onSyncRequired: revalidateForRealtimeSync,
  });

  useEffect(() => {
    resultSetKeyRef.current = resultSetKey;
    loadMoreInFlightRef.current = false;
    const restoration = restoreSearchRestoration(getSearchSessionStorage(), resultSetKey);
    pendingScrollRestorationRef.current =
      restoration.scrollY === null
        ? null
        : { key: resultSetKey, pageCount: restoration.pages.length, scrollY: restoration.scrollY };
    setExtraPageState({ key: resultSetKey, pages: restoration.pages });
    setLoadMoreState({ loading: false, error: null });
    setBulkAddState({ status: "idle" });
  }, [resultSetKey]);

  useEffect(() => {
    const pending = pendingScrollRestorationRef.current;
    if (
      !pending ||
      pending.key !== resultSetKey ||
      extraPageState.key !== pending.key ||
      extraPageState.pages.length !== pending.pageCount
    ) {
      return;
    }

    pendingScrollRestorationRef.current = null;
    lastObservedScrollYRef.current = pending.scrollY;
    window.scrollTo({ top: pending.scrollY, left: 0, behavior: "instant" });
  }, [extraPageState, resultSetKey]);

  useEffect(() => {
    lastObservedScrollYRef.current = window.scrollY;
    const observeScrollPosition = () => {
      lastObservedScrollYRef.current = window.scrollY;
    };
    const persistCurrentRestoration = () => {
      const current = extraPageStateRef.current;
      const currentKey = resultSetKeyRef.current;
      if (current.key !== currentKey) {
        return;
      }
      persistSearchRestoration(getSearchSessionStorage(), currentKey, current.pages, lastObservedScrollYRef.current);
    };
    const persistPageHideRestoration = () => {
      observeScrollPosition();
      persistCurrentRestoration();
    };

    window.addEventListener("scroll", observeScrollPosition, { passive: true });
    window.addEventListener("pagehide", persistPageHideRestoration);
    return () => {
      window.removeEventListener("scroll", observeScrollPosition);
      window.removeEventListener("pagehide", persistPageHideRestoration);
      persistCurrentRestoration();
    };
  }, []);

  // Cache the authoritative loader payload for this Result Set URL so a later back/forward
  // navigation can restore it via `clientLoader` without a blocking server round-trip. Both
  // server-rendered and client-navigated visits pass through here, so the cache is warm
  // before the shopper ever leaves for item detail. The empty fallback carries no
  // `canonicalUrl`, so guarding on it keeps a stale-state placeholder out of the cache.
  useEffect(() => {
    if (!("canonicalUrl" in data)) {
      return;
    }
    cacheSearchLoaderData(
      getSearchSessionStorage(),
      searchLoaderCacheKey(`${location.pathname}${location.search}`),
      data,
    );
  }, [data, location.pathname, location.search]);

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

  if (
    (draftPriceState.committedMin !== data.priceMin || draftPriceState.committedMax !== data.priceMax) &&
    pendingPriceRef.current === null
  ) {
    draftPriceRef.current = { min: data.priceMin, max: data.priceMax };
    draftPriceMin = data.priceMin;
    draftPriceMax = data.priceMax;
    setDraftPriceState({
      committedMin: data.priceMin,
      committedMax: data.priceMax,
      min: data.priceMin,
      max: data.priceMax,
    });
  }

  const clearSearchTimer = useCallback(() => {
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current);
      searchTimerRef.current = null;
    }
  }, []);

  const clearPriceTimer = useCallback(() => {
    if (priceTimerRef.current) {
      clearTimeout(priceTimerRef.current);
      priceTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearSearchTimer, [clearSearchTimer]);
  useEffect(() => clearPriceTimer, [clearPriceTimer]);

  const updateSearchParams = useCallback(
    (
      nextValues: {
        search?: string;
        category?: string;
        tag?: string | null;
        language?: string;
        marketActivity?: MarketActivityFilter;
        priceMin?: string;
        priceMax?: string;
        inStock?: boolean;
        sort?: string;
        dynamicFilter?: DynamicSearchFilterSelection;
        dynamicFilterClear?: Omit<DynamicSearchFilterSelection, "value">;
      },
      replace = false,
    ) => {
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

      setSearchParams(
        (current) => {
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

          if (nextValues.tag !== undefined) {
            if (nextValues.tag) {
              next.set("tag", nextValues.tag);
            } else {
              next.delete("tag");
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

          if (nextValues.marketActivity !== undefined) {
            if (nextValues.marketActivity) {
              next.set("marketActivity", nextValues.marketActivity);
            } else {
              next.delete("marketActivity");
            }
            next.delete("page");
          }

          if (nextValues.priceMin !== undefined) {
            if (nextValues.priceMin) {
              next.set("priceMin", nextValues.priceMin);
            } else {
              next.delete("priceMin");
            }
            next.delete("page");
          }

          if (nextValues.priceMax !== undefined) {
            if (nextValues.priceMax) {
              next.set("priceMax", nextValues.priceMax);
            } else {
              next.delete("priceMax");
            }
            next.delete("page");
          }

          if (nextValues.inStock !== undefined) {
            if (nextValues.inStock) {
              next.set("inStock", "true");
            } else {
              next.delete("inStock");
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
        },
        { preventScrollReset: true, replace },
      );
    },
    [navigate, searchParams, setSearchParams],
  );

  const commitPendingSearch = useCallback(() => {
    // A result card (or another in-page link) may have started a client-side
    // navigation away from this search page while the debounce was pending.
    // Committing the stale search now would interrupt that in-flight navigation
    // (React Router cancels a pending navigation when a new one starts) and yank
    // the user back to the search results, so drop the pending search instead.
    // Same-pathname navigations (an earlier filter commit still loading) are
    // still superseded as before.
    const currentNavigation = navigationRef.current;
    const navigatingAwayFromSearch =
      currentNavigation.state !== "idle" &&
      currentNavigation.location !== undefined &&
      currentNavigation.location.pathname !== pathnameRef.current;
    if (navigatingAwayFromSearch) {
      pendingSearchRef.current = null;
      return;
    }
    updateSearchParams({ search: pendingSearchRef.current ?? "" }, true);
  }, [updateSearchParams]);

  const commitPendingPrice = useCallback(() => {
    const pendingPrice = pendingPriceRef.current;
    if (pendingPrice === null) {
      return;
    }

    const currentNavigation = navigationRef.current;
    const navigatingAwayFromSearch =
      currentNavigation.state !== "idle" &&
      currentNavigation.location !== undefined &&
      currentNavigation.location.pathname !== pathnameRef.current;
    if (navigatingAwayFromSearch) {
      pendingPriceRef.current = null;
      return;
    }

    pendingPriceRef.current = null;
    updateSearchParams({ priceMin: pendingPrice.min, priceMax: pendingPrice.max }, true);
  }, [updateSearchParams]);

  // Flush the pending debounce the moment focus leaves the search input.
  // `focusout` fires synchronously when a pointerdown lands elsewhere — BEFORE
  // the subsequent `click` runs a result card's client-side navigation — so the
  // search commit always starts ahead of the user's navigation and the
  // navigation (issued last) wins. Without this, a debounce firing mid-
  // navigation cancels the in-flight detail navigation. The only focused
  // element while a search debounce is pending is the search input itself, so
  // any focusout with a live timer means the shopper left it.
  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    const flushOnFocusOut = () => {
      if (searchTimerRef.current === null) {
        return;
      }
      clearSearchTimer();
      commitPendingSearch();
    };
    document.addEventListener("focusout", flushOnFocusOut, true);
    return () => document.removeEventListener("focusout", flushOnFocusOut, true);
  }, [clearSearchTimer, commitPendingSearch]);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    const flushOnFocusOut = () => {
      if (priceTimerRef.current === null) {
        return;
      }
      clearPriceTimer();
      commitPendingPrice();
    };
    document.addEventListener("focusout", flushOnFocusOut, true);
    return () => document.removeEventListener("focusout", flushOnFocusOut, true);
  }, [clearPriceTimer, commitPendingPrice]);

  function handleSearchChange(value: string) {
    restoreSearchFocusRef.current = true;
    draftSearchRef.current = value;
    pendingSearchRef.current = value;
    setDraftSearchState((current) => ({ ...current, value }));
    clearSearchTimer();
    searchTimerRef.current = setTimeout(() => {
      searchTimerRef.current = null;
      commitPendingSearch();
    }, SEARCH_DEBOUNCE_MS);
  }

  function handleSearchSubmit() {
    if (pendingSearchRef.current === null) {
      return;
    }

    clearSearchTimer();
    commitPendingSearch();
  }

  function handleClearSearch() {
    restoreSearchFocusRef.current = true;
    draftSearchRef.current = "";
    pendingSearchRef.current = "";
    setDraftSearchState((current) => ({ ...current, value: "" }));
    clearSearchTimer();
    updateSearchParams({ search: "" }, true);
  }

  function handlePriceChange(price: "min" | "max", value: string) {
    const nextPrice = { ...draftPriceRef.current, [price]: value };
    draftPriceRef.current = nextPrice;
    pendingPriceRef.current = nextPrice;
    setDraftPriceState((current) => ({ ...current, [price]: value }));
    clearPriceTimer();
    priceTimerRef.current = setTimeout(() => {
      priceTimerRef.current = null;
      commitPendingPrice();
    }, PRICE_FILTER_DEBOUNCE_MS);
  }

  function handleImmediatePriceChange(price: "min" | "max", value: string) {
    const nextPrice = { ...draftPriceRef.current, [price]: value };
    draftPriceRef.current = nextPrice;
    pendingPriceRef.current = null;
    setDraftPriceState((current) => ({ ...current, [price]: value }));
    clearPriceTimer();
    updateSearchParams({ priceMin: nextPrice.min, priceMax: nextPrice.max });
  }

  function handleImmediateSearchParamChange(nextValues: {
    category?: string;
    tag?: string | null;
    language?: string;
    marketActivity?: MarketActivityFilter;
    priceMin?: string;
    priceMax?: string;
    inStock?: boolean;
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
      tag: data.tag,
      language: data.language,
      marketActivity: data.marketActivity,
      priceMin: data.priceMin,
      priceMax: data.priceMax,
      inStock: data.inStock,
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

      const nextPage = (await response.json()) as DiscoverySearchResponse;
      if (resultSetKeyRef.current !== requestKey) {
        return;
      }

      setExtraPageState((current) => {
        if (current.key !== requestKey) {
          return current;
        }
        const pages = [...current.pages, nextPage];
        persistSearchRestoration(getSearchSessionStorage(), requestKey, pages, window.scrollY);
        return { key: current.key, pages };
      });
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
    data.marketActivity,
    data.priceMin,
    data.priceMax,
    data.inStock,
    data.search,
    data.tag,
    data.sort,
    dynamicFilters,
    visibleData?.nextCursor,
  ]);

  const submitBulkAddIntent = useCallback(async (intent: "preview-bulk-add" | "commit-bulk-add") => {
    if (typeof window === "undefined") {
      return;
    }

    const requestId = bulkAddRequestIdRef.current + 1;
    const requestKey = resultSetKeyRef.current;
    bulkAddRequestIdRef.current = requestId;
    const formData = new FormData();
    formData.set("intent", intent);
    setBulkAddState((current) => ({ ...current, status: "submitting", error: null }));

    try {
      const response = await fetch(window.location.href, {
        method: "POST",
        body: formData,
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`Bulk cart request failed with ${response.status}.`);
      }

      const data = (await response.json()) as BulkAddActionData;
      if (bulkAddRequestIdRef.current === requestId && resultSetKeyRef.current === requestKey) {
        setBulkAddState({
          status: "idle",
          data,
        });
      }
    } catch (error) {
      console.error("Bulk add search results failed.", error);
      if (bulkAddRequestIdRef.current === requestId && resultSetKeyRef.current === requestKey) {
        setBulkAddState((current) => ({
          ...current,
          status: "idle",
          error: t("discovery.features.search.ui.searchPage.bulk.error.description"),
        }));
      }
    }
  }, []);

  return (
    <SearchPage
      search={draftSearch}
      committedSearch={data.search}
      category={data.category}
      tag={data.tag}
      language={data.language}
      marketActivity={data.marketActivity}
      priceMin={draftPriceMin}
      priceMax={draftPriceMax}
      inStock={data.inStock}
      sort={data.sort}
      dynamicFilters={dynamicFilters}
      data={visibleData}
      resultSetKey={data.data?.resultSetKey}
      categories={[...data.categories]}
      homeMerchandising={data.homeMerchandising}
      loading={navigation.state !== "idle"}
      loadingMore={loadMoreState.loading}
      loadMoreError={loadMoreState.error}
      bulkAdd={{
        status: bulkAddState.status,
        data: bulkAddState.data,
        error: bulkAddState.error,
        onPreview: () => void submitBulkAddIntent("preview-bulk-add"),
        onCommit: () => void submitBulkAddIntent("commit-bulk-add"),
      }}
      savedListClaim={data.savedListClaim}
      restoreSearchFocus={restoreSearchFocusRef.current}
      onSearchChange={handleSearchChange}
      onSearchSubmit={handleSearchSubmit}
      onClearSearch={handleClearSearch}
      onCategoryChange={(value) => handleImmediateSearchParamChange({ category: value })}
      onTagClear={() => handleImmediateSearchParamChange({ tag: null })}
      onLanguageChange={(value) => handleImmediateSearchParamChange({ language: value })}
      onMarketActivityChange={(value) => handleImmediateSearchParamChange({ marketActivity: value })}
      onPriceMinChange={(value) => handlePriceChange("min", value)}
      onPriceMaxChange={(value) => handlePriceChange("max", value)}
      onPriceMinStep={(value) => handleImmediatePriceChange("min", value)}
      onPriceMaxStep={(value) => handleImmediatePriceChange("max", value)}
      onInStockChange={(value) => handleImmediateSearchParamChange({ inStock: value })}
      onSortChange={(value) => handleImmediateSearchParamChange({ sort: value })}
      onDynamicFilterChange={(value) => handleImmediateSearchParamChange({ dynamicFilter: value })}
      onDynamicFilterClear={(value) => handleImmediateSearchParamChange({ dynamicFilterClear: value })}
      onLoadMore={handleLoadMore}
    />
  );
}

type BulkOrSavedListActionData = BulkAddActionData | Readonly<{ status: "options-required"; href: string }>;

function buildSearchItemDetailHref(slug: string, searchParams: URLSearchParams) {
  const next = new URLSearchParams();
  for (const [key, value] of searchParams) {
    if (key.startsWith("dimension.") && value) next.append(key, value);
  }
  next.set("collection", "add");
  return `/items/${slug}?${next.toString()}`;
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
    nextCursor: extraPages.length > 0 ? (extraPages.at(-1)?.nextCursor ?? null) : firstPage.nextCursor,
  };
}

function getSearchSessionStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function readDynamicSearchFilters(searchParams: URLSearchParams): DynamicSearchFilterSelection[] {
  return [...searchParams.entries()]
    .flatMap(([key, value]): DynamicSearchFilterSelection[] => {
      if (key.startsWith("field.") && value) {
        return [{ kind: "field", id: key.slice("field.".length), value }];
      }
      if (key.startsWith("reference.") && value) {
        return [{ kind: "reference", id: key.slice("reference.".length), value }];
      }
      if (key.startsWith("dimension.") && value) {
        return [{ kind: "dimension", id: key.slice("dimension.".length), value }];
      }
      return [];
    })
    .filter((filter) => filter.id.length > 0 && filter.value.length > 0);
}

function readMarketActivityFilter(searchParams: URLSearchParams): MarketActivityFilter {
  const value = searchParams.get("marketActivity");
  return value === "any" || value === "listings" || value === "offers" ? value : "";
}

function readPriceFilter(searchParams: URLSearchParams, name: "priceMin" | "priceMax"): string {
  const amount = searchParams.get(name)?.trim() ?? "";
  return /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(amount) ? amount : "";
}

function appendDynamicSearchFilters(searchParams: URLSearchParams, filters: readonly DynamicSearchFilterSelection[]) {
  for (const filter of filters) {
    searchParams.append(dynamicSearchFilterKey(filter), filter.value);
  }
}

function toggleDynamicSearchFilter(searchParams: URLSearchParams, filter: DynamicSearchFilterSelection) {
  const key = dynamicSearchFilterKey(filter);
  const nextValues = searchParams.getAll(key).filter((value) => value !== filter.value);

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
