import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData } from "react-router";
import type { Invitation } from "../../support/request-support/api-client";
import type { ListResponse } from "@chase-sets/http/responses";
import { createId } from "@chase-sets/primitives/typed-ids";
import { InvitationListPage } from "../../features/invitations/ui/invitation-list-page";
import { createIdentityRequestApiClient } from "../../support/route-support/identity-request";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createIdentityRequestApiClient(request);
  return api.listInvitations<ListResponse<Invitation>>("limit=50&offset=0");
}

export async function action({ request }: ActionFunctionArgs) {
  const api = createIdentityRequestApiClient(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "create") {
    await api.createInvitation({
      invitationId: createId("ivt"),
      accountId: String(formData.get("accountId") ?? ""),
      email: String(formData.get("email") ?? ""),
      roleKey: String(formData.get("roleKey") ?? "viewer"),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    });
  }

  return redirect("/access/invitations");
}

export const meta: MetaFunction = () => [{ title: t("identity.routes.admin.invitations.invitations.identity.admin") }];

export default function InvitationsRoute() {
  const data = useLoaderData<typeof loader>();
  return <InvitationListPage initialData={data} />;
}
