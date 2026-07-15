import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect } from "react-router";
import { defineFormAction, formActionRedirect } from "@chase-sets/platform-runtime/http";
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

const userDestination = (id: string) => `/access/users/${id}`;

export const action = defineFormAction({
  intents: {
    "update-profile": async ({ request, params, formData }) =>
      formActionRedirect(
        await createIdentityRequestApiClient(request).updateUser(params.id!, {
          displayName: String(formData.get("displayName") ?? ""),
          givenName: String(formData.get("givenName") ?? ""),
          familyName: String(formData.get("familyName") ?? ""),
        }),
        userDestination(params.id!),
      ),
    suspend: async ({ request, params }) =>
      formActionRedirect(
        await createIdentityRequestApiClient(request).suspendUser(params.id!),
        userDestination(params.id!),
      ),
    reactivate: async ({ request, params }) =>
      formActionRedirect(
        await createIdentityRequestApiClient(request).reactivateUser(params.id!),
        userDestination(params.id!),
      ),
    "create-api-key": async ({ request, params, formData }) => {
      const created = await createIdentityRequestApiClient(request).createApiKey<ApiKeySecretMutationResult>({
        userId: params.id!,
        name: String(formData.get("apiKeyName") ?? ""),
      });
      return Response.json(
        { oneTimeSecret: oneTimeSecretFromMutation(created, "created") } satisfies UserDetailActionData,
        { status: 201 },
      );
    },
    "add-contact-method": async ({ request, params, formData }) =>
      formActionRedirect(
        await createIdentityRequestApiClient(request).addUserContactMethod(params.id!, {
          contactMethodId: createId("ctm"),
          contactMethodType: String(formData.get("contactMethodType") ?? ""),
          value: String(formData.get("contactMethodValue") ?? ""),
        }),
        userDestination(params.id!),
      ),
    "verify-contact-method": async ({ request, params, formData }) =>
      formActionRedirect(
        await createIdentityRequestApiClient(request).verifyUserContactMethod(
          params.id!,
          String(formData.get("contactMethodId") ?? ""),
        ),
        userDestination(params.id!),
      ),
    "enable-auth-method": async ({ request, params, formData }) =>
      formActionRedirect(
        await createIdentityRequestApiClient(request).enableUserAuthMethod(
          params.id!,
          String(formData.get("authMethod") ?? ""),
        ),
        userDestination(params.id!),
      ),
    "disable-auth-method": async ({ request, params, formData }) =>
      formActionRedirect(
        await createIdentityRequestApiClient(request).disableUserAuthMethod(
          params.id!,
          String(formData.get("authMethod") ?? ""),
        ),
        userDestination(params.id!),
      ),
  },
  onUnknownIntent: ({ params }) => formActionRedirect(null, userDestination(params.id!)),
});

export const meta: MetaFunction = () => [{ title: t("identity.routes.admin.usersDetail.user.detail.identity.admin") }];

export default function UserDetailRoute() {
  return null;
}
