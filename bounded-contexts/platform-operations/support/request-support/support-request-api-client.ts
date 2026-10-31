import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
import { attachResponseMetadata } from "@chase-sets/http/responses";
import { t } from "@chase-sets/localization";
import { SupportDomainError } from "../../features/support-requests/domain/common";
import {
  hashParticipantRequest,
  parseParticipantAttempt,
  parseParticipantLookup,
  participantActions,
  type ParticipantAction,
  type SupportParticipantDescriptor,
} from "../../features/support-requests/domain/participant-attempt";

export type { SupportParticipantDescriptor } from "../../features/support-requests/domain/participant-attempt";
export class SupportParticipantSendError extends Error {
  constructor(
    public readonly phase: "failed-safe" | "ambiguous",
    public readonly descriptor: SupportParticipantDescriptor | null,
    message?: string,
  ) {
    super(
      message ??
        (phase === "ambiguous"
          ? "Check status before retrying this support action."
          : "This support action was not sent."),
    );
  }
}
import {
  SUPPORT_ATTACHMENT_OPERATION_HEADER,
  validateSupportAttachmentOperationId,
} from "../../features/support-requests/api/attachment-intake";

export class SupportEvidenceUploadError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}
import type {
  CustomerSupportRequestListItem,
  SupportFlowSummary,
  PlatformRemedyProposalPreview,
  SupportOrderLookup,
  SupportRequestCommandSnapshot,
  SupportRequestDetail,
  SupportRequestDetailResponse,
  SupportRequestEscalationSnapshot,
  SupportRequestListItem,
  SupportRequestParticipantDetailResponse,
  SupportOperationsRequestDetailResponse,
  SupportOperationsRequestListItem,
} from "../../features/support-requests/ui/contracts";

export type {
  SupportFlowSummary,
  SupportOrderLookup,
  SupportRequestCommandSnapshot,
  SupportRequestDetail,
  SupportRequestDetailResponse,
  SupportRequestEscalationSnapshot,
  SupportRequestListItem,
  SupportRequestParticipantDetailResponse,
  SupportOperationsRequestDetailResponse,
  SupportOperationsRequestListItem,
} from "../../features/support-requests/ui/contracts";

type SupportRequestApiClientOptions = Readonly<{
  participantAttemptId?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  headers?: HeadersInit | (() => HeadersInit);
}>;

function resolveHeaders(headers?: HeadersInit | (() => HeadersInit)) {
  return typeof headers === "function" ? headers() : headers;
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `API error ${response.status}`);
  }

  return attachResponseMetadata(await response.json(), response) as T;
}

