import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { type CatalogItemDetail } from "../../client";
import { CatalogItemDetailPage } from "../../features/catalog-items/ui/catalog-item-detail-page";
import { createCatalogRequestApiClient } from "../../support/request-support/api-client";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createCatalogRequestApiClient(request);
  const id = params.id ?? "";

  try {
    const data = await api.getCatalogItem<CatalogItemDetail>(id);
    return { id, data };
  } catch {
    return { id, data: null };
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  {
    title: data?.data
      ? `${data.data.title} | Catalog Admin`
      : t("catalog.routes.admin.catalogItemsDetail.catalog.item.catalog.admin"),
  },
];

export default function CatalogItemDetailRoute() {
  const { id, data } = useLoaderData<typeof loader>();
  return <CatalogItemDetailPage id={id} initialData={data} />;
}
