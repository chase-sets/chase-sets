import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import {
  SecurityPage,
  type ApiKey,
  type User,
} from "@chase-sets/identity/web";
import type { ListResponse } from "@chase-sets/http/responses";
import { createMarketplaceIdentityApiClient } from "../api.server";
import { buildMarketplaceMeta } from "../seo";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const userId = url.searchParams.get("userId");

  if (!userId) {
    return {
      user: {
        user_id: "usr_placeholder",
        display_name: "Guest",
        given_name: "",
        family_name: "",
        primary_email: "guest@example.test",
        status: "inactive",
        auth_methods: [],
        updated_at: new Date().toISOString(),
      } satisfies User,
      apiKeys: [] as ApiKey[],
    };
  }

  const api = createMarketplaceIdentityApiClient(request);
  const [user, apiKeys] = await Promise.all([
    api.getUser<User>(userId),
    api.listApiKeys<ListResponse<ApiKey>>(`search=${encodeURIComponent(userId)}`),
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
