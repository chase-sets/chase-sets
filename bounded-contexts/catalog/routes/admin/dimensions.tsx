import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import {
  type Dimension,
} from "../../client";
import type { ListResponse } from "@chase-sets/http/responses";
import { DimensionListPage } from "../../features/dimensions/ui/dimension-list-page";
import { createCatalogRequestApiClient } from "../../support/request-support/api-client";

const DEFAULT_LIST_QUERY = "limit=50&offset=0";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createCatalogRequestApiClient(request);
  return api.listDimensions<ListResponse<Dimension>>(DEFAULT_LIST_QUERY);
}

export const meta: MetaFunction = () => [{ title: t("catalog.routes.admin.dimensions.dimensions.catalog.admin") }];

export default function DimensionsRoute() {
  const data = useLoaderData<typeof loader>();
  return <DimensionListPage initialData={data} />;
}


