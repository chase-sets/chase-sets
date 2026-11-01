import { t } from "@chase-sets/localization";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { defineFormAction, navigateAfterWrite, type FormActionContext } from "@chase-sets/platform-runtime/http";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData, useSearchParams } from "react-router";
import {
  SupportRequestDetailPage,
  type SupportParticipantRole,
} from "../../features/support-requests/ui/support-request-detail-page";
import {
  createSupportRequestRequestApiClient,
  SupportParticipantSendError,
} from "../../support/request-support/support-request-api-client";
import { participantActorMatches, readParticipantRecovery } from "../../support/request-support/participant-recovery";
import { ParticipantRoute, type ParticipantRouteRecovery } from "../../features/support-requests/ui/participant-form";
import { supportRequestParticipantDetail } from "../../support/request-support/support-request-detail-route-adapter";

function formValue(formData: FormData, key: string) {
  return String(formData.get(key) ?? "");
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const actor = await requireActorFromAuthApi({ request, permission: "support.view" });
  const supportRequestId = params.id ?? "";
  const supportRequest = await createSupportRequestRequestApiClient(request).getSupportRequest(supportRequestId);
  const participantDetail = supportRequestParticipantDetail(supportRequest, actor.accountId);
  if (!participantDetail) throw new Response("Not found.", { status: 404 });

  return {
    accountId: actor.accountId,
    tenantId: actor.tenantId,
    request: supportRequest,
    ...participantDetail,
    now: new Date().toISOString(),
  };
}

function detailLocation(supportRequestId: string, key: "action" | "actionError", value: string) {
  const search = new URLSearchParams({ [key]: value });
  return `/account/support/${encodeURIComponent(supportRequestId)}?${search}`;
}

type ParticipantActionKind = "evidence" | "response" | "accept-offer" | "decline-offer" | "escalate" | "cancel";

async function handleParticipantAction(
  actionKind: ParticipantActionKind,
  { request, params, formData }: FormActionContext,
  actor: Readonly<{ accountId: string; tenantId: string }>,
) {
  const supportRequestId = params.id ?? "";
  const api = createSupportRequestRequestApiClient(
    request,
    formValue(formData, "participantAttemptId") || crypto.randomUUID(),
  );

  try {
    let actionResult: string;
    let commandResult: unknown;
    switch (actionKind) {
      case "evidence":
        commandResult = await api.submitSupportEvidence(supportRequestId, {
          submittedByRole: formValue(formData, "submittedByRole"),
          evidenceType: formValue(formData, "evidenceType"),
          summary: formValue(formData, "summary"),
        });
        actionResult = "evidence";
        break;
      case "response": {
        const refundAmount = formValue(formData, "refundAmount");
        commandResult = await api.recordSupportResponse(supportRequestId, {
          submittedByRole: formValue(formData, "submittedByRole"),
          responseType: formValue(formData, "responseType"),
          summary: formValue(formData, "summary"),
          ...(refundAmount ? { refundAmount } : {}),
        });
        actionResult = "response";
        break;
      }
      case "accept-offer":
        commandResult = await api.acceptSupportOffer(supportRequestId, formValue(formData, "offerId"));
        actionResult = "offerAccepted";
        break;
      case "decline-offer":
        commandResult = await api.declineSupportOffer(supportRequestId, formValue(formData, "offerId"), {
          summary: formValue(formData, "summary"),
        });
        actionResult = "offerDeclined";
        break;
      case "escalate":
        commandResult = await api.requestSupportReview(supportRequestId, { reason: formValue(formData, "reason") });
        actionResult = "escalated";
        break;
      case "cancel":
        commandResult = await api.cancelSupportRequest(supportRequestId, { reason: formValue(formData, "reason") });
        actionResult = "cancelled";
        break;
    }

    return redirect(navigateAfterWrite(commandResult, detailLocation(supportRequestId, "action", actionResult)));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : t("support.routes.marketplace.accountSupportDetail.action.failed");
    const participantRecovery: ParticipantRouteRecovery = {
      accountId: actor.accountId,
      tenantId: actor.tenantId,
      phase: error instanceof SupportParticipantSendError ? error.phase : "failed-safe",
      descriptor: error instanceof SupportParticipantSendError ? error.descriptor : null,
    };
    return { error: participantRecovery.phase === "ambiguous" ? null : message, participantRecovery };
  }
}

