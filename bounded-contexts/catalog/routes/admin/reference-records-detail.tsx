import { t } from "@chase-sets/localization";
import type { ListResponse } from "@chase-sets/http/responses";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import type { ReferenceRecord, ReferenceType } from "../../support/request-support/api-client";
import { ReferenceRecordDetailPage } from "../../features/reference-data/ui/reference-record-detail-page";
import { createCatalogRequestApiClient } from "../../support/request-support/api-client";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createCatalogRequestApiClient(request);
  const id = params.id ?? "";
  const referenceTypesPromise = api.listReferenceTypes<ListResponse<ReferenceType>>("limit=500&status=active");
  const referenceRecordsPromise = api.listReferenceRecords<ListResponse<ReferenceRecord>>("limit=500");

  try {
    const [data, referenceTypes, referenceRecords] = await Promise.all([
      api.getReferenceRecord<ReferenceRecord>(id),
      referenceTypesPromise,
      referenceRecordsPromise,
    ]);
    return { id, data, referenceTypes: referenceTypes.items, referenceRecords: referenceRecords.items };
  } catch {
    const referenceTypes = await referenceTypesPromise.catch(() => ({ items: [] as ReferenceType[] }));
    const referenceRecords = await referenceRecordsPromise.catch(() => ({ items: [] as ReferenceRecord[] }));
    return { id, data: null, referenceTypes: referenceTypes.items, referenceRecords: referenceRecords.items };
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data?.data ? `${data.data.name} | Catalog Admin` : t("catalog.routes.admin.referenceRecordsDetail.reference.record.catalog.admin") },
];

export default function ReferenceRecordDetailRoute() {
  const { id, data, referenceTypes, referenceRecords } = useLoaderData<typeof loader>();
  return <ReferenceRecordDetailPage id={id} initialData={data} referenceTypes={referenceTypes} referenceRecords={referenceRecords} />;
}
