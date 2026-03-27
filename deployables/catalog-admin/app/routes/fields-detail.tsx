import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { FieldDetailPage, type Field } from "@chase-sets/catalog-authoring/web";
import { createCatalogServerApiClient } from "../api.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createCatalogServerApiClient(request);
  const id = params.id ?? "";

  try {
    const data = await api.getField<Field>(id);
    return { id, data };
  } catch {
    return { id, data: null };
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data?.data ? `${data.data.name} | Catalog Admin` : "Field | Catalog Admin" },
];

export default function FieldDetailRoute() {
  const { id, data } = useLoaderData<typeof loader>();
  return <FieldDetailPage id={id} initialData={data} />;
}
