import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData } from "react-router";
import type { ListResponse } from "@chase-sets/http/responses";
import { navigateAfterWrite } from "@chase-sets/platform-runtime/http";
import { createId } from "@chase-sets/primitives/typed-ids";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromIdentityApi } from "../../support/route-support/identity-request";
import type { Invitation, Membership } from "../../support/request-support/api-client";
import { TeamPage } from "../../features/memberships/ui/account-team-page";
import { createIdentityRequestApiClient } from "../../support/route-support/identity-request";

export async function loader({ request }: LoaderFunctionArgs) {
  const actor = await requireActorFromIdentityApi({
    request,
    permission: "memberships.view",
  });
  const api = createIdentityRequestApiClient(request);
  const [memberships, invitations] = await Promise.all([
    api.listMemberships<ListResponse<Membership>>(`search=${encodeURIComponent(actor.accountId)}`),
    api.listInvitations<ListResponse<Invitation>>(`search=${encodeURIComponent(actor.accountId)}`),
  ]);

  return { invitations: invitations.items, memberships: memberships.items };
}

export async function action({ request }: ActionFunctionArgs) {
  const actor = await requireActorFromIdentityApi({
    request,
    permission: "memberships.manage",
  });
  const api = createIdentityRequestApiClient(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  let result: unknown = null;

  if (intent === "create-invitation") {
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    result = await api.createInvitation({
      invitationId: createId("ivt"),
      accountId: actor.accountId,
      email: String(formData.get("email") ?? ""),
      roleKey: String(formData.get("roleKey") ?? "viewer"),
      expiresAt,
    });
  }

  if (intent === "change-role") {
    result = await api.changeMembershipRole(
      String(formData.get("membershipId") ?? ""),
      String(formData.get("roleKey") ?? "viewer"),
    );
  }

  if (intent === "revoke") {
    result = await api.revokeMembership(String(formData.get("membershipId") ?? ""));
  }

  if (intent === "reinstate") {
    result = await api.reinstateMembership(String(formData.get("membershipId") ?? ""));
  }

  if (intent === "cancel-invitation") {
    result = await api.cancelInvitation(String(formData.get("invitationId") ?? ""));
  }

  return redirect(navigateAfterWrite(result, "/account/team"));
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("identity.routes.marketplace.accountTeam.team.marketplace") });

export default function MarketplaceAccountTeamRoute() {
  const data = useLoaderData<typeof loader>();
  return <TeamPage invitations={data.invitations} memberships={data.memberships} />;
}
