import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import {
  type CatalogItemListItem,
} from "../../client";
import type { ListResponse } from "@chase-sets/http/responses";
import { CatalogItemListPage } from "../../features/catalog-items/ui/catalog-item-list-page";
import { createCatalogRequestApiClient } from "../../support/request-support/api-client";

const DEFAULT_LIST_QUERY = "limit=50&offset=0";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createCatalogRequestApiClient(request);
  return api.listCatalogItems<ListResponse<CatalogItemListItem>>(DEFAULT_LIST_QUERY);
}

export const meta: MetaFunction = () => [{ title: t("catalog.routes.admin.catalogItems.catalog.items.catalog.admin") }];

export default function CatalogItemsRoute() {
  const data = useLoaderData<typeof loader>();
  return <CatalogItemListPage initialData={data} />;
}


