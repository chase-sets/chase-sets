import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import type { SourceObservationDetail } from "../../client";
import { SourceObservationDetailPage } from "../../features/source-observations/ui/source-observation-detail-page";
import { createCatalogRequestApiClient } from "../../support/request-support/api-client";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createCatalogRequestApiClient(request);
  const id = params.id ?? "";

  try {
    const data = await api.getSourceObservation<SourceObservationDetail>(id);
    return { id, data };
  } catch {
    return { id, data: null };
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  {
    title: data?.data
      ? t("catalog.routes.admin.sourceObservationsDetail.named.title", {
          name: data.data.normalized.name,
        })
      : t("catalog.routes.admin.sourceObservationsDetail.source.observation.catalog.admin"),
  },
];

export default function SourceObservationDetailRoute() {
  const { id, data } = useLoaderData<typeof loader>();
  return <SourceObservationDetailPage id={id} initialData={data} />;
}
