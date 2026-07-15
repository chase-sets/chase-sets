import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { navigateAfterWrite } from "@chase-sets/http/responses";
import { defineResourceRoute, readOffsetPageParams } from "@chase-sets/platform-runtime/http";
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
import contextManifest from "../../context.json";
import { commercialTermsApiErrorAdapter } from "../../support/request-support/route-api-error";

export const loader = defineResourceRoute({
  manifest: contextManifest,
  routeId: "commercial-terms-schedules",
  errorAdapter: commercialTermsApiErrorAdapter,
  load: ({ request }) =>
    createCommercialTermsRequestApiClient(request).listSchedules(readOffsetPageParams(request).query),
  map: (schedules, { request }) => {
    const page = readOffsetPageParams(request);
    return {
      items: schedules.items,
      pagination: { limit: page.limit, offset: page.offset, total: schedules.total },
      loadError: null as string | null,
    };
  },
  onPending: (result, { request }) => {
    const page = readOffsetPageParams(request);
    return {
      items: [],
      pagination: { limit: page.limit, offset: page.offset, total: 0 },
      loadError: formatCommercialTermsAdminLoadError("error" in result ? result.error : undefined),
    };
  },
  onPermanentFailure: (result, { request }) => {
    const page = readOffsetPageParams(request);
    return {
      items: [],
      pagination: { limit: page.limit, offset: page.offset, total: 0 },
      loadError: formatCommercialTermsAdminLoadError("error" in result ? result.error : undefined),
    };
  },
});

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
    return redirect(navigateAfterWrite(result, "/commerce/terms/schedules"));
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
    <ScheduleListPage
      items={data.items}
      pagination={data.pagination}
      errorMessage={actionData?.error ?? null}
      loadErrorMessage={data.loadError}
    />
  );
}
