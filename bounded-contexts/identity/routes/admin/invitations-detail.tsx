import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
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

export const meta: MetaFunction = () => [{ title: t("identity.routes.admin.invitationsDetail.invitation.detail.identity.admin") }];

export default function InvitationDetailRoute() {
  const data = useLoaderData<typeof loader>();
  return <InvitationDetailPage data={data.data} />;
}

