import { t } from "@chase-sets/localization";
import type { ListResponse } from "@chase-sets/http/responses";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import type { ReferenceRecord, ReferenceType } from "../../support/request-support/api-client";
import { ReferenceRecordListPage } from "../../features/reference-data/ui/reference-record-list-page";
import { createCatalogRequestApiClient } from "../../support/request-support/api-client";
import { loadCatalogListRouteData } from "../../support/shell-support/list-query-state";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createCatalogRequestApiClient(request);
  const [routeData, referenceTypes, referenceRecords] = await Promise.all([
    loadCatalogListRouteData<ReferenceRecord>(
      request,
      (query) => api.listReferenceRecords(query),
    ),
    api.listReferenceTypes<ListResponse<ReferenceType>>("limit=500&status=active"),
    api.listReferenceRecords<ListResponse<ReferenceRecord>>("limit=500"),
  ]);

  return {
    ...routeData,
    referenceTypes: referenceTypes.items,
    referenceRecords: referenceRecords.items,
  };
}

export const meta: MetaFunction = () => [{ title: t("catalog.routes.admin.referenceRecords.reference.records.catalog.admin") }];

export default function ReferenceRecordsRoute() {
  const routeData = useLoaderData<typeof loader>();
  return (
    <ReferenceRecordListPage
      data={routeData.data}
      query={routeData.query}
      referenceTypes={routeData.referenceTypes}
      referenceRecords={routeData.referenceRecords}
    />
  );
}
