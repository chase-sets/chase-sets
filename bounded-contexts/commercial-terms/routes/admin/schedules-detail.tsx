import { Banner, LinkButton, Page, PageHeader } from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { navigateAfterWrite } from "@chase-sets/http/responses";
import { defineResourceRoute } from "@chase-sets/platform-runtime/http";
import { ScheduleDetailPage } from "../../features/schedules/ui/schedule-detail-page";
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
  routeId: "commercial-terms-schedules-detail",
  errorAdapter: commercialTermsApiErrorAdapter,
  load: ({ request, params }) => createCommercialTermsRequestApiClient(request).getSchedule(params.id!),
  map: (schedule) => ({ schedule: schedule as typeof schedule | null, loadError: null as string | null }),
  onPending: (result) => ({
    schedule: null,
    loadError: formatCommercialTermsAdminLoadError("error" in result ? result.error : undefined),
  }),
  onPermanentFailure: (result) => ({
    schedule: null,
    loadError: formatCommercialTermsAdminLoadError("error" in result ? result.error : undefined),
  }),
});

export async function action({ request, params }: ActionFunctionArgs) {
  const formData = await request.formData();
  const api = createCommercialTermsRequestApiClient(request);

  try {
    const result = await api.updateSchedule(params.id!, {
      label: formData.get("label"),
      marketplaceSalesFeePercentageBps: Number(formData.get("marketplaceSalesFeePercentageBps") ?? 0),
      marketplaceSalesFeeFixedAmount: formData.get("marketplaceSalesFeeFixedAmount"),
      shippingAllowancePercentageBps: Number(formData.get("shippingAllowancePercentageBps") ?? 500),
      status: formData.get("status"),
      effectiveFrom: formData.get("effectiveFrom"),
      effectiveUntil: formData.get("effectiveUntil"),
    });
    return redirect(navigateAfterWrite(result, `/commerce/terms/schedules/${params.id}`));
  } catch (error) {
    if (error instanceof CommercialTermsApiError || error instanceof Error) {
      return { error: error.message };
    }
    throw error;
  }
}

export const meta: MetaFunction = () => [
  { title: t("commercialTerms.routes.admin.schedulesDetail.fee.schedule.detail.commercial.terms") },
];

export default function CommercialTermsScheduleDetailRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  if (data.loadError || !data.schedule) {
    return (
      <Page>
        <PageHeader
          eyebrow={t("commercialTerms.routes.admin.sharedLoadErrorPage.admin")}
          title={t("commercialTerms.routes.admin.schedulesDetail.schedule.unavailable")}
          description={t("commercialTerms.routes.admin.sharedLoadErrorPage.commercial.terms.could.not.load")}
          actions={
            <LinkButton href="/commerce/terms/schedules" tone="secondary">
              {t("commercialTerms.features.schedules.ui.scheduleDetailPage.back.to.schedules")}
            </LinkButton>
          }
        />
        <Banner
          tone="danger"
          title={t("commercialTerms.routes.admin.sharedLoadErrorPage.api.unavailable")}
          description={
            data.loadError ?? t("commercialTerms.support.requestSupport.adminLoaderError.commercial.terms.unavailable")
          }
        />
      </Page>
    );
  }

  return <ScheduleDetailPage schedule={data.schedule} errorMessage={actionData?.error ?? null} />;
}
