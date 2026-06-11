import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { SupportOperationsDetailPage } from "../../features/support-requests/ui/support-operations-page";
import { createSupportRequestRequestApiClient } from "../../support/request-support/support-request-api-client";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createSupportRequestRequestApiClient(request);
  return {
    supportRequest: await api.getSupportOperationsRequest(params.id ?? ""),
  };
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  {
    title: data?.supportRequest
      ? t("support.routes.admin.operationsRequestDetail.meta.title", {
          id: data.supportRequest.support_request_id,
        })
      : t("support.routes.admin.operationsQueue.meta.title"),
  },
];

export default function SupportOperationsRequestDetailRoute() {
  const { supportRequest } = useLoaderData<typeof loader>();
  return <SupportOperationsDetailPage request={supportRequest} />;
}
