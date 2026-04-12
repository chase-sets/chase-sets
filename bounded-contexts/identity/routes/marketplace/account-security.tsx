import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import type { ListResponse } from "@chase-sets/http/responses";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import type { ApiKey, User } from "../../request-support/api-client";
import { SecurityPage } from "../../customer/security-page";
import {
  createIdentityRequestApiClient,
  requireActorFromIdentityApi,
} from "../../route-support/identity-request";

export async function loader({ request }: LoaderFunctionArgs) {
  const actor = await requireActorFromIdentityApi({
    request,
    permission: "security.manage",
  });
  const api = createIdentityRequestApiClient(request);
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
  buildOpenGraphMeta({ title: "Security | Marketplace" });

export default function MarketplaceAccountSecurityRoute() {
  const data = useLoaderData<typeof loader>();
  return <SecurityPage user={data.user} apiKeys={data.apiKeys} />;
}