async function handleParticipantIntent(actionKind: ParticipantActionKind | "check-status", args: FormActionContext) {
  const actor = args.actor;
  if (!actor) throw new Response(null, { status: 401 });
  const formData = args.formData;
  if (!participantActorMatches(formData, actor))
    return { error: t("support.participantAttempt.accountChanged"), participantRecovery: null };
  let retainedRecovery: ParticipantRouteRecovery | null = null;
  try {
    const recovery = readParticipantRecovery(formData, actor);
    retainedRecovery = recovery;
    if (recovery?.descriptor) {
      if (recovery.descriptor.targetId !== args.params.id) throw new Error("Support recovery target changed");
      const lookup = await createSupportRequestRequestApiClient(args.request).lookupParticipantAttempt(
        recovery.descriptor,
      );
      if (lookup.outcome === "committed" || lookup.outcome === "confirming")
        return redirect(
          navigateAfterWrite(
            lookup.result,
            detailLocation(
              args.params.id ?? "",
              "action",
              {
                "submit-evidence": "evidence",
                "record-response": "response",
                "accept-offer": "offerAccepted",
                "decline-offer": "offerDeclined",
                escalate: "escalated",
                cancel: "cancelled",
                close: "closed",
                "return-condition-dispute": "return-condition-disputed",
                "open-support-request": "opened",
              }[lookup.actionKind],
            ),
          ),
        );
      return { error: null, participantRecovery: recovery };
    }
  } catch {
    return {
      error: t("support.participantAttempt.statusUnavailable"),
      participantRecovery: retainedRecovery,
    };
  }
  if (actionKind === "check-status") return unsupportedParticipantIntent(args);
  return handleParticipantAction(actionKind, args, actor);
}

function unsupportedParticipantIntent({ params }: FormActionContext) {
  return redirect(
    detailLocation(
      params.id ?? "",
      "actionError",
      t("support.routes.marketplace.accountSupportDetail.action.unsupported"),
    ),
  );
}

export const action = defineFormAction({
  authorization: ({ request }) => requireActorFromAuthApi({ request, permission: "support.manage" }),
  intents: {
    evidence: (context) => handleParticipantIntent("evidence", context),
    response: (context) => handleParticipantIntent("response", context),
    "accept-offer": (context) => handleParticipantIntent("accept-offer", context),
    "decline-offer": (context) => handleParticipantIntent("decline-offer", context),
    escalate: (context) => handleParticipantIntent("escalate", context),
    cancel: (context) => handleParticipantIntent("cancel", context),
    "check-status": (context) => handleParticipantIntent("check-status", context),
  },
  onUnknownIntent: unsupportedParticipantIntent,
});

export const meta: MetaFunction<typeof loader> = ({ data }) =>
  buildOpenGraphMeta({
    title: data?.request.display_reference
      ? t("support.routes.marketplace.accountSupportDetail.meta.title", {
          reference: data.request.display_reference,
        })
      : t("support.routes.marketplace.accountSupportDetail.meta.fallbackTitle"),
  });

export default function AccountSupportDetailRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [searchParams] = useSearchParams();
  return (
    <ParticipantRoute
      key={`${data.tenantId}/${data.accountId}/${data.request.support_request_id}`}
      accountId={data.accountId}
      tenantId={data.tenantId}
      recovery={actionData && "participantRecovery" in actionData ? actionData.participantRecovery : null}
    >
      <SupportRequestDetailPage
        request={data.request}
        flow={data.flow}
        viewerRole={data.viewerRole as SupportParticipantRole}
        participantPolicy={data.participantPolicy}
        now={data.now}
        actionError={actionData && "error" in actionData ? actionData.error : searchParams.get("actionError")}
        actionResult={searchParams.get("action")}
      />
    </ParticipantRoute>
  );
}
