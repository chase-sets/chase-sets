import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { InvitationListPage, type Invitation } from "@chase-sets/identity/web";
import type { ListResponse } from "@chase-sets/http/responses";
import { createIdentityServerApiClient } from "../api.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createIdentityServerApiClient(request);
  return api.listInvitations<ListResponse<Invitation>>("limit=50&offset=0");
}

export const meta: MetaFunction = () => [{ title: "Invitations | Identity Admin" }];

export default function InvitationsRoute() {
  const data = useLoaderData<typeof loader>();
  return <InvitationListPage initialData={data} />;
}
