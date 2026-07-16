import { t } from "@chase-sets/localization";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { defineFormAction, navigateAfterWrite, type FormActionContext } from "@chase-sets/platform-runtime/http";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData, useSearchParams } from "react-router";
import {
  SupportRequestDetailPage,
  type SupportParticipantRole,
} from "../../features/support-requests/ui/support-request-detail-page";
import { createSupportRequestRequestApiClient } from "../../support/request-support/support-request-api-client";
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
) {
  const supportRequestId = params.id ?? "";
  const api = createSupportRequestRequestApiClient(request);

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
        const offerResolutionType = formValue(formData, "offerResolutionType");
        const refundAmount = formValue(formData, "refundAmount");
        commandResult = await api.recordSupportResponse(supportRequestId, {
          submittedByRole: formValue(formData, "submittedByRole"),
          responseType: formValue(formData, "responseType"),
          summary: formValue(formData, "summary"),
          ...(offerResolutionType ? { offerResolutionType } : {}),
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
    return redirect(detailLocation(supportRequestId, "actionError", message));
  }
}

export const action = defineFormAction({
  authorization: ({ request }) => requireActorFromAuthApi({ request, permission: "support.manage" }),
  intents: {
    evidence: (context) => handleParticipantAction("evidence", context),
    response: (context) => handleParticipantAction("response", context),
    "accept-offer": (context) => handleParticipantAction("accept-offer", context),
    "decline-offer": (context) => handleParticipantAction("decline-offer", context),
    escalate: (context) => handleParticipantAction("escalate", context),
    cancel: (context) => handleParticipantAction("cancel", context),
  },
  onUnknownIntent: ({ params }) =>
    redirect(
      detailLocation(
        params.id ?? "",
        "actionError",
        t("support.routes.marketplace.accountSupportDetail.action.unsupported"),
      ),
    ),
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
  const [searchParams] = useSearchParams();
  return (
    <SupportRequestDetailPage
      request={data.request}
      flow={data.flow}
      viewerRole={data.viewerRole as SupportParticipantRole}
      canCancel={data.canCancel}
      now={data.now}
      actionError={searchParams.get("actionError")}
      actionResult={searchParams.get("action")}
    />
  );
}
