import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import type { ListResponse } from "@chase-sets/http/responses";
import { buildOpenGraphMeta } from "@chase-sets/bounded-context-runtime";
import { requireActorFromIdentityApi } from "../../server";
import { createIdentityRequestApiClient } from "../../client";
import { TeamPage, type Membership } from "../../web";

export async function loader({ request }: LoaderFunctionArgs) {
  const actor = await requireActorFromIdentityApi({
    request,
    permission: "memberships.view",
  });
  const api = createIdentityRequestApiClient(request);
  const response = await api.listMemberships<ListResponse<Membership>>(
    `search=${encodeURIComponent(actor.userId)}`,
  );

  return { memberships: response.items };
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: "Team | Marketplace" });

export default function MarketplaceAccountTeamRoute() {
  const data = useLoaderData<typeof loader>();
  return <TeamPage memberships={data.memberships} />;
}
