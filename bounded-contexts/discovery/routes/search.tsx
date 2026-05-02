import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import {
  redirect,
  useLoaderData,
  useNavigation,
  useSearchParams,
} from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { createDiscoveryRequestApiClient } from "../support/request-support/api-client";
import { SearchPage } from "../features/search/ui/search-page";

const PAGE_SIZE = 24;
const MARKETPLACE_DESCRIPTION =
  "Browse the Chase Sets marketplace with server-rendered discovery results and item detail pages.";
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
  const search = url.searchParams.get("search") ?? "";
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
      ? `Search "${data.search}" | Marketplace`
      : "Marketplace Search",
    description: MARKETPLACE_DESCRIPTION,
  }),
  ...(data?.canonicalUrl
    ? [{ tagName: "link", rel: "canonical", href: data.canonicalUrl }]
    : []),
];

export default function DiscoverySearchRoute() {
  const data = useLoaderData<typeof loader>() ?? EMPTY_SEARCH_RESULT;
  const navigation = useNavigation();
  const [searchParams, setSearchParams] = useSearchParams();

  function updateSearchParams(nextValues: {
    search?: string;
    category?: string;
    sort?: string;
    page?: number;
  }) {
    if (nextValues.category !== undefined) {
      if (typeof window !== "undefined") {
        window.location.assign(buildCategoryPath(nextValues.category, searchParams));
      }
      return;
    }

    setSearchParams((current) => {
      const next = new URLSearchParams(current);

      if (nextValues.search !== undefined) {
        if (nextValues.search) {
          next.set("search", nextValues.search);
        } else {
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
    }, { preventScrollReset: true });
  }

  return (
    <SearchPage
      search={data.search}
      category={data.category}
      sort={data.sort}
      page={data.page}
      data={data.data}
      categories={data.categories}
      loading={navigation.state !== "idle"}
      onSearchChange={(value) => updateSearchParams({ search: value })}
      onCategoryChange={(value) => updateSearchParams({ category: value })}
      onSortChange={(value) => updateSearchParams({ sort: value })}
      onPageChange={(value) => updateSearchParams({ page: value })}
    />
  );
}
