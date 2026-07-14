import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
import { attachResponseMetadata } from "@chase-sets/http/responses";
import type {
  SupportFlowSummary,
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
    getSupportOrderContext: async (orderId: string, role?: string | null) => {
      const query = role ? `?role=${encodeURIComponent(role)}` : "";
      return parseJsonResponse<SupportOrderLookup>(
        await clientFetch(`${baseUrl}/support-requests/orders/${encodeURIComponent(orderId)}${query}`, {
          headers: resolveHeaders(options.headers),
        }),
      );
    },
    listSupportOperationsQueue: async (query = "") =>
      parseJsonResponse<{ items: readonly SupportRequestListItem[]; total: number; count: number }>(
        await clientFetch(`${baseUrl}/support-requests/ops${query ? `?${query}` : ""}`, {
          headers: resolveHeaders(options.headers),
        }),
      ),
    getSupportRequest: async (supportRequestId: string) =>
      parseJsonResponse<SupportRequestDetail>(
        await clientFetch(`${baseUrl}/support-requests/${supportRequestId}`, {
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
        openedByRole: string;
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
  };
}

export function createSupportRequestRequestApiClient(request: Request) {
  return createSupportRequestApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/marketplace"),
    fetch: createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "platform-operations" }),
  });
}
