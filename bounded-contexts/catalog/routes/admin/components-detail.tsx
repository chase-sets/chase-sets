import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import {
  type ComponentDetail,
} from "../../client";
import { ComponentDetailPage } from "../../features/components/ui/component-detail-page";
import { createCatalogRequestApiClient } from "../../support/request-support/api-client";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createCatalogRequestApiClient(request);
  const id = params.id ?? "";

  try {
    const data = await api.getComponent<ComponentDetail>(id);
    return { id, data };
  } catch {
    return { id, data: null };
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data?.data ? `${data.data.name} | Catalog Admin` : "Component | Catalog Admin" },
];

export default function ComponentDetailRoute() {
  const { id, data } = useLoaderData<typeof loader>();
  return <ComponentDetailPage id={id} initialData={data} />;
}


