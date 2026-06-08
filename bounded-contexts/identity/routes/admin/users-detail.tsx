import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData } from "react-router";
import type { User } from "../../support/request-support/api-client";
import { UserDetailPage } from "../../features/users/ui/user-detail-page";
import { createIdentityRequestApiClient } from "../../support/route-support/identity-request";

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

  if (intent === "update-profile") {
    await api.updateUser(userId, {
      displayName: String(formData.get("displayName") ?? ""),
      givenName: String(formData.get("givenName") ?? ""),
      familyName: String(formData.get("familyName") ?? ""),
    });
  }

  if (intent === "suspend") {
    await api.suspendUser(userId);
  }

  if (intent === "reactivate") {
    await api.reactivateUser(userId);
  }

  return redirect(`/access/users/${userId}`);
}

export const meta: MetaFunction = () => [{ title: t("identity.routes.admin.usersDetail.user.detail.identity.admin") }];

export default function UserDetailRoute() {
  const data = useLoaderData<typeof loader>();
  return <UserDetailPage data={data.data} />;
}
