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
import type { InvitationAttemptResult } from "../../features/invitation-acceptance/api/result";
import { useAuthFormActionData } from "../../support/ui-support/auth-form-feedback";

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
      const code =
        error instanceof AuthApiError &&
        error.body &&
        typeof error.body === "object" &&
        "error" in error.body &&
        error.body.error &&
        typeof error.body.error === "object" &&
        "code" in error.body.error
          ? error.body.error.code
          : null;
      if (error instanceof AuthApiError && error.status < 500 && code !== "invitation_attempt_ambiguous")
        return {
          state:
            code === "invitation_attempt_conflict"
              ? ("conflict" as const)
              : error.status === 403
                ? ("route-denied" as const)
                : ("failed-safe" as const),
          attemptId,
        };
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
  const actionData = useAuthFormActionData(useActionData<typeof action>());
  const navigation = useNavigation();
  const submit = useSubmit();
  return (
    <Container width="narrow" paddingX={0}>
      <InvitationAcceptancePage
        key={data.invitationId}
        invitation={data.invitation}
        token={data.token}
        actionError={actionData && "error" in actionData ? actionData : null}
        submissionPending={navigation.state !== "idle" && navigation.formMethod?.toLowerCase() === "post"}
        attemptsActive={data.attemptsActive}
        invitationId={data.invitationId}
        submit={(form) => {
          const formData = new FormData(form);
          formData.set("token", data.token);
          void submit(formData, { method: "post" });
        }}
        attemptId={actionData && "attemptId" in actionData ? actionData.attemptId : null}
        phase={
          data.attemptsActive && navigation.state === "submitting"
            ? "submitting"
            : data.attemptsActive && navigation.state === "loading"
              ? "confirming"
              : actionData && "state" in actionData
                ? actionData.state
                : "editing"
        }
      />
    </Container>
  );
}
