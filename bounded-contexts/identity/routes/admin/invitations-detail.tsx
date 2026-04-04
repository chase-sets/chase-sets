import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import type { Invitation } from "../../client";
import { InvitationDetailPage } from "../../invitations/ui/invitation-detail-page";
import { createIdentityRequestApiClient } from "../../server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createIdentityRequestApiClient(request);
  return {
    id: params.id!,
    data: await api.getInvitation<Invitation>(params.id!),
  };
}

export const meta: MetaFunction = () => [{ title: "Invitation Detail | Identity Admin" }];

export default function InvitationDetailRoute() {
  const data = useLoaderData<typeof loader>();
  return <InvitationDetailPage data={data.data} />;
}

