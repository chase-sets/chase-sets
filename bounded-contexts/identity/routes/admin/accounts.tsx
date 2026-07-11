import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { readOffsetPageParams } from "@chase-sets/platform-runtime/http";
import type { Account } from "../../support/request-support/api-client";
import type { ListResponse } from "@chase-sets/http/responses";
import { AccountListPage } from "../../features/accounts/ui/account-list-page";
import { createIdentityRequestApiClient } from "../../support/route-support/identity-request";
import {
  IDENTITY_ACCOUNT_STATUSES,
  identityListQuery,
  readIdentityListFilters,
} from "../../support/route-support/list-filters";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createIdentityRequestApiClient(request);
  const page = readOffsetPageParams(request);
  const filters = readIdentityListFilters(request, IDENTITY_ACCOUNT_STATUSES);
  const data = await api.listAccounts<ListResponse<Account>>(identityListQuery(page.query, filters));
  return { ...data, limit: page.limit, offset: page.offset, filters };
}

export const meta: MetaFunction = () => [{ title: t("identity.routes.admin.accounts.accounts.identity.admin") }];

export default function AccountsRoute() {
  const data = useLoaderData<typeof loader>();
  return <AccountListPage initialData={data} filters={data.filters} />;
}
