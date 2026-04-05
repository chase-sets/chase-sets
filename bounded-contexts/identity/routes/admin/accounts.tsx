import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import type { Account } from "../../request-support/api-client";
import type { ListResponse } from "@chase-sets/http/responses";
import { AccountListPage } from "../../accounts/ui/account-list-page";
import { createIdentityRequestApiClient } from "../../route-support/identity-request";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createIdentityRequestApiClient(request);
  return api.listAccounts<ListResponse<Account>>("limit=50&offset=0");
}

export const meta: MetaFunction = () => [{ title: "Accounts | Identity Admin" }];

export default function AccountsRoute() {
  const data = useLoaderData<typeof loader>();
  return <AccountListPage initialData={data} />;
}

