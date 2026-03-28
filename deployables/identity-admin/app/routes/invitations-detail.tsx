import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { InvitationDetailPage, type Invitation } from "@chase-sets/identity/web";
import { createIdentityServerApiClient } from "../api.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createIdentityServerApiClient(request);
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
