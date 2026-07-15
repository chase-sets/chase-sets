import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect } from "react-router";
import { loadAfterWrite, navigateAfterWrite } from "@chase-sets/platform-runtime/http";
import type { ApiKey, UserAccountLink } from "../../support/request-support/api-client";
import { createIdentityRequestApiClient, requestWithoutFreshWrite } from "../../support/route-support/identity-request";
import { IdentityApiError } from "../../support/request-support/api-client";
import {
  oneTimeSecretFromMutation,
  type ApiKeySecretMutationResult,
  type OneTimeApiKeySecret,
} from "../../features/api-keys/api/one-time-secret";

type ApiKeyActionData = Readonly<{ oneTimeSecret: OneTimeApiKeySecret }>;

function identityApiErrorStatus(error: unknown) {
  return error instanceof IdentityApiError ? error.status : null;
}

function identityApiErrorBody(error: unknown) {
  return error instanceof IdentityApiError ? error.body : null;
}

function identityApiErrorCode(error: unknown) {
  const body = identityApiErrorBody(error);
  const apiError = typeof body === "object" && body !== null && "error" in body ? body.error : null;
  const code = typeof apiError === "object" && apiError !== null ? (apiError as { code?: unknown }).code : null;
  return typeof code === "string" && code.trim() ? code : null;
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createIdentityRequestApiClient(request);
  const apiKeyId = params.id!;
  const response = await loadAfterWrite({
    request,
    load: () => api.getApiKey<ApiKey>(apiKeyId),
    isNotFound: (error) => identityApiErrorStatus(error) === 404,
    getStatus: identityApiErrorStatus,
    getErrorCode: identityApiErrorCode,
    getBody: identityApiErrorBody,
  });

  if (response.kind === "pending") {
    const recoveryApi = createIdentityRequestApiClient(requestWithoutFreshWrite(request));
    const apiKey = await recoveryApi.getApiKey<ApiKey>(apiKeyId);
    const link = await recoveryApi.getUserAccountLink<UserAccountLink>(apiKey.user_id);
    return redirect(
      link.account_id
        ? `/access/accounts/${link.account_id}?tab=api-access&apiKey=${encodeURIComponent(apiKeyId)}`
        : `/access/api-keys?search=${encodeURIComponent(apiKeyId)}`,
    );
  }

  if (response.kind === "permanent-failure") {
    if ("error" in response) {
      throw response.error;
    }
    throw new Response("API key is unavailable.", { status: 404 });
  }

  const link = await api.getUserAccountLink<UserAccountLink>(response.data.user_id);
  return redirect(
    link.account_id
      ? `/access/accounts/${link.account_id}?tab=api-access&apiKey=${encodeURIComponent(apiKeyId)}`
      : `/access/api-keys?search=${encodeURIComponent(apiKeyId)}`,
  );
}

export async function action({ request, params }: ActionFunctionArgs) {
  const api = createIdentityRequestApiClient(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const apiKeyId = params.id!;
  let result: unknown = null;

  if (intent === "rotate") {
    const rotated = await api.rotateApiKey<ApiKeySecretMutationResult>(apiKeyId);
    return Response.json({ oneTimeSecret: oneTimeSecretFromMutation(rotated, "rotated") } satisfies ApiKeyActionData);
  }

  if (intent === "revoke") {
    result = await api.revokeApiKey(apiKeyId);
  }

  return redirect(navigateAfterWrite(result, `/access/api-keys/${apiKeyId}`));
}

export const meta: MetaFunction = () => [
  { title: t("identity.routes.admin.apiKeysDetail.api.key.detail.identity.admin") },
];

export default function ApiKeyDetailRoute() {
  return null;
}
