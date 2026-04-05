import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import type { Membership } from "../../request-support/api-client";
import type { ListResponse } from "@chase-sets/http/responses";
import { MembershipListPage } from "../../memberships/ui/membership-list-page";
import { createIdentityRequestApiClient } from "../../route-support/identity-request";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createIdentityRequestApiClient(request);
  return api.listMemberships<ListResponse<Membership>>("limit=50&offset=0");
}

export const meta: MetaFunction = () => [{ title: "Memberships | Identity Admin" }];

export default function MembershipsRoute() {
  const data = useLoaderData<typeof loader>();
  return <MembershipListPage initialData={data} />;
}

