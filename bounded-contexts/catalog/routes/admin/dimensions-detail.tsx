import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import {
  type DimensionDetail,
} from "../../client";
import { DimensionDetailPage } from "../../features/dimensions/ui/dimension-detail-page";
import { createCatalogRequestApiClient } from "../../support/request-support/api-client";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createCatalogRequestApiClient(request);
  const id = params.id ?? "";

  try {
    const data = await api.getDimension<DimensionDetail>(id);
    return { id, data };
  } catch {
    return { id, data: null };
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data?.data ? `${data.data.name} | Catalog Admin` : "Dimension | Catalog Admin" },
];

export default function DimensionDetailRoute() {
  const { id, data } = useLoaderData<typeof loader>();
  return <DimensionDetailPage id={id} initialData={data} />;
}


