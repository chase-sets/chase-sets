import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData } from "react-router";
import type { ListResponse } from "@chase-sets/http/responses";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import type { ApiKey, User } from "../../support/request-support/api-client";
import { SecurityPage } from "../../features/api-keys/ui/account-security-page";
import {
  createIdentityRequestApiClient,
  requireActorFromIdentityApi,
} from "../../support/route-support/identity-request";

export async function loader({ request }: LoaderFunctionArgs) {
  const actor = await requireActorFromIdentityApi({
    request,
    permission: "security.manage",
  });
  const api = createIdentityRequestApiClient(request);
  const [user, apiKeys] = await Promise.all([
    api.getUser<User>(actor.userId),
    api.listApiKeys<ListResponse<ApiKey>>(`search=${encodeURIComponent(actor.userId)}`),
  ]);

  return {
    user,
    apiKeys: apiKeys.items,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const actor = await requireActorFromIdentityApi({
    request,
    permission: "security.manage",
  });
  const api = createIdentityRequestApiClient(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "update-user") {
    await api.updateUser(actor.userId, {
      displayName: String(formData.get("displayName") ?? ""),
      givenName: String(formData.get("givenName") ?? ""),
      familyName: String(formData.get("familyName") ?? ""),
    });
  }

  if (intent === "create-api-key") {
    await api.createApiKey({
      userId: actor.userId,
      name: String(formData.get("name") ?? ""),
    });
  }

  if (intent === "rotate-api-key") {
    await api.rotateApiKey(String(formData.get("apiKeyId") ?? ""));
  }

  if (intent === "revoke-api-key") {
    await api.revokeApiKey(String(formData.get("apiKeyId") ?? ""));
  }

  return redirect("/account/security");
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("identity.routes.marketplace.accountSecurity.security.marketplace") });

export default function MarketplaceAccountSecurityRoute() {
  const data = useLoaderData<typeof loader>();
  return <SecurityPage user={data.user} apiKeys={data.apiKeys} />;
}
