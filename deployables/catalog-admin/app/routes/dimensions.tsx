import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import {
  DimensionListPage,
  type Dimension,
} from "@chase-sets/catalog-authoring/web";
import type { ListResponse } from "@chase-sets/http/responses";
import { createCatalogServerApiClient } from "../api.server";

const DEFAULT_LIST_QUERY = "limit=50&offset=0";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createCatalogServerApiClient(request);
  return api.listDimensions<ListResponse<Dimension>>(DEFAULT_LIST_QUERY);
}

export const meta: MetaFunction = () => [{ title: "Dimensions | Catalog Admin" }];

export default function DimensionsRoute() {
  const data = useLoaderData<typeof loader>();
  return <DimensionListPage initialData={data} />;
}
