import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData, useSearchParams } from "react-router";
import { useRef } from "react";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { navigateAfterWrite } from "@chase-sets/platform-runtime/http";
import type { SupportOrderLookup } from "../../features/support-requests/ui/contracts";
import { SupportRequestListPage } from "../../features/support-requests/ui/support-request-list-page";
import {
  createSupportRequestRequestApiClient,
  SupportEvidenceUploadError,
  SupportParticipantSendError,
} from "../../support/request-support/support-request-api-client";
import { ParticipantRoute, type ParticipantRouteRecovery } from "../../features/support-requests/ui/participant-form";
import { participantActorMatches, readParticipantRecovery } from "../../support/request-support/participant-recovery";
import {
  readSupportAttachmentFormData,
  validateSupportAttachmentOperationId,
} from "../../features/support-requests/api/attachment-intake";

function formValue(formData: FormData, key: string) {
  return String(formData.get(key) ?? "");
}

function isUploadedFile(value: FormDataEntryValue): value is File {
  return typeof value !== "string" && typeof value.arrayBuffer === "function";
}

export async function loader({ request }: LoaderFunctionArgs) {
  const actor = await requireActorFromAuthApi({
    request,
    permission: "support.view",
  });
  const api = createSupportRequestRequestApiClient(request);
  const searchParams = new URL(request.url).searchParams;
  const orderId = searchParams.get("orderId");
  const initialFlowType = searchParams.get("flow");
  const [flows, buyerRequests, sellerRequests] = await Promise.all([
    api.listFlows(),
    api.listBuyerSupportRequests(),
    api.listSellerSupportRequests(),
  ]);
  let supportOrder: SupportOrderLookup | null = null;
  let lookupError: string | null = null;

  if (orderId) {
    try {
      supportOrder = await api.getSupportOrderContext(orderId);
    } catch (error) {
      lookupError =
        error instanceof Error ? error.message : t("support.routes.marketplace.accountSupport.lookup.failed");
    }
  }

  return {
    accountId: actor.accountId,
    tenantId: actor.tenantId,
    flows,
    buyerRequests,
    sellerRequests,
    lookupError,
    supportOrder,
    initialFlowType,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const actor = await requireActorFromAuthApi({
    request,
    permission: "support.manage",
  });
  let formData: FormData;
  try {
    formData = await readSupportAttachmentFormData(request);
  } catch {
    return { error: t("support.routes.marketplace.accountSupport.photos.intakeRejected") };
  }
  const attemptId = formValue(formData, "participantAttemptId") || crypto.randomUUID();
  const api = createSupportRequestRequestApiClient(request, attemptId);
  if (!participantActorMatches(formData, actor)) return { error: t("support.participantAttempt.accountChanged") };
  let participantRecovery: ParticipantRouteRecovery | null = null;
  try {
    participantRecovery = readParticipantRecovery(formData, actor);
    if (participantRecovery?.descriptor) {
      const lookup = await api.lookupParticipantAttempt(participantRecovery.descriptor);
      if (lookup.outcome === "committed" || lookup.outcome === "confirming")
        return redirect(navigateAfterWrite(lookup.result, `/account/support/${encodeURIComponent(lookup.result.id)}`));
      return { error: null, participantRecovery };
    }
  } catch {
    return { error: t("support.participantAttempt.statusUnavailable"), participantRecovery };
  }
  const affectedLineIds = formData.getAll("affectedLineIds").map(String);
  const files = formData.getAll("attachments").filter(isUploadedFile);
  let supportRequestId = formValue(formData, "supportRequestId");
  let uploadedAttachmentReferences = formData.getAll("uploadedAttachmentReferences").map(String);
  const attachmentOperationId = formValue(formData, "attachmentOperationId");
  let uploadUncertain = formValue(formData, "uploadUncertain") === "true";
  const recovery = () => ({
    recoverySupportRequestId: supportRequestId || null,
    uploadedAttachmentReferences,
    attachmentOperationId,
    uploadUncertain,
  });

  if (files.length > 0 || uploadedAttachmentReferences.length > 0 || uploadUncertain) {
    try {
      validateSupportAttachmentOperationId(attachmentOperationId);
    } catch {
      return { error: t("support.routes.marketplace.accountSupport.photos.operationRequired"), ...recovery() };
    }
  }

  if (uploadUncertain && uploadedAttachmentReferences.length === 0)
    return { error: t("support.routes.marketplace.accountSupport.photos.uncertain"), ...recovery() };

  try {
    const open = {
      orderId: formValue(formData, "orderId"),
      flowType: formValue(formData, "flowType"),
      ...(affectedLineIds.length ? { affectedLineIds } : {}),
    };
    if (files.length > 0 && uploadedAttachmentReferences.length === 0) {
      uploadUncertain = true;
      const uploaded = await api.stageParticipantIntakeAttachments(
        { ...open, attemptId },
        files,
        attachmentOperationId,
      );
      uploadUncertain = false;
      uploadedAttachmentReferences = uploaded.attachments.map((attachment) => attachment.reference);
    }
    const commandResult = await api.openSupportRequest({
      ...open,
      intakePhotoReferences: uploadedAttachmentReferences,
      ...(uploadedAttachmentReferences.length ? { attachmentOperationId } : {}),
    });
    supportRequestId = commandResult.id;
    return redirect(navigateAfterWrite(commandResult, `/account/support/${encodeURIComponent(supportRequestId)}`));
  } catch (error) {
    if (error instanceof SupportEvidenceUploadError && error.status >= 400 && error.status < 500)
      uploadUncertain = false;
    return {
      error: error instanceof Error ? error.message : t("support.routes.marketplace.accountSupport.open.failed"),
      ...recovery(),
      participantRecovery:
        error instanceof SupportParticipantSendError
          ? ({
              accountId: actor.accountId,
              tenantId: actor.tenantId,
              phase: error.phase,
              descriptor: error.descriptor,
            } satisfies ParticipantRouteRecovery)
          : null,
    };
  }
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("support.routes.marketplace.accountSupport.support.marketplace") });

export default function MarketplaceAccountSupportRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  type RecoveryData = Extract<NonNullable<typeof actionData>, { attachmentOperationId: string }>;
  const orderId = data.supportOrder?.orderId ?? null;
  const lastRecovery = useRef<{ orderId: string | null; data: RecoveryData | null }>({ orderId, data: null });
  if (lastRecovery.current.orderId !== orderId) lastRecovery.current = { orderId, data: null };
  if (actionData && "attachmentOperationId" in actionData) lastRecovery.current.data = actionData;
  const recoveryData = lastRecovery.current.data;
  const participantRecovery =
    actionData && "participantRecovery" in actionData ? (actionData.participantRecovery ?? null) : null;
  const [searchParams] = useSearchParams();
  const openedSupportRequestId = searchParams.get("opened");

  return (
    <ParticipantRoute
      key={`${data.tenantId}/${data.accountId}/${orderId}`}
      accountId={data.accountId}
      tenantId={data.tenantId}
      recovery={participantRecovery}
    >
      <SupportRequestListPage
        flows={data.flows.items}
        buyerRequests={data.buyerRequests.items}
        sellerRequests={data.sellerRequests.items}
        actionError={actionData?.error ?? null}
        lookupError={data.lookupError}
        openedSupportRequestId={openedSupportRequestId}
        supportOrder={data.supportOrder}
        initialFlowType={data.initialFlowType}
        recoverySupportRequestId={recoveryData?.recoverySupportRequestId ?? null}
        uploadedAttachmentReferences={recoveryData?.uploadedAttachmentReferences ?? []}
        attachmentOperationId={recoveryData?.attachmentOperationId}
        uploadUncertain={recoveryData?.uploadUncertain}
      />
    </ParticipantRoute>
  );
}
