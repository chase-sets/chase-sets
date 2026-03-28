import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { AccountSelectionPage } from "@chase-sets/identity/web";
import { buildMarketplaceMeta } from "../seo";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  return {
    memberships: url.searchParams.getAll("accountId").map((accountId, index) => ({
      accountId,
      roleKey: url.searchParams.getAll("roleKey")[index] ?? "viewer",
    })),
  };
}

export const meta: MetaFunction = () =>
  buildMarketplaceMeta({ title: "Select Account | Marketplace" });

export default function MarketplaceAccountSelectionRoute() {
  const data = useLoaderData<typeof loader>();
  return <AccountSelectionPage memberships={data.memberships} />;
}