export function createSupportRequestApiClient(options: SupportRequestApiClientOptions = {}) {
  const clientFetch = options.fetch ?? fetch;
  const baseUrl = options.baseUrl ?? "/api/marketplace";

  async function lookupParticipantAttempt(descriptor: SupportParticipantDescriptor) {
    parseParticipantAttempt({ attemptId: descriptor.attemptId, requestHash: descriptor.requestHash });
    const query = new URLSearchParams({ requestHash: descriptor.requestHash });
    if (descriptor.actionKind !== "open-support-request") query.set("actionKind", descriptor.actionKind);
    const path =
      descriptor.actionKind === "open-support-request" ? "" : `/${encodeURIComponent(descriptor.targetId ?? "")}`;
    const response = await clientFetch(
      `${baseUrl}/support-requests${path}/participant-attempts/${encodeURIComponent(descriptor.attemptId)}?${query}`,
      {
        headers: resolveHeaders(options.headers),
      },
    );
    if (!response.ok) throw new SupportParticipantSendError("ambiguous", descriptor);
    const lookup = parseParticipantLookup(await response.json());
    if (lookup.outcome === "committed" || lookup.outcome === "confirming") {
      if (
        lookup.actionKind !== descriptor.actionKind ||
        (descriptor.targetId !== null && lookup.result.id !== descriptor.targetId)
      )
        throw new SupportParticipantSendError("ambiguous", descriptor);
      attachResponseMetadata(lookup.result, response);
    }
    return lookup;
  }
  async function participantCommand(
    actionKind: ParticipantAction,
    body: unknown,
    attemptId: string,
    targetId: string | null = null,
    offerId: string | null = null,
  ): Promise<SupportRequestCommandSnapshot> {
    let descriptor: SupportParticipantDescriptor;
    let hashBody = body;
    try {
      if (typeof navigator !== "undefined" && navigator.onLine === false) throw new Error("offline");
      if (actionKind === "accept-offer" || actionKind === "decline-offer") hashBody = { ...(body as object), offerId };
      descriptor = { actionKind, targetId, attemptId, requestHash: await hashParticipantRequest(actionKind, hashBody) };
      parseParticipantAttempt({ attemptId, requestHash: descriptor.requestHash });
    } catch (error) {
      if (error instanceof SupportDomainError && error.message === "attachment_reference_unknown")
        throw new SupportParticipantSendError(
          "failed-safe",
          null,
          t("support.features.support_requests.api.route.attachment.reference.unknown"),
        );
      throw new SupportParticipantSendError("failed-safe", null);
    }
    const path = participantActions[actionKind].path
      .replace(":id", encodeURIComponent(targetId ?? ""))
      .replace(":offerId", encodeURIComponent(offerId ?? ""));
    try {
      const headers = new Headers(resolveHeaders(options.headers));
      headers.set("content-type", "application/json");
      headers.set("Idempotency-Key", attemptId);
      headers.set("X-Support-Request-Hash", descriptor.requestHash);
      const response = await clientFetch(`${baseUrl}/support-requests${path === "/" ? "" : path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if ([400, 401, 403].includes(response.status)) {
        const rejection = await response.json().catch(() => null);
        throw new SupportParticipantSendError(
          "failed-safe",
          null,
          rejection?.error?.code === "attachment_reference_unknown"
            ? t("support.features.support_requests.api.route.attachment.reference.unknown")
            : actionKind === "open-support-request" &&
                response.status === 400 &&
                rejection?.error?.message === t("support.routes.marketplace.accountSupport.photos.required")
              ? t("support.routes.marketplace.accountSupport.photos.required")
              : undefined,
        );
      }
      return await parseJsonResponse<SupportRequestCommandSnapshot>(response);
    } catch (error) {
      if (error instanceof SupportParticipantSendError && error.phase === "failed-safe") throw error;
      // A read can prove commitment. Absence is never permission for a second write.
      try {
        const lookup = await lookupParticipantAttempt(descriptor);
        if (lookup.outcome === "committed" || lookup.outcome === "confirming") return lookup.result;
      } catch {
        /* retain the single inert descriptor */
      }
      throw new SupportParticipantSendError("ambiguous", descriptor);
    }
  }

  return {
    participantCommand,
    lookupParticipantAttempt,
    listFlows: async () =>
      parseJsonResponse<{ items: readonly SupportFlowSummary[] }>(
        await clientFetch(`${baseUrl}/support-requests/flows`, {
          headers: resolveHeaders(options.headers),
        }),
      ),
    listBuyerSupportRequests: async () =>
      parseJsonResponse<{
        items: readonly CustomerSupportRequestListItem[];
        total: number;
        count: number;
      }>(
        await clientFetch(`${baseUrl}/support-requests/purchases`, {
          headers: resolveHeaders(options.headers),
        }),
      ),
    listSellerSupportRequests: async () =>
      parseJsonResponse<{
        items: readonly CustomerSupportRequestListItem[];
        total: number;
        count: number;
      }>(
        await clientFetch(`${baseUrl}/support-requests/sales`, {
          headers: resolveHeaders(options.headers),
        }),
      ),
    getSupportOrderContext: async (orderId: string) =>
      parseJsonResponse<SupportOrderLookup>(
        await clientFetch(`${baseUrl}/support-requests/orders/${encodeURIComponent(orderId)}`, {
          headers: resolveHeaders(options.headers),
        }),
      ),
    listSupportOperationsQueue: async (query = "") =>
      parseJsonResponse<{ items: readonly SupportOperationsRequestListItem[]; total: number; count: number }>(
        await clientFetch(`${baseUrl}/support-requests/ops${query ? `?${query}` : ""}`, {
          headers: resolveHeaders(options.headers),
        }),
      ),
    getSupportRequest: async (supportRequestId: string) =>
      parseJsonResponse<SupportRequestParticipantDetailResponse>(
        await clientFetch(`${baseUrl}/support-requests/${encodeURIComponent(supportRequestId)}`, {
          headers: resolveHeaders(options.headers),
        }),
      ),
    getSupportOperationsRequest: async (supportRequestId: string) =>
      parseJsonResponse<SupportOperationsRequestDetailResponse>(
        await clientFetch(`${baseUrl}/support-requests/ops/${supportRequestId}`, {
          headers: resolveHeaders(options.headers),
        }),
      ),
    openSupportRequest: async (
      body: Readonly<{
        orderId: string;
        flowType: string;
        affectedLineIds?: readonly string[];
        intakePhotoReferences?: readonly string[];
        attachmentOperationId?: string;
      }>,
    ) => participantCommand("open-support-request", body, options.participantAttemptId ?? crypto.randomUUID()),
    stageParticipantIntakeAttachments: async (
      body: Readonly<{ attemptId: string; orderId: string; flowType: string; affectedLineIds?: readonly string[] }>,
      files: readonly File[],
      operationId: string,
    ) => {
      validateSupportAttachmentOperationId(operationId);
      const formData = new FormData();
      formData.set("attemptId", body.attemptId);
      formData.set("orderId", body.orderId);
      formData.set("flowType", body.flowType);
      body.affectedLineIds?.forEach((id) => formData.append("affectedLineIds", id));
      files.forEach((file) => formData.append("attachments", file));
      const headers = new Headers(resolveHeaders(options.headers));
      headers.set(SUPPORT_ATTACHMENT_OPERATION_HEADER, operationId);
      const response = await clientFetch(
        `${baseUrl}/support-requests/participant-attempts/${encodeURIComponent(body.attemptId)}/attachments`,
        { method: "POST", headers, body: formData },
      );
      if (!response.ok) {
        const error = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new SupportEvidenceUploadError(error?.error?.message ?? `API error ${response.status}`, response.status);
      }
      return parseJsonResponse<{ attachments: readonly Readonly<{ reference: string }>[] }>(response);
    },
    uploadSupportEvidenceAttachments: async (supportRequestId: string, files: readonly File[], operationId: string) => {
      validateSupportAttachmentOperationId(operationId);
      const formData = new FormData();
      files.forEach((file) => formData.append("attachments", file));
      const headers = new Headers(resolveHeaders(options.headers));
      headers.set(SUPPORT_ATTACHMENT_OPERATION_HEADER, operationId);
      const response = await clientFetch(`${baseUrl}/support-requests/${supportRequestId}/attachments`, {
        method: "POST",
        headers,
        body: formData,
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new SupportEvidenceUploadError(body?.error?.message ?? `API error ${response.status}`, response.status);
      }
      return parseJsonResponse<{
        attachments: readonly Readonly<{
          attachmentId: string;
          reference: string;
          contentType: string;
          byteSize: number;
        }>[];
      }>(response);
    },
    submitSupportEvidence: async (
      supportRequestId: string,
      body: Readonly<{
        submittedByRole: string;
        evidenceType: string;
        summary: string;
        occurredAt?: string | null;
        attachments?: readonly string[];
        attachmentOperationId?: string;
      }>,
    ) =>
      participantCommand(
        "submit-evidence",
        body,
        options.participantAttemptId ?? crypto.randomUUID(),
        supportRequestId,
      ),
    recordSupportResponse: async (
      supportRequestId: string,
      body: Readonly<{
        submittedByRole: string;
        responseType: string;
        summary: string;
        offerResolutionType?: string | null;
        refundAmount?: string | null;
      }>,
    ) =>
      participantCommand(
        "record-response",
        body,
        options.participantAttemptId ?? crypto.randomUUID(),
        supportRequestId,
      ),
    acceptSupportOffer: async (supportRequestId: string, offerId: string) =>
      participantCommand(
        "accept-offer",
        {},
        options.participantAttemptId ?? crypto.randomUUID(),
        supportRequestId,
        offerId,
      ),
    declineSupportOffer: async (
      supportRequestId: string,
      offerId: string,
      body: Readonly<{ summary?: string | null }> = {},
    ) =>
      participantCommand(
        "decline-offer",
        body,
        options.participantAttemptId ?? crypto.randomUUID(),
        supportRequestId,
        offerId,
      ),
    requestSupportReview: async (supportRequestId: string, body: Readonly<{ reason: string }>) =>
      participantCommand("escalate", body, options.participantAttemptId ?? crypto.randomUUID(), supportRequestId),
    cancelSupportRequest: async (supportRequestId: string, body: Readonly<{ reason: string }>) =>
      participantCommand("cancel", body, options.participantAttemptId ?? crypto.randomUUID(), supportRequestId),
    closeSupportRequest: async (supportRequestId: string) =>
      participantCommand("close", {}, options.participantAttemptId ?? crypto.randomUUID(), supportRequestId),
    disputeSupportReturnCondition: async (supportRequestId: string, body: Readonly<{ reason: string }>) =>
      participantCommand(
        "return-condition-dispute",
        body,
        options.participantAttemptId ?? crypto.randomUUID(),
        supportRequestId,
      ),
    escalateOverdueSupportRequests: async (body: Readonly<{ limit?: number }> = {}) =>
      parseJsonResponse<SupportRequestEscalationSnapshot>(
        await clientFetch(`${baseUrl}/support-requests/ops/escalate-overdue`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...resolveHeaders(options.headers),
          },
          body: JSON.stringify(body),
        }),
      ),
    recordSupportOperationsNote: async (
      supportRequestId: string,
      body: Readonly<{
        summary: string;
      }>,
    ) =>
      parseJsonResponse<SupportRequestCommandSnapshot>(
        await clientFetch(`${baseUrl}/support-requests/ops/${supportRequestId}/evidence`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...resolveHeaders(options.headers),
          },
          body: JSON.stringify({
            evidenceType: "support-note",
            summary: body.summary,
          }),
        }),
      ),
    recordSupportOperationsResponse: async (
      supportRequestId: string,
      body: Readonly<{
        responseType: string;
        summary: string;
      }>,
    ) =>
      parseJsonResponse<SupportRequestCommandSnapshot>(
        await clientFetch(`${baseUrl}/support-requests/ops/${supportRequestId}/responses`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...resolveHeaders(options.headers),
          },
          body: JSON.stringify(body),
        }),
      ),
    escalateSupportOperationsRequest: async (
      supportRequestId: string,
      body: Readonly<{
        reason: string;
      }>,
    ) =>
      parseJsonResponse<SupportRequestCommandSnapshot>(
        await clientFetch(`${baseUrl}/support-requests/ops/${supportRequestId}/escalate`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...resolveHeaders(options.headers),
          },
          body: JSON.stringify(body),
        }),
      ),
    resolveSupportOperationsRequest: async (
      supportRequestId: string,
      body: Readonly<{
        resolutionType: string;
        summary: string;
        refundAmount?: string | null;
        responsibility: string;
        evidenceBasis: Readonly<{ type: string; reference: string }>;
        responsibilityReasonCode: string;
      }>,
    ) =>
      parseJsonResponse<SupportRequestCommandSnapshot>(
        await clientFetch(`${baseUrl}/support-requests/ops/${supportRequestId}/resolve`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...resolveHeaders(options.headers),
          },
          body: JSON.stringify(body),
        }),
      ),
    closeSupportOperationsRequest: async (supportRequestId: string) =>
      parseJsonResponse<SupportRequestCommandSnapshot>(
        await clientFetch(`${baseUrl}/support-requests/ops/${supportRequestId}/close`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...resolveHeaders(options.headers),
          },
          body: JSON.stringify({}),
        }),
      ),
    cancelSupportOperationsRequest: async (
      supportRequestId: string,
      body: Readonly<{
        reason: string;
      }>,
    ) =>
      parseJsonResponse<SupportRequestCommandSnapshot>(
        await clientFetch(`${baseUrl}/support-requests/ops/${supportRequestId}/cancel`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...resolveHeaders(options.headers),
          },
          body: JSON.stringify(body),
        }),
      ),
    previewRemedyProposal: async (supportRequestId: string, body: Readonly<Record<string, unknown>>) =>
      parseJsonResponse<PlatformRemedyProposalPreview>(
        await clientFetch(`${baseUrl}/support-requests/ops/${supportRequestId}/remedy-proposals/preview`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...resolveHeaders(options.headers) },
          body: JSON.stringify(body),
        }),
      ),
    proposeRemedy: async (supportRequestId: string, body: Readonly<Record<string, unknown>>) =>
      parseJsonResponse<SupportRequestCommandSnapshot & Readonly<{ remedyId: string }>>(
        await clientFetch(`${baseUrl}/support-requests/ops/${supportRequestId}/remedy-proposals`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...resolveHeaders(options.headers) },
          body: JSON.stringify(body),
        }),
      ),
    approveRemedy: async (supportRequestId: string, body: Readonly<Record<string, unknown>>) =>
      parseJsonResponse<SupportRequestCommandSnapshot & Readonly<{ remedyId: string }>>(
        await clientFetch(`${baseUrl}/support-requests/ops/${supportRequestId}/remedy-proposals/approve`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...resolveHeaders(options.headers) },
          body: JSON.stringify(body),
        }),
      ),
    retryRemedyEffect: async (
      supportRequestId: string,
      remedyId: string,
      effect: string,
      body: Readonly<Record<string, unknown>>,
    ) =>
      parseJsonResponse<SupportRequestCommandSnapshot & Readonly<{ remedyId: string }>>(
        await clientFetch(
          `${baseUrl}/support-requests/ops/${supportRequestId}/remedies/${remedyId}/effects/${effect}/retry`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", ...resolveHeaders(options.headers) },
            body: JSON.stringify(body),
          },
        ),
      ),
    waiveRemedyEffect: async (
      supportRequestId: string,
      remedyId: string,
      effect: string,
      body: Readonly<Record<string, unknown>>,
    ) =>
      parseJsonResponse<SupportRequestCommandSnapshot & Readonly<{ remedyId: string }>>(
        await clientFetch(
          `${baseUrl}/support-requests/ops/${supportRequestId}/remedies/${remedyId}/effects/${effect}/override`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", ...resolveHeaders(options.headers) },
            body: JSON.stringify(body),
          },
        ),
      ),
    releaseRemedyRefund: async (supportRequestId: string, remedyId: string, body: Readonly<Record<string, unknown>>) =>
      parseJsonResponse<SupportRequestCommandSnapshot & Readonly<{ remedyId: string }>>(
        await clientFetch(`${baseUrl}/support-requests/ops/${supportRequestId}/remedies/${remedyId}/effects`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...resolveHeaders(options.headers) },
          body: JSON.stringify({ ...body, effect: "operator-release" }),
        }),
      ),
    requestRemedyCorrection: async (supportRequestId: string, body: Readonly<Record<string, unknown>>) =>
      parseJsonResponse<SupportRequestCommandSnapshot & Readonly<{ remedyId: string }>>(
        await clientFetch(`${baseUrl}/support-requests/ops/${supportRequestId}/remedy-corrections`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...resolveHeaders(options.headers) },
          body: JSON.stringify(body),
        }),
      ),
  };
}

export function createSupportRequestRequestApiClient(request: Request, participantAttemptId?: string) {
  return createSupportRequestApiClient({
    participantAttemptId,
    baseUrl: resolveRequestApiBaseUrl(request, "/api/marketplace"),
    fetch: createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "platform-operations" }),
  });
}
