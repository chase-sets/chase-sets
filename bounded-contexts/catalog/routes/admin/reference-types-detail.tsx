import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import type { ReferenceType } from "../../support/request-support/api-client";
import { ReferenceTypeDetailPage } from "../../features/reference-data/ui/reference-type-detail-page";
import { createCatalogRequestApiClient } from "../../support/request-support/api-client";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createCatalogRequestApiClient(request);
  const id = params.id ?? "";

  try {
    const data = await api.getReferenceType<ReferenceType>(id);
    return { id, data };
  } catch {
    return { id, data: null };
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data?.data ? `${data.data.name} | Catalog Admin` : t("catalog.routes.admin.referenceTypesDetail.reference.type.catalog.admin") },
];

export default function ReferenceTypeDetailRoute() {
  const { id, data } = useLoaderData<typeof loader>();
  return <ReferenceTypeDetailPage id={id} initialData={data} />;
}
