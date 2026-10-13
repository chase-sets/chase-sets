import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useActionData, useLoaderData } from "react-router";
import type { ListResponse } from "@chase-sets/http/responses";
import { defineFormAction } from "@chase-sets/platform-runtime/http";
import { navigateAfterWrite } from "@chase-sets/http/responses";
import {
  accountMutationResponse,
  requireInterruptionSafeClient,
} from "../../features/account-management/api/marketplace-action";
import type { MutationResult } from "../../features/account-management/api/runtime";
import { AccountMutationBoundary } from "../../features/account-management/ui/controller";
import { createId } from "@chase-sets/primitives/typed-ids";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromIdentityApi } from "../../support/route-support/identity-request";
import type { Invitation, Membership } from "../../support/request-support/api-client";
import { TeamPage } from "../../features/memberships/ui/account-team-page";
import { createIdentityRequestApiClient } from "../../support/route-support/identity-request";
import { requestInvitationAcceptanceLink } from "../../features/invitations/integrations/request-invitation-acceptance-link";
import {
  createAccountActionErrorHandling,
  type AccountActionFailureResult,
} from "../../support/route-support/account-action-errors";

const actionErrors = createAccountActionErrorHandling();

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

  return {
    invitations: invitations.items,
    memberships: memberships.items,
    mutationActor: { tenantId: actor.tenantId, userId: actor.userId, accountId: actor.accountId },
  };
}

export const action = requireInterruptionSafeClient(
  defineFormAction({
    ...actionErrors.options,
    authorization: ({ request }) => requireActorFromIdentityApi({ request, permission: "memberships.manage" }),
    intents: {
      "create-invitation": async (context) => {
        const { request, actor, formData } = context;
        const invitationId = createId("ivt");
        const result = await createIdentityRequestApiClient(request).createInvitation<MutationResult>({
          invitationId,
          accountId: actor!.accountId,
          email: String(formData.get("email") ?? ""),
          roleKey: String(formData.get("roleKey") ?? "viewer"),
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        });
        if (result.outcome === "committed" && result.newlyCommitted) {
          actionErrors.markCommitted(context);
          await requestInvitationAcceptanceLink(request, result.receipt.result.id, result).catch(() => undefined);
        }
        return accountMutationResponse(
          result.outcome === "committed" ? { ...result, delivery: "unknown" } : result,
          "/account/team",
          navigateAfterWrite(result, "/account/team"),
        );
      },
      "change-role": async ({ request, formData }) => {
        const result = await createIdentityRequestApiClient(request).changeMembershipRole<MutationResult>(
          String(formData.get("membershipId") ?? ""),
          String(formData.get("roleKey") ?? "viewer"),
        );
        return accountMutationResponse(result, "/account/team", navigateAfterWrite(result, "/account/team"));
      },
      revoke: async ({ request, formData }) => {
        const result = await createIdentityRequestApiClient(request).revokeMembership<MutationResult>(
          String(formData.get("membershipId") ?? ""),
        );
        return accountMutationResponse(result, "/account/team", navigateAfterWrite(result, "/account/team"));
      },
      reinstate: async ({ request, formData }) => {
        const result = await createIdentityRequestApiClient(request).reinstateMembership<MutationResult>(
          String(formData.get("membershipId") ?? ""),
        );
        return accountMutationResponse(result, "/account/team", navigateAfterWrite(result, "/account/team"));
      },
      "cancel-invitation": async ({ request, formData }) => {
        const result = await createIdentityRequestApiClient(request).cancelInvitation<MutationResult>(
          String(formData.get("invitationId") ?? ""),
        );
        return accountMutationResponse(result, "/account/team", navigateAfterWrite(result, "/account/team"));
      },
    },
    onUnknownIntent: () => ({ outcome: "not-recorded", code: "interruption-safe-client-required" }),
  }),
);

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("identity.routes.marketplace.accountTeam.team.marketplace") });

export default function MarketplaceAccountTeamRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<AccountActionFailureResult>();
  return (
    <AccountMutationBoundary
      key={`${data.mutationActor.tenantId}:${data.mutationActor.userId}:${data.mutationActor.accountId}`}
      actor={data.mutationActor}
    >
      <TeamPage
        invitations={data.invitations}
        memberships={data.memberships}
        errorMessage={actionData?.failure?.message}
      />
    </AccountMutationBoundary>
  );
}
