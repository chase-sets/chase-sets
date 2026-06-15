import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import {
  appendFreshWriteToken,
  loadFreshlyWrittenResource,
  recoverFreshWriteReadError,
} from "@chase-sets/http/responses";
import { AgreementListPage } from "../../features/agreements/ui/agreement-list-page";
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
    const agreements = await loadFreshlyWrittenResource({
      request,
      load: () => api.listAgreements("limit=100&offset=0"),
      isNotFound: (error) => commercialTermsApiErrorStatus(error) === 404,
    });
    return { items: agreements.items, loadError: null };
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
    const result = await api.createAgreement({
      label: formData.get("label"),
      accountId: formData.get("accountId"),
      marketplaceSalesFeePercentageBps: Number(formData.get("marketplaceSalesFeePercentageBps") ?? 0),
      marketplaceSalesFeeFixedAmount: formData.get("marketplaceSalesFeeFixedAmount"),
      shippingAllowancePercentageBps: Number(formData.get("shippingAllowancePercentageBps") ?? 500),
      status: formData.get("status"),
      effectiveFrom: formData.get("effectiveFrom"),
      effectiveUntil: formData.get("effectiveUntil"),
    });
    return redirect(appendFreshWriteToken("/commerce/terms/agreements", result));
  } catch (error) {
    if (error instanceof CommercialTermsApiError || error instanceof Error) {
      return { error: error.message };
    }
    throw error;
  }
}

export const meta: MetaFunction = () => [
  { title: t("commercialTerms.routes.admin.agreements.commercial.agreements.commercial.terms") },
];

export default function CommercialTermsAgreementsRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  return (
    <AgreementListPage items={data.items} errorMessage={actionData?.error ?? null} loadErrorMessage={data.loadError} />
  );
}
