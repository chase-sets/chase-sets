import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import type { Field } from "../../client";
import { FieldDetailPage } from "../../authoring/fields/ui/field-detail-page";
import { createCatalogRequestApiClient } from "../../server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createCatalogRequestApiClient(request);
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


