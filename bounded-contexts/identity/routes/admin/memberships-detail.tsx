import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import type { Membership } from "../../client";
import { MembershipDetailPage } from "../../memberships/ui/membership-detail-page";
import { createIdentityRequestApiClient } from "../../server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createIdentityRequestApiClient(request);
  return {
    id: params.id!,
    data: await api.getMembership<Membership>(params.id!),
  };
}

export const meta: MetaFunction = () => [{ title: "Membership Detail | Identity Admin" }];

export default function MembershipDetailRoute() {
  const data = useLoaderData<typeof loader>();
  return <MembershipDetailPage data={data.data} />;
}

