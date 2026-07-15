import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import type { ListResponse } from "@chase-sets/http/responses";
import { defineFormAction, formActionRedirect } from "@chase-sets/platform-runtime/http";
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

export const action = defineFormAction({
  authorization: ({ request }) => requireActorFromIdentityApi({ request, permission: "memberships.manage" }),
  intents: {
    "create-invitation": async ({ request, actor, formData }) =>
      formActionRedirect(
        await createIdentityRequestApiClient(request).createInvitation({
          invitationId: createId("ivt"),
          accountId: actor!.accountId,
          email: String(formData.get("email") ?? ""),
          roleKey: String(formData.get("roleKey") ?? "viewer"),
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        }),
        "/account/team",
      ),
    "change-role": async ({ request, formData }) =>
      formActionRedirect(
        await createIdentityRequestApiClient(request).changeMembershipRole(
          String(formData.get("membershipId") ?? ""),
          String(formData.get("roleKey") ?? "viewer"),
        ),
        "/account/team",
      ),
    revoke: async ({ request, formData }) =>
      formActionRedirect(
        await createIdentityRequestApiClient(request).revokeMembership(String(formData.get("membershipId") ?? "")),
        "/account/team",
      ),
    reinstate: async ({ request, formData }) =>
      formActionRedirect(
        await createIdentityRequestApiClient(request).reinstateMembership(String(formData.get("membershipId") ?? "")),
        "/account/team",
      ),
    "cancel-invitation": async ({ request, formData }) =>
      formActionRedirect(
        await createIdentityRequestApiClient(request).cancelInvitation(String(formData.get("invitationId") ?? "")),
        "/account/team",
      ),
  },
  onUnknownIntent: () => formActionRedirect(null, "/account/team"),
});

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("identity.routes.marketplace.accountTeam.team.marketplace") });

export default function MarketplaceAccountTeamRoute() {
  const data = useLoaderData<typeof loader>();
  return <TeamPage invitations={data.invitations} memberships={data.memberships} />;
}
