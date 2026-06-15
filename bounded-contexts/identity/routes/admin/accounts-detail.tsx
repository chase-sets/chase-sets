import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData } from "react-router";
import { appendFreshWriteToken } from "@chase-sets/http/responses";
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
  let result: unknown = null;

  if (intent === "update-profile") {
    result = await api.updateAccount(accountId, {
      name: String(formData.get("name") ?? ""),
      displayName: String(formData.get("displayName") ?? ""),
    });
  }

  if (intent === "suspend") {
    result = await api.suspendAccount(accountId);
  }

  if (intent === "reactivate") {
    result = await api.reactivateAccount(accountId);
  }

  if (intent === "close") {
    result = await api.closeAccount(accountId);
  }

  if (intent === "assign-founding-account-badge") {
    result = await api.assignAccountBadge(accountId, "founding-account");
  }

  if (intent === "remove-founding-account-badge") {
    result = await api.removeAccountBadge(accountId, "founding-account");
  }

  return redirect(appendFreshWriteToken(`/access/accounts/${accountId}`, result));
}

export const meta: MetaFunction = () => [
  { title: t("identity.routes.admin.accountsDetail.account.detail.identity.admin") },
];

export default function AccountDetailRoute() {
  const data = useLoaderData<typeof loader>();
  return <AccountDetailPage data={data.data} />;
}
