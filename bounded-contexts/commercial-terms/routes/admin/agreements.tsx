import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { AgreementListPage } from "../../features/agreements/ui/agreement-list-page";
import {
  CommercialTermsApiError,
  createCommercialTermsRequestApiClient,
} from "../../support/request-support/api-client";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createCommercialTermsRequestApiClient(request);
  return api.listAgreements("limit=100&offset=0");
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const api = createCommercialTermsRequestApiClient(request);

  try {
    await api.createAgreement({
      label: formData.get("label"),
      accountId: formData.get("accountId"),
      marketplaceFeePercentageBps: Number(formData.get("marketplaceFeePercentageBps") ?? 0),
      marketplaceFeeFixedAmount: formData.get("marketplaceFeeFixedAmount"),
      status: formData.get("status"),
      effectiveFrom: formData.get("effectiveFrom"),
      effectiveUntil: formData.get("effectiveUntil"),
    });
    return redirect("/commercial-terms/agreements");
  } catch (error) {
    if (error instanceof CommercialTermsApiError || error instanceof Error) {
      return { error: error.message };
    }
    throw error;
  }
}

export const meta: MetaFunction = () => [{ title: t("commercialTerms.routes.admin.agreements.commercial.agreements.commercial.terms") }];

export default function CommercialTermsAgreementsRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  return <AgreementListPage items={data.items} errorMessage={actionData?.error ?? null} />;
}
