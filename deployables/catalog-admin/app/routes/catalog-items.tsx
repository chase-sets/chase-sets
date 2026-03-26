import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { CatalogItemListPage } from "../../../../bounded-contexts/catalog/authoring/catalog-items/ui/catalog-item-list-page";
import type { CatalogItemListItem } from "../../../../bounded-contexts/catalog/authoring/catalog-items/ui/contracts";
import type { ListResponse } from "@chase-sets/http/responses";
import { createCatalogServerApiClient } from "../api.server";

const DEFAULT_LIST_QUERY = "limit=50&offset=0";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createCatalogServerApiClient(request);
  return api.listCatalogItems<ListResponse<CatalogItemListItem>>(DEFAULT_LIST_QUERY);
}

export const meta: MetaFunction = () => [{ title: "Catalog Items | Catalog Admin" }];

export default function CatalogItemsRoute() {
  const data = useLoaderData<typeof loader>();
  return <CatalogItemListPage initialData={data} />;
}
