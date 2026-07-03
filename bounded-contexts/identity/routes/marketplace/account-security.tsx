import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import type { ListResponse } from "@chase-sets/http/responses";
import { navigateAfterWrite } from "@chase-sets/platform-runtime/http";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import type { ApiKey, User } from "../../support/request-support/api-client";
import { SecurityPage } from "../../features/api-keys/ui/account-security-page";
import {
  createIdentityRequestApiClient,
  requireActorFromIdentityApi,
} from "../../support/route-support/identity-request";
import {
  oneTimeSecretFromMutation,
  type ApiKeySecretMutationResult,
  type OneTimeApiKeySecret,
} from "../../features/api-keys/api/one-time-secret";

type SecurityActionData = Readonly<{ oneTimeSecret: OneTimeApiKeySecret }>;

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
  let result: unknown = null;

  if (intent === "update-user") {
    result = await api.updateUser(actor.userId, {
      displayName: String(formData.get("displayName") ?? ""),
      givenName: String(formData.get("givenName") ?? ""),
      familyName: String(formData.get("familyName") ?? ""),
    });
  }

  if (intent === "create-api-key") {
    const created = await api.createApiKey<ApiKeySecretMutationResult>({
      userId: actor.userId,
      name: String(formData.get("name") ?? ""),
    });
    return Response.json(
      { oneTimeSecret: oneTimeSecretFromMutation(created, "created") } satisfies SecurityActionData,
      {
        status: 201,
      },
    );
  }

  if (intent === "rotate-api-key") {
    const rotated = await api.rotateApiKey<ApiKeySecretMutationResult>(String(formData.get("apiKeyId") ?? ""));
    return Response.json({ oneTimeSecret: oneTimeSecretFromMutation(rotated, "rotated") } satisfies SecurityActionData);
  }

  if (intent === "revoke-api-key") {
    result = await api.revokeApiKey(String(formData.get("apiKeyId") ?? ""));
  }

  return redirect(navigateAfterWrite(result, "/account/security"));
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("identity.routes.marketplace.accountSecurity.security.marketplace") });

export default function MarketplaceAccountSecurityRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as SecurityActionData | undefined;
  return <SecurityPage user={data.user} apiKeys={data.apiKeys} oneTimeSecret={actionData?.oneTimeSecret} />;
}
