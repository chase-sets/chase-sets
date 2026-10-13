import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { useActionData, useLoaderData, useNavigation, useSubmit } from "react-router";
import { Container } from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import {
  InvitationAcceptancePage,
  type InvitationAcceptancePresentation,
} from "../../features/invitation-acceptance/ui/invitation-acceptance-page";
import type { InteractiveAuthResult } from "../../support/runtime-support/services";
import { createAuthRequestApiClient } from "../../support/request-support/api-client";
import { marketplaceAuthHost } from "../../support/route-support/auth-host.server";
import { toAuthActionError } from "../../support/route-support/auth-host";
import { invitationAttemptRollout } from "../../features/invitation-acceptance/api/rollout";
import { AuthApiError } from "../../client";
import type { InvitationAttemptResult } from "../../features/invitation-acceptance/api/journey";

export const meta: MetaFunction = () => buildOpenGraphMeta({ title: t("auth.routes.marketplace.invite.meta.title") });

export async function loader({ request, params }: LoaderFunctionArgs) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const invitationId = params.invitationId ?? "";
  const invitation = await createAuthRequestApiClient(request).inspectInvitation<InvitationAcceptancePresentation>({
    invitationId,
    token,
  });
  return { invitation, invitationId, token, attemptsActive: invitationAttemptRollout.active };
}

export async function action({ request, params }: ActionFunctionArgs) {
  let attemptId: string | null = null;
  let invitationId = params.invitationId ?? "";
  let token = "";
  try {
    const formData = await request.formData();
    invitationId ||= String(formData.get("invitationId") ?? "");
    token = String(formData.get("token") ?? "");
    attemptId = typeof formData.get("attemptId") === "string" ? String(formData.get("attemptId")) : null;
    const api = createAuthRequestApiClient(request);
    if (formData.get("intent") === "status" && attemptId) {
      const status = await api.getInvitationAcceptanceStatus<InvitationAttemptResult>({
        invitationId,
        token,
        attemptId,
      });
      return { state: status.type, attemptId };
    }
    const body: Record<string, unknown> = { invitationId, token };
    for (const field of [
      "attemptId",
      "password",
      "challengeId",
      "challenge",
      "externalCredentialId",
      "label",
      "webauthnResponse",
    ]) {
      const value = formData.get(field);
      if (typeof value === "string" && value) body[field] = value;
    }
    const result = await api.acceptInvitation<InteractiveAuthResult | InvitationAttemptResult>(body);
    if (result.type !== "session-started" && result.type !== "account-selection-required")
      return { state: result.type, attemptId };
    return marketplaceAuthHost.completeAuthentication(request, result, {
      defaultSuccessPath: "/account",
      freshWriteSource: result,
    });
  } catch (error) {
    if (attemptId) {
      if (error instanceof AuthApiError && error.status < 500)
        return { state: error.status === 409 ? ("conflict" as const) : ("failed-safe" as const), attemptId };
      try {
        const status = await createAuthRequestApiClient(request).getInvitationAcceptanceStatus<InvitationAttemptResult>(
          { invitationId, token, attemptId },
        );
        return { state: status.type, attemptId };
      } catch {
        return { state: "ambiguous" as const, attemptId };
      }
    }
    return toAuthActionError(error, "invitation-accept");
  }
}

export default function MarketplaceInviteRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  return (
    <Container width="narrow" paddingX={0}>
      <InvitationAcceptancePage
        invitation={data.invitation}
        token={data.token}
        errorMessage={actionData && "error" in actionData ? actionData.error : null}
        attemptsActive={data.attemptsActive}
        invitationId={data.invitationId}
        submit={(form) => {
          void submit(form, { method: "post" });
        }}
        attemptId={actionData && "attemptId" in actionData ? actionData.attemptId : null}
        phase={
          navigation.state === "submitting"
            ? "submitting"
            : navigation.state === "loading"
              ? "confirming"
              : actionData && "state" in actionData
                ? actionData.state
                : "editing"
        }
      />
    </Container>
  );
}
