import { t } from "@chase-sets/localization";
import { defineFormAction, defineResourceRoute, formActionRedirect } from "@chase-sets/platform-runtime/http";
import type { MetaFunction } from "react-router";
import { redirect } from "react-router";
import contextManifest from "../../context.json";
import {
  oneTimeSecretFromMutation,
  type ApiKeySecretMutationResult,
  type OneTimeApiKeySecret,
} from "../../features/api-keys/api/one-time-secret";
import type { ApiKey, UserAccountLink } from "../../support/request-support/api-client";
import { identityApiErrorAdapter } from "../../support/request-support/route-api-error";
import { createIdentityRequestApiClient, requestWithoutFreshWrite } from "../../support/route-support/identity-request";

type ApiKeyActionData = Readonly<{ oneTimeSecret: OneTimeApiKeySecret }>;

async function apiKeyDestination(request: Request, apiKey: ApiKey) {
  const link = await createIdentityRequestApiClient(request).getUserAccountLink<UserAccountLink>(apiKey.user_id);
  return link.account_id
    ? `/access/accounts/${link.account_id}?tab=api-access&apiKey=${encodeURIComponent(apiKey.api_key_id)}`
    : `/access/api-keys?search=${encodeURIComponent(apiKey.api_key_id)}`;
}

export const loader = defineResourceRoute({
  manifest: contextManifest,
  routeId: "api-keys-detail",
  errorAdapter: identityApiErrorAdapter,
  load: ({ request, params }) => createIdentityRequestApiClient(request).getApiKey<ApiKey>(params.id!),
  map: async (apiKey, { request }) => redirect(await apiKeyDestination(request, apiKey)),
  onPending: async (_result, { request, params }) => {
    const recoveryRequest = requestWithoutFreshWrite(request);
    const apiKey = await createIdentityRequestApiClient(recoveryRequest).getApiKey<ApiKey>(params.id!);
    return redirect(await apiKeyDestination(recoveryRequest, apiKey));
  },
  onPermanentFailure: (response) => {
    if ("error" in response) {
      throw response.error;
    }
    throw new Response("API key is unavailable.", { status: 404 });
  },
});

export const action = defineFormAction({
  intents: {
    rotate: async ({ request, params }) => {
      const rotated = await createIdentityRequestApiClient(request).rotateApiKey<ApiKeySecretMutationResult>(
        params.id!,
      );
      return Response.json({
        oneTimeSecret: oneTimeSecretFromMutation(rotated, "rotated"),
      } satisfies ApiKeyActionData);
    },
    revoke: async ({ request, params }) =>
      formActionRedirect(
        await createIdentityRequestApiClient(request).revokeApiKey(params.id!),
        `/access/api-keys/${params.id!}`,
      ),
  },
  onUnknownIntent: ({ params }) => formActionRedirect(null, `/access/api-keys/${params.id!}`),
});

export const meta: MetaFunction = () => [
  { title: t("identity.routes.admin.apiKeysDetail.api.key.detail.identity.admin") },
];

export default function ApiKeyDetailRoute() {
  return null;
}
