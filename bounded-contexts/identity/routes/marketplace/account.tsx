import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/bounded-context-runtime";
import { requireActorFromIdentityApi } from "../../server";
import { createIdentityRequestApiClient } from "../../client";
import { AccountProfilePage, type Account } from "../../web";

export async function loader({ request }: LoaderFunctionArgs) {
  const actor = await requireActorFromIdentityApi({
    request,
    permission: "accounts.view",
  });
  const api = createIdentityRequestApiClient(request);

  return {
    account: await api.getAccount<Account>(actor.accountId),
  };
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: "Account | Marketplace" });

export default function MarketplaceAccountRoute() {
  const data = useLoaderData<typeof loader>();
  return <AccountProfilePage account={data.account} />;
}
