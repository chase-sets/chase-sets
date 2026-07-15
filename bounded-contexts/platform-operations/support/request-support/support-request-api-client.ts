import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
import { attachResponseMetadata } from "@chase-sets/http/responses";
import type {
  SupportFlowSummary,
  PlatformRemedyProposalPreview,
  SupportOrderLookup,
  SupportRequestCommandSnapshot,
  SupportRequestDetail,
  SupportRequestEscalationSnapshot,
  SupportRequestListItem,
} from "../../features/support-requests/ui/contracts";

export type {
  SupportFlowSummary,
  SupportOrderLookup,
  SupportRequestCommandSnapshot,
  SupportRequestDetail,
  SupportRequestEscalationSnapshot,
  SupportRequestListItem,
} from "../../features/support-requests/ui/contracts";

type SupportRequestApiClientOptions = Readonly<{
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

  return {
    listFlows: async () =>
      parseJsonResponse<{ items: readonly SupportFlowSummary[] }>(
        await clientFetch(`${baseUrl}/support-requests/flows`, {
          headers: resolveHeaders(options.headers),
        }),
      ),
    listBuyerSupportRequests: async () =>
      parseJsonResponse<{ items: readonly SupportRequestListItem[]; total: number; count: number }>(
        await clientFetch(`${baseUrl}/support-requests/purchases`, {
          headers: resolveHeaders(options.headers),
        }),
      ),
    listSellerSupportRequests: async () =>
      parseJsonResponse<{ items: readonly SupportRequestListItem[]; total: number; count: number }>(
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
      parseJsonResponse<{ items: readonly SupportRequestListItem[]; total: number; count: number }>(
        await clientFetch(`${baseUrl}/support-requests/ops${query ? `?${query}` : ""}`, {
          headers: resolveHeaders(options.headers),
        }),
      ),
    getSupportRequest: async (supportRequestId: string) =>
      parseJsonResponse<SupportRequestDetail>(
        await clientFetch(`${baseUrl}/support-requests/${encodeURIComponent(supportRequestId)}`, {
          headers: resolveHeaders(options.headers),
        }),
      ),
    getSupportOperationsRequest: async (supportRequestId: string) =>
      parseJsonResponse<SupportRequestDetail>(
        await clientFetch(`${baseUrl}/support-requests/ops/${supportRequestId}`, {
          headers: resolveHeaders(options.headers),
        }),
      ),
    openSupportRequest: async (
      body: Readonly<{
        orderId: string;
        flowType: string;
        affectedLineIds?: readonly string[];
      }>,
    ) =>
      parseJsonResponse<SupportRequestCommandSnapshot>(
        await clientFetch(`${baseUrl}/support-requests`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...resolveHeaders(options.headers),
          },
          body: JSON.stringify(body),
        }),
      ),
    uploadSupportEvidenceAttachments: async (supportRequestId: string, files: readonly File[]) => {
      const formData = new FormData();
      files.forEach((file) => formData.append("attachments", file));
      return parseJsonResponse<{
        attachments: readonly Readonly<{
          attachmentId: string;
          reference: string;
          contentType: string;
          byteSize: number;
        }>[];
      }>(
        await clientFetch(`${baseUrl}/support-requests/${supportRequestId}/attachments`, {
          method: "POST",
          headers: resolveHeaders(options.headers),
          body: formData,
        }),
      );
    },
    submitSupportEvidence: async (
      supportRequestId: string,
      body: Readonly<{
        submittedByRole: string;
        evidenceType: string;
        summary: string;
        occurredAt?: string | null;
        attachments?: readonly string[];
      }>,
    ) =>
      parseJsonResponse<SupportRequestCommandSnapshot>(
        await clientFetch(`${baseUrl}/support-requests/${encodeURIComponent(supportRequestId)}/evidence`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...resolveHeaders(options.headers) },
          body: JSON.stringify(body),
        }),
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
      parseJsonResponse<SupportRequestCommandSnapshot>(
        await clientFetch(`${baseUrl}/support-requests/${encodeURIComponent(supportRequestId)}/responses`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...resolveHeaders(options.headers) },
          body: JSON.stringify(body),
        }),
      ),
    acceptSupportOffer: async (supportRequestId: string, offerId: string) =>
      parseJsonResponse<SupportRequestCommandSnapshot>(
        await clientFetch(
          `${baseUrl}/support-requests/${encodeURIComponent(supportRequestId)}/offers/${encodeURIComponent(offerId)}/accept`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", ...resolveHeaders(options.headers) },
            body: JSON.stringify({}),
          },
        ),
      ),
    declineSupportOffer: async (
      supportRequestId: string,
      offerId: string,
      body: Readonly<{ summary?: string | null }> = {},
    ) =>
      parseJsonResponse<SupportRequestCommandSnapshot>(
        await clientFetch(
          `${baseUrl}/support-requests/${encodeURIComponent(supportRequestId)}/offers/${encodeURIComponent(offerId)}/decline`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", ...resolveHeaders(options.headers) },
            body: JSON.stringify(body),
          },
        ),
      ),
    requestSupportReview: async (supportRequestId: string, body: Readonly<{ reason: string }>) =>
      parseJsonResponse<SupportRequestCommandSnapshot>(
        await clientFetch(`${baseUrl}/support-requests/${encodeURIComponent(supportRequestId)}/escalate`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...resolveHeaders(options.headers) },
          body: JSON.stringify(body),
        }),
      ),
    cancelSupportRequest: async (supportRequestId: string, body: Readonly<{ reason: string }>) =>
      parseJsonResponse<SupportRequestCommandSnapshot>(
        await clientFetch(`${baseUrl}/support-requests/${encodeURIComponent(supportRequestId)}/cancel`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...resolveHeaders(options.headers) },
          body: JSON.stringify(body),
        }),
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

export function createSupportRequestRequestApiClient(request: Request) {
  return createSupportRequestApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/marketplace"),
    fetch: createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "platform-operations" }),
  });
}
