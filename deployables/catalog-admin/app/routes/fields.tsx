import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { FieldListPage } from "../../../../bounded-contexts/catalog/authoring/fields/ui/field-list-page";
import type { Field } from "../../../../bounded-contexts/catalog/authoring/fields/ui/contracts";
import type { ListResponse } from "@chase-sets/http/responses";
import { createCatalogServerApiClient } from "../api.server";

const DEFAULT_LIST_QUERY = "limit=50&offset=0";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createCatalogServerApiClient(request);
  return api.listFields<ListResponse<Field>>(DEFAULT_LIST_QUERY);
}

export const meta: MetaFunction = () => [{ title: "Fields | Catalog Admin" }];

export default function FieldsRoute() {
  const data = useLoaderData<typeof loader>();
  return <FieldListPage initialData={data} />;
}
