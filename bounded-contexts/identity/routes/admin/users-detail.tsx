import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect } from "react-router";
import { navigateAfterWrite } from "@chase-sets/platform-runtime/http";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { UserAccountLink } from "../../support/request-support/api-client";
import { createIdentityRequestApiClient } from "../../support/route-support/identity-request";
import {
  oneTimeSecretFromMutation,
  type ApiKeySecretMutationResult,
  type OneTimeApiKeySecret,
} from "../../features/api-keys/api/one-time-secret";

type UserDetailActionData = Readonly<{ oneTimeSecret: OneTimeApiKeySecret }>;

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createIdentityRequestApiClient(request);
  const userId = params.id!;
  const link = await api.getUserAccountLink<UserAccountLink>(userId);
  return redirect(
    link.account_id
      ? `/access/accounts/${link.account_id}?tab=team&user=${encodeURIComponent(userId)}`
      : `/access/users?search=${encodeURIComponent(userId)}`,
  );
}

export async function action({ request, params }: ActionFunctionArgs) {
  const api = createIdentityRequestApiClient(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const userId = params.id!;
  let result: unknown = null;

  if (intent === "update-profile") {
    result = await api.updateUser(userId, {
      displayName: String(formData.get("displayName") ?? ""),
      givenName: String(formData.get("givenName") ?? ""),
      familyName: String(formData.get("familyName") ?? ""),
    });
  }

  if (intent === "suspend") {
    result = await api.suspendUser(userId);
  }

  if (intent === "reactivate") {
    result = await api.reactivateUser(userId);
  }

  if (intent === "create-api-key") {
    const created = await api.createApiKey<ApiKeySecretMutationResult>({
      userId,
      name: String(formData.get("apiKeyName") ?? ""),
    });
    return Response.json(
      { oneTimeSecret: oneTimeSecretFromMutation(created, "created") } satisfies UserDetailActionData,
      {
        status: 201,
      },
    );
  }

  if (intent === "add-contact-method") {
    result = await api.addUserContactMethod(userId, {
      contactMethodId: createId("ctm"),
      contactMethodType: String(formData.get("contactMethodType") ?? ""),
      value: String(formData.get("contactMethodValue") ?? ""),
    });
  }

  if (intent === "verify-contact-method") {
    result = await api.verifyUserContactMethod(userId, String(formData.get("contactMethodId") ?? ""));
  }

  if (intent === "enable-auth-method") {
    result = await api.enableUserAuthMethod(userId, String(formData.get("authMethod") ?? ""));
  }

  if (intent === "disable-auth-method") {
    result = await api.disableUserAuthMethod(userId, String(formData.get("authMethod") ?? ""));
  }

  return redirect(navigateAfterWrite(result, `/access/users/${userId}`));
}

export const meta: MetaFunction = () => [{ title: t("identity.routes.admin.usersDetail.user.detail.identity.admin") }];

export default function UserDetailRoute() {
  return null;
}
