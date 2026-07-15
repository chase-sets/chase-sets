import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect } from "react-router";
import { loadAfterWrite, navigateAfterWrite } from "@chase-sets/platform-runtime/http";
import type { Invitation } from "../../support/request-support/api-client";
import { createIdentityRequestApiClient, requestWithoutFreshWrite } from "../../support/route-support/identity-request";
import { IdentityApiError } from "../../support/request-support/api-client";

function identityApiErrorStatus(error: unknown) {
  return error instanceof IdentityApiError ? error.status : null;
}

function identityApiErrorBody(error: unknown) {
  return error instanceof IdentityApiError ? error.body : null;
}

function identityApiErrorCode(error: unknown) {
  const body = identityApiErrorBody(error);
  const apiError = typeof body === "object" && body !== null && "error" in body ? body.error : null;
  const code = typeof apiError === "object" && apiError !== null ? (apiError as { code?: unknown }).code : null;
  return typeof code === "string" && code.trim() ? code : null;
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createIdentityRequestApiClient(request);
  const invitationId = params.id!;
  const response = await loadAfterWrite({
    request,
    load: () => api.getInvitation<Invitation>(invitationId),
    isNotFound: (error) => identityApiErrorStatus(error) === 404,
    getStatus: identityApiErrorStatus,
    getErrorCode: identityApiErrorCode,
    getBody: identityApiErrorBody,
  });

  if (response.kind === "pending") {
    const recoveryApi = createIdentityRequestApiClient(requestWithoutFreshWrite(request));
    const invitation = await recoveryApi.getInvitation<Invitation>(invitationId);
    return redirect(
      `/access/accounts/${invitation.account_id}?tab=team&invitation=${encodeURIComponent(invitationId)}`,
    );
  }

  if (response.kind === "permanent-failure") {
    if ("error" in response) {
      throw response.error;
    }
    throw new Response("Invitation is unavailable.", { status: 404 });
  }

  return redirect(
    `/access/accounts/${response.data.account_id}?tab=team&invitation=${encodeURIComponent(invitationId)}`,
  );
}

export async function action({ request, params }: ActionFunctionArgs) {
  const api = createIdentityRequestApiClient(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const invitationId = params.id!;
  let result: unknown = null;

  if (intent === "resend") {
    result = await api.resendInvitation(invitationId, new Date(String(formData.get("expiresAt") ?? "")).toISOString());
  }

  if (intent === "cancel") {
    result = await api.cancelInvitation(invitationId);
  }

  if (intent === "decline") {
    result = await api.declineInvitation(invitationId);
  }

  return redirect(navigateAfterWrite(result, `/access/invitations/${invitationId}`));
}

export const meta: MetaFunction = () => [
  { title: t("identity.routes.admin.invitationsDetail.invitation.detail.identity.admin") },
];

export default function InvitationDetailRoute() {
  return null;
}
