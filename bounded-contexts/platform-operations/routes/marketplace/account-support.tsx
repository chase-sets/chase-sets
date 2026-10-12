import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData, useSearchParams } from "react-router";
import { useRef } from "react";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import type { SupportOrderLookup } from "../../features/support-requests/ui/contracts";
import { SupportRequestListPage } from "../../features/support-requests/ui/support-request-list-page";
import {
  createSupportRequestRequestApiClient,
  SupportEvidenceUploadError,
} from "../../support/request-support/support-request-api-client";
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
  await requireActorFromAuthApi({
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
    flows,
    buyerRequests,
    sellerRequests,
    lookupError,
    supportOrder,
    initialFlowType,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "support.manage",
  });
  const api = createSupportRequestRequestApiClient(request);
  let formData: FormData;
  try {
    formData = await readSupportAttachmentFormData(request);
  } catch {
    return { error: t("support.routes.marketplace.accountSupport.photos.intakeRejected") };
  }
  const affectedLineIds = formData.getAll("affectedLineIds").map(String);
  const files = formData.getAll("attachments").filter(isUploadedFile);
  const photoRequired = formValue(formData, "photoRequired") === "true";
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

  if (photoRequired && files.length === 0 && uploadedAttachmentReferences.length === 0) {
    return {
      error: t("support.routes.marketplace.accountSupport.photos.required"),
      ...recovery(),
    };
  }

  try {
    if (!supportRequestId) {
      const result = await api.openSupportRequest({
        orderId: formValue(formData, "orderId"),
        flowType: formValue(formData, "flowType"),
        ...(affectedLineIds.length > 0 ? { affectedLineIds } : {}),
      });
      supportRequestId = result.id;
    }
    if (files.length > 0 && uploadedAttachmentReferences.length === 0) {
      uploadUncertain = true;
      const uploaded = await api.uploadSupportEvidenceAttachments(supportRequestId, files, attachmentOperationId);
      uploadUncertain = false;
      uploadedAttachmentReferences = uploaded.attachments.map((attachment) => attachment.reference);
    }
    if (uploadedAttachmentReferences.length > 0) {
      await api.submitSupportEvidence(supportRequestId, {
        submittedByRole: "buyer",
        evidenceType: "photo",
        summary: t("support.routes.marketplace.accountSupport.photos.summary"),
        attachments: uploadedAttachmentReferences,
      });
    }
    return redirect(`/account/support?opened=${encodeURIComponent(supportRequestId)}`);
  } catch (error) {
    if (error instanceof SupportEvidenceUploadError && error.status >= 400 && error.status < 500)
      uploadUncertain = false;
    return {
      error: error instanceof Error ? error.message : t("support.routes.marketplace.accountSupport.open.failed"),
      ...recovery(),
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
  const [searchParams] = useSearchParams();
  const openedSupportRequestId = searchParams.get("opened");

  return (
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
  );
}
