import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import {
  SecurityPage,
  type ApiKey,
  type User,
} from "@chase-sets/identity/web";
import type { ListResponse } from "@chase-sets/http/responses";
import { createMarketplaceIdentityApiClient } from "../api.server";
import { requireMarketplaceActor } from "../auth.server";
import { buildMarketplaceMeta } from "../seo";

export async function loader({ request }: LoaderFunctionArgs) {
  const actor = await requireMarketplaceActor(request, "security.manage");

  const api = createMarketplaceIdentityApiClient(request);
  const [user, apiKeys] = await Promise.all([
    api.getUser<User>(actor.userId),
    api.listApiKeys<ListResponse<ApiKey>>(
      `search=${encodeURIComponent(actor.userId)}`,
    ),
  ]);

  return {
    user,
    apiKeys: apiKeys.items,
  };
}

export const meta: MetaFunction = () =>
  buildMarketplaceMeta({ title: "Security | Marketplace" });

export default function MarketplaceAccountSecurityRoute() {
  const data = useLoaderData<typeof loader>();
  return <SecurityPage user={data.user} apiKeys={data.apiKeys} />;
}
