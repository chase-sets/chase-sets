import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { MembershipDetailPage, type Membership } from "@chase-sets/identity/web";
import { createIdentityRequestApiClient } from "../../client";

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

