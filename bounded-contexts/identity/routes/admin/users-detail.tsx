import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData } from "react-router";
import { navigateAfterWrite } from "@chase-sets/platform-runtime/http";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { User } from "../../support/request-support/api-client";
import { UserDetailPage } from "../../features/users/ui/user-detail-page";
import { createIdentityRequestApiClient } from "../../support/route-support/identity-request";

type ApiKeyMutationResult = Readonly<{ id?: unknown }>;

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createIdentityRequestApiClient(request);
  return {
    id: params.id!,
    data: await api.getUser<User>(params.id!),
  };
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
    const created = await api.createApiKey<ApiKeyMutationResult>({
      userId,
      name: String(formData.get("apiKeyName") ?? ""),
    });
    if (typeof created.id !== "string" || !created.id.trim()) {
      throw new Response("API key create did not return an id.", { status: 502 });
    }

    return redirect(navigateAfterWrite(created, `/access/api-keys/${created.id}`));
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
  const data = useLoaderData<typeof loader>();
  return <UserDetailPage data={data.data} />;
}
