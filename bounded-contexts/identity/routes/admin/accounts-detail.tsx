import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { AccountDetailPage, type Account } from "@chase-sets/identity/web";
import { createIdentityRequestApiClient } from "../../client";

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

