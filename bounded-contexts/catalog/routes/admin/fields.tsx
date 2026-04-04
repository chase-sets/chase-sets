import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import type { Field } from "../../client";
import type { ListResponse } from "@chase-sets/http/responses";
import { FieldListPage } from "../../authoring/fields/ui/field-list-page";
import { createCatalogRequestApiClient } from "../../server";

const DEFAULT_LIST_QUERY = "limit=50&offset=0";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createCatalogRequestApiClient(request);
  return api.listFields<ListResponse<Field>>(DEFAULT_LIST_QUERY);
}

export const meta: MetaFunction = () => [{ title: "Fields | Catalog Admin" }];

export default function FieldsRoute() {
  const data = useLoaderData<typeof loader>();
  return <FieldListPage initialData={data} />;
}


