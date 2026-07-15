import { t } from "@chase-sets/localization";
import { defineFormAction, defineResourceRoute, formActionRedirect } from "@chase-sets/platform-runtime/http";
import type { MetaFunction } from "react-router";
import { redirect } from "react-router";
import contextManifest from "../../context.json";
import type { Invitation } from "../../support/request-support/api-client";
import { identityApiErrorAdapter } from "../../support/request-support/route-api-error";
import { createIdentityRequestApiClient, requestWithoutFreshWrite } from "../../support/route-support/identity-request";

function invitationDestination(invitation: Invitation) {
  return `/access/accounts/${invitation.account_id}?tab=team&invitation=${encodeURIComponent(invitation.invitation_id)}`;
}

export const loader = defineResourceRoute({
  manifest: contextManifest,
  routeId: "invitations-detail",
  errorAdapter: identityApiErrorAdapter,
  load: ({ request, params }) => createIdentityRequestApiClient(request).getInvitation<Invitation>(params.id!),
  map: (invitation) => redirect(invitationDestination(invitation)),
  onPending: async (_result, { request, params }) => {
    const invitation = await createIdentityRequestApiClient(
      requestWithoutFreshWrite(request),
    ).getInvitation<Invitation>(params.id!);
    return redirect(invitationDestination(invitation));
  },
  onPermanentFailure: (response) => {
    if ("error" in response) {
      throw response.error;
    }
    throw new Response("Invitation is unavailable.", { status: 404 });
  },
});

const invitationDetailDestination = (id: string) => `/access/invitations/${id}`;

export const action = defineFormAction({
  intents: {
    resend: async ({ request, params, formData }) =>
      formActionRedirect(
        await createIdentityRequestApiClient(request).resendInvitation(
          params.id!,
          new Date(String(formData.get("expiresAt") ?? "")).toISOString(),
        ),
        invitationDetailDestination(params.id!),
      ),
    cancel: async ({ request, params }) =>
      formActionRedirect(
        await createIdentityRequestApiClient(request).cancelInvitation(params.id!),
        invitationDetailDestination(params.id!),
      ),
    decline: async ({ request, params }) =>
      formActionRedirect(
        await createIdentityRequestApiClient(request).declineInvitation(params.id!),
        invitationDetailDestination(params.id!),
      ),
  },
  onUnknownIntent: ({ params }) => formActionRedirect(null, invitationDetailDestination(params.id!)),
});

export const meta: MetaFunction = () => [
  { title: t("identity.routes.admin.invitationsDetail.invitation.detail.identity.admin") },
];

export default function InvitationDetailRoute() {
  return null;
}
