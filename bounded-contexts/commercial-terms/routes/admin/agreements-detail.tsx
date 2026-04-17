import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { AgreementDetailPage } from "../../features/agreements/ui/agreement-detail-page";
import { createCommercialTermsRequestApiClient } from "../../support/request-support/api-client";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createCommercialTermsRequestApiClient(request);
  return {
    agreement: await api.getAgreement(params.id!),
  };
}

export const meta: MetaFunction = () => [{ title: "Commercial Agreement Detail | Commercial Terms" }];

export default function CommercialTermsAgreementDetailRoute() {
  const data = useLoaderData<typeof loader>();
  return <AgreementDetailPage agreement={data.agreement} />;
}
