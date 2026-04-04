import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import {
  BlueprintDetailPage,
  type BlueprintDetail,
} from "@chase-sets/catalog/web";
import { createCatalogRequestApiClient } from "../../client";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createCatalogRequestApiClient(request);
  const id = params.id ?? "";

  try {
    const data = await api.getBlueprint<BlueprintDetail>(id);
    return { id, data };
  } catch {
    return { id, data: null };
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data?.data ? `${data.data.name} | Catalog Admin` : "Blueprint | Catalog Admin" },
];

export default function BlueprintDetailRoute() {
  const { id, data } = useLoaderData<typeof loader>();
  return <BlueprintDetailPage id={id} initialData={data} />;
}


