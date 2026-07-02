import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { navigateAfterWrite } from "@chase-sets/http/responses";
import { AgreementAccountCreatePage } from "../../features/agreements/ui/agreement-account-create-page";
import {
  CommercialTermsApiError,
  createCommercialTermsRequestApiClient,
} from "../../support/request-support/api-client";
import { normalizeAgreementAccountIdText } from "../../features/agreements/api/account-id";

function readRouteAccountId(params: Readonly<Record<string, string | undefined>>) {
  return normalizeAgreementAccountIdText(params.accountId);
}

export async function loader({ params }: LoaderFunctionArgs) {
  return { accountId: readRouteAccountId(params) };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const formData = await request.formData();

  try {
    const accountId = readRouteAccountId(params);
    const api = createCommercialTermsRequestApiClient(request);
    const result = await api.createAgreement({
      label: formData.get("label"),
      accountId,
      marketplaceSalesFeePercentageBps: Number(formData.get("marketplaceSalesFeePercentageBps") ?? 0),
      marketplaceSalesFeeFixedAmount: formData.get("marketplaceSalesFeeFixedAmount"),
      shippingAllowancePercentageBps: Number(formData.get("shippingAllowancePercentageBps") ?? 500),
      status: formData.get("status"),
      effectiveFrom: formData.get("effectiveFrom"),
      effectiveUntil: formData.get("effectiveUntil"),
    });
    return redirect(navigateAfterWrite(result, "/commerce/terms/agreements"));
  } catch (error) {
    if (error instanceof CommercialTermsApiError || error instanceof Error) {
      return { error: error.message };
    }
    throw error;
  }
}

export const meta: MetaFunction = () => [
  { title: t("commercialTerms.routes.admin.accountAgreementNew.new.commercial.agreement.commercial.terms") },
];

export default function CommercialTermsAccountAgreementNewRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  return <AgreementAccountCreatePage accountId={data.accountId} errorMessage={actionData?.error ?? null} />;
}
