import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import {
  type CategoryListItem,
} from "../../client";
import type { ListResponse } from "@chase-sets/http/responses";
import { CategoryListPage } from "../../authoring/categories/ui/category-list-page";
import { createCatalogRequestApiClient } from "../../request-support/api-client";

const DEFAULT_LIST_QUERY = "limit=50&offset=0";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createCatalogRequestApiClient(request);
  return api.listCategories<ListResponse<CategoryListItem>>(DEFAULT_LIST_QUERY);
}

export const meta: MetaFunction = () => [{ title: "Categories | Catalog Admin" }];

export default function CategoriesRoute() {
  const data = useLoaderData<typeof loader>();
  return <CategoryListPage initialData={data} />;
}


