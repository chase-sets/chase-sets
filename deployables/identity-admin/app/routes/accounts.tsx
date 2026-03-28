import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { AccountListPage, type Account } from "@chase-sets/identity/web";
import type { ListResponse } from "@chase-sets/http/responses";
import { createIdentityServerApiClient } from "../api.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createIdentityServerApiClient(request);
  return api.listAccounts<ListResponse<Account>>("limit=50&offset=0");
}

export const meta: MetaFunction = () => [{ title: "Accounts | Identity Admin" }];

export default function AccountsRoute() {
  const data = useLoaderData<typeof loader>();
  return <AccountListPage initialData={data} />;
}
