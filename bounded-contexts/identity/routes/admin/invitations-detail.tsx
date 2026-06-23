import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData } from "react-router";
import { navigateAfterWrite } from "@chase-sets/platform-runtime/http";
import type { Invitation } from "../../support/request-support/api-client";
import { InvitationDetailPage } from "../../features/invitations/ui/invitation-detail-page";
import { createIdentityRequestApiClient } from "../../support/route-support/identity-request";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createIdentityRequestApiClient(request);
  return {
    id: params.id!,
    data: await api.getInvitation<Invitation>(params.id!),
  };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const api = createIdentityRequestApiClient(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const invitationId = params.id!;
  let result: unknown = null;

  if (intent === "resend") {
    result = await api.resendInvitation(invitationId, new Date(String(formData.get("expiresAt") ?? "")).toISOString());
  }

  if (intent === "cancel") {
    result = await api.cancelInvitation(invitationId);
  }

  if (intent === "decline") {
    result = await api.declineInvitation(invitationId);
  }

  return redirect(navigateAfterWrite(result, `/access/invitations/${invitationId}`));
}

export const meta: MetaFunction = () => [
  { title: t("identity.routes.admin.invitationsDetail.invitation.detail.identity.admin") },
];

export default function InvitationDetailRoute() {
  const data = useLoaderData<typeof loader>();
  return <InvitationDetailPage data={data.data} />;
}
