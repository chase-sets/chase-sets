import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { MembershipListPage, type Membership } from "@chase-sets/identity/web";
import type { ListResponse } from "@chase-sets/http/responses";
import { createIdentityServerApiClient } from "../api.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const api = createIdentityServerApiClient(request);
  return api.listMemberships<ListResponse<Membership>>("limit=50&offset=0");
}

export const meta: MetaFunction = () => [{ title: "Memberships | Identity Admin" }];

export default function MembershipsRoute() {
  const data = useLoaderData<typeof loader>();
  return <MembershipListPage initialData={data} />;
}
