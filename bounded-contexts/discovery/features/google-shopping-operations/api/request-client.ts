import { attachResponseMetadata } from "@chase-sets/http/responses";
import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
import type {
  GoogleShoppingFeedRowFilter,
  GoogleShoppingFeedRowList,
  GoogleShoppingFullSyncJobStatus,
  GoogleShoppingMaintenancePreview,
  GoogleShoppingOperationsFilters,
} from "../ui/contracts";

type GoogleShoppingOperationsApiClientOptions = Readonly<{
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

export function createGoogleShoppingOperationsApiClient(options: GoogleShoppingOperationsApiClientOptions = {}) {
  const clientFetch = options.fetch ?? fetch;
  const baseUrl = options.baseUrl ?? "/api/marketplace";

  return {
    listFeedRows: async (query = "") =>
      parseJsonResponse<GoogleShoppingFeedRowList>(
        await clientFetch(`${baseUrl}/google-shopping/feed-rows${query ? `?${query}` : ""}`, {
          headers: resolveHeaders(options.headers),
        }),
      ),
    enqueueFullSyncJob: async (body: Readonly<{ mode: "dry-run"; batchSize?: number }>) =>
      parseJsonResponse<GoogleShoppingFullSyncJobStatus>(
        await clientFetch(`${baseUrl}/google-shopping/sync-jobs`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...resolveHeaders(options.headers),
          },
          body: JSON.stringify(body),
        }),
      ),
    previewMaintenanceSync: async (query = "") =>
      parseJsonResponse<GoogleShoppingMaintenancePreview>(
        await clientFetch(`${baseUrl}/google-shopping/maintenance/preview${query ? `?${query}` : ""}`, {
          headers: resolveHeaders(options.headers),
        }),
      ),
    enqueueMaintenanceSyncJob: async (
      body: Readonly<{ mode: "dry-run"; refreshWindowDays?: number; limit?: number }>,
    ) =>
      parseJsonResponse<{ summary: GoogleShoppingMaintenancePreview; job: GoogleShoppingFullSyncJobStatus | null }>(
        await clientFetch(`${baseUrl}/google-shopping/maintenance/sync-jobs`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...resolveHeaders(options.headers),
          },
          body: JSON.stringify(body),
        }),
      ),
    enqueueDiagnosticsRefreshJob: async (body: Readonly<{ mode: "dry-run"; batchSize?: number }>) =>
      parseJsonResponse<GoogleShoppingFullSyncJobStatus>(
        await clientFetch(`${baseUrl}/google-shopping/diagnostics/refresh-jobs`, {
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

export function createGoogleShoppingOperationsRequestApiClient(request: Request) {
  return createGoogleShoppingOperationsApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/marketplace"),
    fetch: createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "discovery" }),
  });
}

export function readGoogleShoppingOperationsFilters(request: Request): GoogleShoppingOperationsFilters {
  const url = new URL(request.url);

  return {
    filter: readFeedRowFilter(url.searchParams.get("filter")),
    search: url.searchParams.get("search")?.trim() ?? "",
    limit: readPositiveInteger(url.searchParams.get("limit"), 100),
    refreshWindowDays: readPositiveInteger(url.searchParams.get("refreshWindowDays"), 25),
    selected: url.searchParams.get("selected") ?? "",
  };
}

export function googleShoppingOperationsListQuery(filters: GoogleShoppingOperationsFilters) {
  const query = new URLSearchParams({
    filter: filters.filter,
    limit: String(filters.limit),
    refreshWindowDays: String(filters.refreshWindowDays),
  });
  if (filters.search) {
    query.set("search", filters.search);
  }
  return query.toString();
}

function readFeedRowFilter(value: string | null): GoogleShoppingFeedRowFilter {
  return value === "eligible" ||
    value === "excluded" ||
    value === "failed" ||
    value === "disapproved" ||
    value === "pending-delete" ||
    value === "nearing-refresh" ||
    value === "stale" ||
    value === "pending-diagnostics"
    ? value
    : "all";
}

function readPositiveInteger(value: string | null, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
