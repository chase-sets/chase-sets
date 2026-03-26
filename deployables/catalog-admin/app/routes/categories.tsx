import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { CategoryListPage } from "../../../../bounded-contexts/catalog/authoring/categories/ui/category-list-page";
import type { CategoryListItem } from "../../../../bounded-contexts/catalog/authoring/categories/ui/contracts";
import type { ListResponse } from "@chase-sets/http/responses";
import { createCatalogServerApiClient } from "../api.server";

const DEFAULT_LIST_QUERY = "limit=50&offset=0";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createCatalogServerApiClient(request);
  return api.listCategories<ListResponse<CategoryListItem>>(DEFAULT_LIST_QUERY);
}

export const meta: MetaFunction = () => [{ title: "Categories | Catalog Admin" }];

export default function CategoriesRoute() {
  const data = useLoaderData<typeof loader>();
  return <CategoryListPage initialData={data} />;
}
