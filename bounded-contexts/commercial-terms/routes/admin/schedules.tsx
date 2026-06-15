import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import {
  appendFreshWriteToken,
  loadFreshlyWrittenResource,
  recoverFreshWriteReadError,
} from "@chase-sets/http/responses";
import { ScheduleListPage } from "../../features/schedules/ui/schedule-list-page";
import {
  CommercialTermsApiError,
  createCommercialTermsRequestApiClient,
} from "../../support/request-support/api-client";
import {
  commercialTermsApiErrorBody,
  commercialTermsApiErrorCode,
  commercialTermsApiErrorStatus,
  formatCommercialTermsAdminLoadError,
} from "../../support/request-support/admin-loader-error";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createCommercialTermsRequestApiClient(request);
  try {
    const schedules = await loadFreshlyWrittenResource({
      request,
      load: () => api.listSchedules("limit=100&offset=0"),
      isNotFound: (error) => commercialTermsApiErrorStatus(error) === 404,
    });
    return { items: schedules.items, loadError: null };
  } catch (error) {
    const recovery = recoverFreshWriteReadError({
      request,
      error,
      getStatus: commercialTermsApiErrorStatus,
      getErrorCode: commercialTermsApiErrorCode,
      getBody: commercialTermsApiErrorBody,
      recoverTransient: () => ({ items: [], loadError: formatCommercialTermsAdminLoadError(error) }),
    });
    if (recovery) {
      return recovery;
    }

    return { items: [], loadError: formatCommercialTermsAdminLoadError(error) };
  }
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const api = createCommercialTermsRequestApiClient(request);

  try {
    const result = await api.createSchedule({
      label: formData.get("label"),
      accountType: formData.get("accountType"),
      marketplaceSalesFeePercentageBps: Number(formData.get("marketplaceSalesFeePercentageBps") ?? 0),
      marketplaceSalesFeeFixedAmount: formData.get("marketplaceSalesFeeFixedAmount"),
      shippingAllowancePercentageBps: Number(formData.get("shippingAllowancePercentageBps") ?? 500),
      status: formData.get("status"),
      effectiveFrom: formData.get("effectiveFrom"),
      effectiveUntil: formData.get("effectiveUntil"),
    });
    return redirect(appendFreshWriteToken("/commerce/terms/schedules", result));
  } catch (error) {
    if (error instanceof CommercialTermsApiError || error instanceof Error) {
      return { error: error.message };
    }
    throw error;
  }
}

export const meta: MetaFunction = () => [
  { title: t("commercialTerms.routes.admin.schedules.fee.schedules.commercial.terms") },
];

export default function CommercialTermsSchedulesRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  return (
    <ScheduleListPage items={data.items} errorMessage={actionData?.error ?? null} loadErrorMessage={data.loadError} />
  );
}
