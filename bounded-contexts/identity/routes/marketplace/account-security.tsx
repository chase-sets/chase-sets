import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useActionData, useLoaderData } from "react-router";
import type { ListResponse } from "@chase-sets/http/responses";
import { defineFormAction, formActionRedirect } from "@chase-sets/platform-runtime/http";
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

export const action = defineFormAction({
  authorization: ({ request }) => requireActorFromIdentityApi({ request, permission: "security.manage" }),
  intents: {
    "update-user": async ({ request, actor, formData }) =>
      formActionRedirect(
        await createIdentityRequestApiClient(request).updateUser(actor!.userId, {
          displayName: String(formData.get("displayName") ?? ""),
          givenName: String(formData.get("givenName") ?? ""),
          familyName: String(formData.get("familyName") ?? ""),
        }),
        "/account/security",
      ),
    "create-api-key": async ({ request, actor, formData }) => {
      const created = await createIdentityRequestApiClient(request).createApiKey<ApiKeySecretMutationResult>({
        userId: actor!.userId,
        name: String(formData.get("name") ?? ""),
      });
      return Response.json(
        { oneTimeSecret: oneTimeSecretFromMutation(created, "created") } satisfies SecurityActionData,
        { status: 201 },
      );
    },
    "rotate-api-key": async ({ request, formData }) => {
      const rotated = await createIdentityRequestApiClient(request).rotateApiKey<ApiKeySecretMutationResult>(
        String(formData.get("apiKeyId") ?? ""),
      );
      return Response.json({
        oneTimeSecret: oneTimeSecretFromMutation(rotated, "rotated"),
      } satisfies SecurityActionData);
    },
    "revoke-api-key": async ({ request, formData }) =>
      formActionRedirect(
        await createIdentityRequestApiClient(request).revokeApiKey(String(formData.get("apiKeyId") ?? "")),
        "/account/security",
      ),
  },
  onUnknownIntent: () => formActionRedirect(null, "/account/security"),
});

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("identity.routes.marketplace.accountSecurity.security.marketplace") });

export default function MarketplaceAccountSecurityRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as SecurityActionData | undefined;
  return <SecurityPage user={data.user} apiKeys={data.apiKeys} oneTimeSecret={actionData?.oneTimeSecret} />;
}
