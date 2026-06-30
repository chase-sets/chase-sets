import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData } from "react-router";
import { navigateAfterWrite, readOffsetPageParams } from "@chase-sets/platform-runtime/http";
import type { Invitation } from "../../support/request-support/api-client";
import type { ListResponse } from "@chase-sets/http/responses";
import { createId } from "@chase-sets/primitives/typed-ids";
import { InvitationListPage } from "../../features/invitations/ui/invitation-list-page";
import { createIdentityRequestApiClient } from "../../support/route-support/identity-request";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createIdentityRequestApiClient(request);
  const page = readOffsetPageParams(request);
  const data = await api.listInvitations<ListResponse<Invitation>>(page.query);
  return { ...data, limit: page.limit, offset: page.offset };
}

export async function action({ request }: ActionFunctionArgs) {
  const api = createIdentityRequestApiClient(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent !== "create") {
    throw new Response("Unsupported invitation action.", { status: 400 });
  }

  const invitationId = createId("ivt");
  const result = await api.createInvitation({
    invitationId,
    accountId: String(formData.get("accountId") ?? ""),
    email: String(formData.get("email") ?? ""),
    roleKey: String(formData.get("roleKey") ?? "viewer"),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  });

  return redirect(navigateAfterWrite(result, `/access/invitations/${invitationId}`));
}

export const meta: MetaFunction = () => [{ title: t("identity.routes.admin.invitations.invitations.identity.admin") }];

export default function InvitationsRoute() {
  const data = useLoaderData<typeof loader>();
  return <InvitationListPage initialData={data} />;
}
