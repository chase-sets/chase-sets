import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { type CategoryDetail } from "../../client";
import { CategoryDetailPage } from "../../features/categories/ui/category-detail-page";
import { createCatalogRequestApiClient } from "../../support/request-support/api-client";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createCatalogRequestApiClient(request);
  const id = params.id ?? "";

  try {
    const data = await api.getCategory<CategoryDetail>(id);
    return { id, data };
  } catch {
    return { id, data: null };
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  {
    title: data?.data
      ? `${data.data.name} | Catalog Admin`
      : t("catalog.routes.admin.categoriesDetail.category.catalog.admin"),
  },
];

export default function CategoryDetailRoute() {
  const { id, data } = useLoaderData<typeof loader>();
  return <CategoryDetailPage id={id} initialData={data} />;
}
