import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { TeamPage, type Membership } from "@chase-sets/identity/web";
import type { ListResponse } from "@chase-sets/http/responses";
import { createMarketplaceIdentityApiClient } from "../api.server";
import { requireMarketplaceActor } from "../auth.server";
import { buildMarketplaceMeta } from "../seo";

export async function loader({ request }: LoaderFunctionArgs) {
  const actor = await requireMarketplaceActor(request, "memberships.view");

  const api = createMarketplaceIdentityApiClient(request);
  const response = await api.listMemberships<ListResponse<Membership>>(
    `search=${encodeURIComponent(actor.userId)}`,
  );
  return { memberships: response.items };
}

export const meta: MetaFunction = () =>
  buildMarketplaceMeta({ title: "Team | Marketplace" });

export default function MarketplaceAccountTeamRoute() {
  const data = useLoaderData<typeof loader>();
  return <TeamPage memberships={data.memberships} />;
}
