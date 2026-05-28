import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { type DisplayTemplateDetail } from "../../client";
import { DisplayTemplateDetailPage } from "../../features/display-templates/ui/display-template-detail-page";
import { createCatalogRequestApiClient } from "../../support/request-support/api-client";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createCatalogRequestApiClient(request);
  const id = params.id ?? "";

  try {
    const data = await api.getDisplayTemplate<DisplayTemplateDetail>(id);
    return { id, data };
  } catch {
    return { id, data: null };
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  {
    title: data?.data
      ? `${data.data.name} | Catalog Admin`
      : t("catalog.routes.admin.displayTemplatesDetail.display.template.catalog.admin"),
  },
];

export default function DisplayTemplateDetailRoute() {
  const { id, data } = useLoaderData<typeof loader>();
  return <DisplayTemplateDetailPage id={id} initialData={data} />;
}
