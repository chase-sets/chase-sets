import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { AccountProfilePage, type Account } from "@chase-sets/identity/web";
import { createMarketplaceIdentityApiClient } from "../api.server";
import { buildMarketplaceMeta } from "../seo";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const accountId = url.searchParams.get("accountId");

  if (!accountId) {
    return {
      account: {
        account_id: "acc_placeholder",
        name: "No account selected",
        display_name: "No account selected",
        account_type: "personal",
        status: "inactive",
        updated_at: new Date().toISOString(),
      } satisfies Account,
    };
  }

  const api = createMarketplaceIdentityApiClient(request);
  return {
    account: await api.getAccount<Account>(accountId),
  };
}

export const meta: MetaFunction = () =>
  buildMarketplaceMeta({ title: "Account | Marketplace" });

export default function MarketplaceAccountRoute() {
  const data = useLoaderData<typeof loader>();
  return <AccountProfilePage account={data.account} />;
}
