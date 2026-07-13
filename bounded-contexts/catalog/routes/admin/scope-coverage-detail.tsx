import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import type { ScopeCoverageMatrix } from "../../support/request-support/api-client";
import { ScopeCoverageDetailPage } from "../../features/provider-scope-mapping/ui/scope-coverage-detail-page";
import { createCatalogRequestApiClient } from "../../support/request-support/api-client";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createCatalogRequestApiClient(request);
  const scopeRecordId = params.id ?? "";

  try {
    const data = await api.getScopeCoverageMatrix<ScopeCoverageMatrix>(scopeRecordId);
    return { scopeRecordId, data };
  } catch {
    return { scopeRecordId, data: null };
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  {
    title: data?.data
      ? `${data.data.scopeName} | Catalog Admin`
      : t("catalog.routes.admin.scopeCoverageDetail.scope.coverage.catalog.admin"),
  },
];

export default function ScopeCoverageDetailRoute() {
  const { scopeRecordId, data } = useLoaderData<typeof loader>();
  return <ScopeCoverageDetailPage scopeRecordId={scopeRecordId} initialData={data} />;
}
