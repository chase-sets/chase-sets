import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import type { Invitation } from "../../request-support/api-client";
import type { ListResponse } from "@chase-sets/http/responses";
import { InvitationListPage } from "../../invitations/ui/invitation-list-page";
import { createIdentityRequestApiClient } from "../../route-support/identity-request";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createIdentityRequestApiClient(request);
  return api.listInvitations<ListResponse<Invitation>>("limit=50&offset=0");
}

export const meta: MetaFunction = () => [{ title: "Invitations | Identity Admin" }];

export default function InvitationsRoute() {
  const data = useLoaderData<typeof loader>();
  return <InvitationListPage initialData={data} />;
}

