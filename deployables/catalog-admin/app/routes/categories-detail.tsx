import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { CategoryDetailPage } from "../../../../bounded-contexts/catalog/authoring/categories/ui/category-detail-page";
import type { CategoryDetail } from "../../../../bounded-contexts/catalog/authoring/categories/ui/contracts";
import { createCatalogServerApiClient } from "../api.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createCatalogServerApiClient(request);
  const id = params.id ?? "";

  try {
    const data = await api.getCategory<CategoryDetail>(id);
    return { id, data };
  } catch {
    return { id, data: null };
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data?.data ? `${data.data.name} | Catalog Admin` : "Category | Catalog Admin" },
];

export default function CategoryDetailRoute() {
  const { id, data } = useLoaderData<typeof loader>();
  return <CategoryDetailPage id={id} initialData={data} />;
}
