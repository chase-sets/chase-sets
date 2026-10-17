import type { PortableRouteInput, PortableRouteOutcome } from "@chase-sets/bounded-context-module";
import type { PortableClientFetch } from "@chase-sets/platform-runtime/portable-client";
import { ApiError, createDiscoveryApiClient } from "../../../support/client-support/api-client";
import type { DiscoverySearchResponse } from "../../../support/client-support/contracts";
import type { DiscoveryCategoryItem } from "../../categories/api/contracts";
import { EMPTY_CATEGORY_LIST, EMPTY_DISCOVERY_SEARCH_RESPONSE } from "./route-data-defaults";

const PAGE_SIZE = 24;

type PortableSearchFilter = Readonly<{
  kind: "field" | "reference" | "dimension";
  id: string;
  value: string;
}>;

const PORTABLE_SEARCH_FILTER_KINDS: readonly PortableSearchFilter["kind"][] = ["field", "reference", "dimension"];

export type PortableSearchRouteData = Readonly<{
  search: string;
  category: string;
  tag: string;
  language: string;
  marketActivity: "" | "any" | "listings" | "offers";
  priceMin: string;
  priceMax: string;
  inStock: boolean;
  sort: string;
  dynamicFilters: readonly PortableSearchFilter[];
  data: DiscoverySearchResponse;
  categories: readonly DiscoveryCategoryItem[];
}>;

function readMarketActivity(searchParams: URLSearchParams): PortableSearchRouteData["marketActivity"] {
  const value = searchParams.get("marketActivity");
  return value === "any" || value === "listings" || value === "offers" ? value : "";
}

function readPrice(searchParams: URLSearchParams, name: "priceMin" | "priceMax") {
  const value = searchParams.get(name)?.trim() ?? "";
  return /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value) ? value : "";
}

function readDynamicFilters(searchParams: URLSearchParams): PortableSearchFilter[] {
  return [...searchParams.entries()].flatMap(([key, value]) => {
    for (const kind of PORTABLE_SEARCH_FILTER_KINDS) {
      const prefix = `${kind}.`;
      if (key.startsWith(prefix) && key.length > prefix.length && value) {
        return [{ kind, id: key.slice(prefix.length), value }];
      }
    }
    return [];
  });
}

function buildQuery(data: Omit<PortableSearchRouteData, "data" | "categories">) {
  const params = new URLSearchParams();
  if (data.search) params.set("search", data.search);
  if (data.category) params.set("category", data.category);
  if (data.tag) params.set("tag", data.tag);
  if (data.language) params.set("language", data.language);
  if (data.marketActivity) params.set("marketActivity", data.marketActivity);
  if (data.priceMin) params.set("priceMin", data.priceMin);
  if (data.priceMax) params.set("priceMax", data.priceMax);
  if (data.inStock) params.set("inStock", "true");
  params.set("sort", data.sort);
  params.set("limit", String(PAGE_SIZE));
  params.set("includeTotal", "true");
  for (const filter of data.dynamicFilters) {
    params.append(`${filter.kind}.${filter.id}`, filter.value);
  }
  return params.toString();
}

function categoryPath(slug: string, current: URLSearchParams) {
  const next = new URLSearchParams(current);
  next.delete("category");
  next.delete("page");
  const query = next.toString();
  return `${slug ? `/categories/${slug}` : "/search"}${query ? `?${query}` : ""}`;
}

export async function loadPortableSearchRoute(
  input: PortableRouteInput,
  context: Readonly<{ apiOrigin: string; fetch: PortableClientFetch }>,
): Promise<PortableRouteOutcome<PortableSearchRouteData>> {
  if (input.url.searchParams.has("page")) {
    const normalized = new URL(input.url);
    normalized.searchParams.delete("page");
    return { kind: "navigate", to: `${normalized.pathname}${normalized.search}`, replace: true };
  }

  const search = input.url.searchParams.get("q") ?? input.url.searchParams.get("search") ?? "";
  const categoryParam = input.params.categorySlug ?? input.url.searchParams.get("category") ?? "";
  const tag = input.url.searchParams.get("tag") ?? "";
  const language = input.url.searchParams.get("language") ?? "";
  const marketActivity = readMarketActivity(input.url.searchParams);
  const priceMin = readPrice(input.url.searchParams, "priceMin");
  const priceMax = readPrice(input.url.searchParams, "priceMax");
  const inStock = input.url.searchParams.get("inStock") === "true";
  const sort = input.url.searchParams.get("sort") ?? "relevance";
  const dynamicFilters = readDynamicFilters(input.url.searchParams);
  const api = createDiscoveryApiClient({
    baseUrl: new URL("/api/marketplace", context.apiOrigin).toString(),
    fetch: context.fetch,
  });

  try {
    const categories = await api.listCategories().catch(() => EMPTY_CATEGORY_LIST);
    const categoryBySlug = categories.items.find((item) => item.slug === categoryParam) ?? null;
    const resolvedCategory =
      categoryBySlug ??
      categories.items.find(
        (item) => item.name === categoryParam || item.key === categoryParam || item.category_id === categoryParam,
      ) ??
      null;
    const category = resolvedCategory?.slug ?? categoryParam;

    if (input.params.categorySlug && resolvedCategory && input.params.categorySlug !== resolvedCategory.slug) {
      return { kind: "navigate", to: categoryPath(resolvedCategory.slug, input.url.searchParams), replace: true };
    }
    if (!input.params.categorySlug && input.url.searchParams.has("category") && resolvedCategory) {
      return { kind: "navigate", to: categoryPath(resolvedCategory.slug, input.url.searchParams), replace: true };
    }

    const routeData = {
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
    };
    const data = await api.searchItems(buildQuery(routeData)).catch(() => EMPTY_DISCOVERY_SEARCH_RESPONSE);
    return { kind: "data", data: { ...routeData, data, categories: categories.items } };
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 401) return { kind: "unauthorized" };
      if (error.status === 404) return { kind: "not-found" };
      return { kind: "transient-error" };
    }
    if (error instanceof TypeError) {
      return { kind: "transient-error" };
    }
    throw error;
  }
}
