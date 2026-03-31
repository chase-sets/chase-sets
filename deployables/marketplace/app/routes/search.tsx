import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import {
  useLoaderData,
  useNavigation,
  useSearchParams,
} from "react-router";
import { SearchPage } from "@chase-sets/discovery/web";
import { createMarketplaceServerApiClient } from "../api.server";
import { buildMarketplaceMeta } from "../seo";

const PAGE_SIZE = 24;

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

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const search = url.searchParams.get("search") ?? "";
  const category = url.searchParams.get("category") ?? "";
  const sort = url.searchParams.get("sort") ?? "relevance";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1"));
  const api = createMarketplaceServerApiClient(request);

  const [data, categories] = await Promise.all([
    api.searchItems(buildSearchQuery({ search, category, sort, page })),
    api.listCategories(),
  ]);

  return {
    search,
    category,
    sort,
    page,
    data,
    categories: categories.items,
  };
}

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  const title = data?.search
    ? `Search "${data.search}" | Marketplace`
    : "Marketplace Search";

  return buildMarketplaceMeta({ title });
};

export default function MarketplaceSearchRoute() {
  const data = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const [searchParams, setSearchParams] = useSearchParams();

  function updateSearchParams(nextValues: {
    search?: string;
    category?: string;
    sort?: string;
    page?: number;
  }) {
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

      if (nextValues.category !== undefined) {
        if (nextValues.category) {
          next.set("category", nextValues.category);
        } else {
          next.delete("category");
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
