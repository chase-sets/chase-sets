import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import {
  type Dimension,
} from "../../client";
import type { ListResponse } from "@chase-sets/http/responses";
import { DimensionListPage } from "../../authoring/dimensions/ui/dimension-list-page";
import { createCatalogRequestApiClient } from "../../server";

const DEFAULT_LIST_QUERY = "limit=50&offset=0";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createCatalogRequestApiClient(request);
  return api.listDimensions<ListResponse<Dimension>>(DEFAULT_LIST_QUERY);
}

export const meta: MetaFunction = () => [{ title: "Dimensions | Catalog Admin" }];

export default function DimensionsRoute() {
  const data = useLoaderData<typeof loader>();
  return <DimensionListPage initialData={data} />;
}


