import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import type { ListResponse } from "@chase-sets/http/responses";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromIdentityApi } from "../../support/route-support/identity-request";
import type { Membership } from "../../support/request-support/api-client";
import { TeamPage } from "../../features/memberships/ui/account-team-page";
import { createIdentityRequestApiClient } from "../../support/route-support/identity-request";

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
  buildOpenGraphMeta({ title: t("identity.routes.marketplace.accountTeam.team.marketplace") });

export default function MarketplaceAccountTeamRoute() {
  const data = useLoaderData<typeof loader>();
  return <TeamPage memberships={data.memberships} />;
}
