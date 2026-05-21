import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { type BlueprintDetail } from "../../client";
import { BlueprintDetailPage } from "../../features/blueprints/ui/blueprint-detail-page";
import { createCatalogRequestApiClient } from "../../support/request-support/api-client";

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
  {
    title: data?.data
      ? `${data.data.name} | Catalog Admin`
      : t("catalog.routes.admin.blueprintsDetail.blueprint.catalog.admin"),
  },
];

export default function BlueprintDetailRoute() {
  const { id, data } = useLoaderData<typeof loader>();
  return <BlueprintDetailPage id={id} initialData={data} />;
}
