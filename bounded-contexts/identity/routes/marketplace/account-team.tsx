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
import { createId, parseTypedId } from "@chase-sets/primitives/typed-ids";
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

const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Asks Auth to email an invitation this write newly recorded. A link that cannot be asked for leaves
 * the invitation saved, and the page it returns to says so, so the owner can send it again. A
 * replayed write already had its one chance and is never emailed again.
 */
async function teamDestination(request: Request, result: MutationResult): Promise<string> {
  if (result.outcome !== "committed" || !result.newlyCommitted) return "/account/team";
  const invitationId = result.receipt.result.id;
  const emailed = await requestInvitationAcceptanceLink(request, invitationId, result).then(
    () => true,
    () => false,
  );
  return emailed ? "/account/team" : `/account/team?${new URLSearchParams({ unsent: invitationId })}`;
}

function invitationResponse(result: MutationResult, destination: string) {
  return accountMutationResponse(
    result.outcome === "committed" ? { ...result, delivery: "unknown" } : result,
    destination,
    navigateAfterWrite(result, destination),
  );
}

function unsentInvitationId(request: Request): string | null {
  const unsent = new URL(request.url).searchParams.get("unsent");
  if (!unsent || unsent.length > 100) return null;
  try {
    return parseTypedId(unsent, "ivt");
  } catch {
    return null;
  }
}

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
    unsentInvitationId: unsentInvitationId(request),
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
          expiresAt: new Date(Date.now() + INVITATION_LIFETIME_MS).toISOString(),
        });
        if (result.outcome === "committed" && result.newlyCommitted) actionErrors.markCommitted(context);
        return invitationResponse(result, await teamDestination(request, result));
      },
      "resend-invitation": async (context) => {
        const { request, formData } = context;
        const result = await createIdentityRequestApiClient(request).resendInvitation<MutationResult>(
          String(formData.get("invitationId") ?? ""),
          new Date(Date.now() + INVITATION_LIFETIME_MS).toISOString(),
        );
        if (result.outcome === "committed" && result.newlyCommitted) actionErrors.markCommitted(context);
        return invitationResponse(result, await teamDestination(request, result));
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
        unsentInvitationId={data.unsentInvitationId}
      />
    </AccountMutationBoundary>
  );
}
