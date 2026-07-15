import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { navigateAfterWrite } from "@chase-sets/http/responses";
import { defineResourceRoute, readOffsetPageParams } from "@chase-sets/platform-runtime/http";
import { AgreementListPage } from "../../features/agreements/ui/agreement-list-page";
import {
  CommercialTermsApiError,
  createCommercialTermsRequestApiClient,
} from "../../support/request-support/api-client";
import { normalizeAgreementAccountIdText } from "../../features/agreements/api/account-id";
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
  routeId: "commercial-terms-agreements",
  errorAdapter: commercialTermsApiErrorAdapter,
  load: ({ request }) =>
    createCommercialTermsRequestApiClient(request).listAgreements(readOffsetPageParams(request).query),
  map: (agreements, { request }) => {
    const page = readOffsetPageParams(request);
    return {
      items: agreements.items,
      pagination: { limit: page.limit, offset: page.offset, total: agreements.total },
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
    const accountId = normalizeAgreementAccountIdText(formData.get("accountId"));
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
  { title: t("commercialTerms.routes.admin.agreements.commercial.agreements.commercial.terms") },
];

export default function CommercialTermsAgreementsRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  return (
    <AgreementListPage
      items={data.items}
      pagination={data.pagination}
      errorMessage={actionData?.error ?? null}
      loadErrorMessage={data.loadError}
    />
  );
}
