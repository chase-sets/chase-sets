import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData } from "react-router";
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

export async function action({ request, params }: ActionFunctionArgs) {
  const api = createIdentityRequestApiClient(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const accountId = params.id!;

  if (intent === "assign-founding-account-badge") {
    await api.assignAccountBadge(accountId, "founding-account");
  }

  if (intent === "remove-founding-account-badge") {
    await api.removeAccountBadge(accountId, "founding-account");
  }

  return redirect(`/identity/accounts/${accountId}`);
}

export const meta: MetaFunction = () => [{ title: t("identity.routes.admin.accountsDetail.account.detail.identity.admin") }];

export default function AccountDetailRoute() {
  const data = useLoaderData<typeof loader>();
  return <AccountDetailPage data={data.data} />;
}
