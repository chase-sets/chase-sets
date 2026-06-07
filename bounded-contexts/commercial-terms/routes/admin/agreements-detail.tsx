import { Banner, LinkButton, Page, PageHeader } from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { AgreementDetailPage } from "../../features/agreements/ui/agreement-detail-page";
import {
  CommercialTermsApiError,
  createCommercialTermsRequestApiClient,
} from "../../support/request-support/api-client";
import { formatCommercialTermsAdminLoadError } from "../../support/request-support/admin-loader-error";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createCommercialTermsRequestApiClient(request);
  try {
    return {
      agreement: await api.getAgreement(params.id!),
      loadError: null,
    };
  } catch (error) {
    return {
      agreement: null,
      loadError: formatCommercialTermsAdminLoadError(error),
    };
  }
}

export async function action({ request, params }: ActionFunctionArgs) {
  const formData = await request.formData();
  const api = createCommercialTermsRequestApiClient(request);

  try {
    await api.updateAgreement(params.id!, {
      label: formData.get("label"),
      marketplaceSalesFeePercentageBps: Number(formData.get("marketplaceSalesFeePercentageBps") ?? 0),
      marketplaceSalesFeeFixedAmount: formData.get("marketplaceSalesFeeFixedAmount"),
      shippingAllowancePercentageBps: Number(formData.get("shippingAllowancePercentageBps") ?? 500),
      status: formData.get("status"),
      effectiveFrom: formData.get("effectiveFrom"),
      effectiveUntil: formData.get("effectiveUntil"),
    });
    return redirect(`/commercial/terms/agreements/${params.id}`);
  } catch (error) {
    if (error instanceof CommercialTermsApiError || error instanceof Error) {
      return { error: error.message };
    }
    throw error;
  }
}

export const meta: MetaFunction = () => [
  { title: t("commercialTerms.routes.admin.agreementsDetail.commercial.agreement.detail.commercial.terms") },
];

export default function CommercialTermsAgreementDetailRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  if (data.loadError || !data.agreement) {
    return (
      <Page>
        <PageHeader
          eyebrow={t("commercialTerms.routes.admin.sharedLoadErrorPage.admin")}
          title={t("commercialTerms.routes.admin.agreementsDetail.agreement.unavailable")}
          description={t("commercialTerms.routes.admin.sharedLoadErrorPage.commercial.terms.could.not.load")}
          actions={
            <LinkButton href="/commercial/terms/agreements" tone="secondary">
              {t("commercialTerms.features.agreements.ui.agreementDetailPage.back.to.agreements")}
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

  return <AgreementDetailPage agreement={data.agreement} errorMessage={actionData?.error ?? null} />;
}
