import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import {
  CatalogItemDetailPage,
  type CatalogItemDetail,
} from "@chase-sets/catalog-authoring/web";
import { createCatalogServerApiClient } from "../api.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createCatalogServerApiClient(request);
  const id = params.id ?? "";

  try {
    const data = await api.getCatalogItem<CatalogItemDetail>(id);
    return { id, data };
  } catch {
    return { id, data: null };
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data?.data ? `${data.data.title} | Catalog Admin` : "Catalog Item | Catalog Admin" },
];

export default function CatalogItemDetailRoute() {
  const { id, data } = useLoaderData<typeof loader>();
  return <CatalogItemDetailPage id={id} initialData={data} />;
}
