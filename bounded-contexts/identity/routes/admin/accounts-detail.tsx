import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import type { Account } from "../../support/request-support/api-client";
import { AccountDetailPage } from "../../features/accounts/ui/account-detail-page";
import { createIdentityRequestApiClient } from "../../support/route-support/identity-request";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createIdentityRequestApiClient(request);
  return {
    id: params.id!,
    data: await api.getAccount<Account>(params.id!),
  };
}

export const meta: MetaFunction = () => [{ title: "Account Detail | Identity Admin" }];

export default function AccountDetailRoute() {
  const data = useLoaderData<typeof loader>();
  return <AccountDetailPage data={data.data} />;
}

