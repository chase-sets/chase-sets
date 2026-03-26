import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { ComponentListPage } from "../../../../bounded-contexts/catalog/authoring/components/ui/component-list-page";
import type { Component } from "../../../../bounded-contexts/catalog/authoring/components/ui/contracts";
import type { ListResponse } from "@chase-sets/http/responses";
import { createCatalogServerApiClient } from "../api.server";

const DEFAULT_LIST_QUERY = "limit=50&offset=0";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createCatalogServerApiClient(request);
  return api.listComponents<ListResponse<Component>>(DEFAULT_LIST_QUERY);
}

export const meta: MetaFunction = () => [{ title: "Components | Catalog Admin" }];

export default function ComponentsRoute() {
  const data = useLoaderData<typeof loader>();
  return <ComponentListPage initialData={data} />;
}
