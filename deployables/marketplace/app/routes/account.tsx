import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { AccountProfilePage, type Account } from "@chase-sets/identity/web";
import { createMarketplaceIdentityApiClient } from "../api.server";
import { requireMarketplaceActor } from "../auth.server";
import { buildMarketplaceMeta } from "../seo";

export async function loader({ request }: LoaderFunctionArgs) {
  const actor = await requireMarketplaceActor(request, "accounts.view");

  const api = createMarketplaceIdentityApiClient(request);
  return {
    account: await api.getAccount<Account>(actor.accountId),
  };
}

export const meta: MetaFunction = () =>
  buildMarketplaceMeta({ title: "Account | Marketplace" });

export default function MarketplaceAccountRoute() {
  const data = useLoaderData<typeof loader>();
  return <AccountProfilePage account={data.account} />;
}
