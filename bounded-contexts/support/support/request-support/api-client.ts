import {
  createForwardedAuthFetch,
  resolveRequestApiBaseUrl,
} from "@chase-sets/platform-runtime/http";
import type {
  SupportFlowSummary,
  SupportRequestDetail,
  SupportRequestListItem,
} from "../../features/support-requests/ui/contracts";

export type {
  SupportFlowSummary,
  SupportRequestDetail,
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
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `API error ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export function createSupportRequestApiClient(
  options: SupportRequestApiClientOptions = {},
) {
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
    getSupportRequest: async (supportRequestId: string) =>
      parseJsonResponse<SupportRequestDetail>(
        await clientFetch(`${baseUrl}/support-requests/${supportRequestId}`, {
          headers: resolveHeaders(options.headers),
        }),
      ),
    openSupportRequest: async (body: Readonly<{
      orderId: string;
      flowType: string;
      openedByRole: string;
    }>) =>
      parseJsonResponse<{ id: string; version: number; status: string }>(
        await clientFetch(`${baseUrl}/support-requests`, {
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
    fetch: createForwardedAuthFetch(request),
  });
}
