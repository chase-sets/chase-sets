import type { ListResponse } from "@chase-sets/http/responses";
import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
import type { SavedListId, SavedListOwnerSnapshot, SavedListVisibility } from "../../features/saved-lists/domain";

// Re-exported so route composition roots consume Saved List read shapes through
// this slice-local adapter instead of importing Saved List domain internals.
export type { SavedListId, SavedListOwnerSnapshot, SavedListVisibility } from "../../features/saved-lists/domain";

/**
 * Request-scoped client for the Collections HTTP surface mounted under
 * `/api/collections`. Reads and commands both target the committed Saved List
 * contracts. The Saved List summary read model is owned by the Collections
 * projection slice; this client depends only on its projected display shape.
 */
export class CollectionsApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "CollectionsApiError";
    this.status = status;
  }
}

export type CollectionsSavedListSummary = Readonly<{
  listId: SavedListId;
  title: string;
  description: string | null;
  visibility: SavedListVisibility;
  lineCount: number;
  trackedUnitCount: number;
  changedAt: string;
  estimatedValueAmount: string | null;
  estimatedValueCurrency: string | null;
}>;

export type CollectionsApiClientOptions = Readonly<{
  requestTimeoutMs?: number;
  recoverTransportErrorsAsGatewayTimeout?: boolean;
}>;

const DEFAULT_TIMEOUT_MS = 10_000;

export function createCollectionsRequestApiClient(request: Request, options: CollectionsApiClientOptions = {}) {
  const baseUrl = resolveRequestApiBaseUrl(request, "/api/collections");
  const fetchImpl = createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "collections" });
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function call<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, { signal: controller.signal });
      const text = await response.text();
      const payload = text ? (JSON.parse(text) as unknown) : null;
      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && "error" in payload
            ? String((payload as { error?: unknown }).error)
            : response.statusText;
        throw new CollectionsApiError(response.status, message);
      }
      return payload as T;
    } catch (error) {
      if (error instanceof CollectionsApiError) {
        throw error;
      }
      if (options.recoverTransportErrorsAsGatewayTimeout) {
        throw new CollectionsApiError(504, "Collections service is unavailable.");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    listSavedLists(query = "") {
      const search = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : "";
      return call<ListResponse<CollectionsSavedListSummary>>(`/saved-lists${search}`);
    },
    getSavedList(listId: SavedListId) {
      return call<SavedListOwnerSnapshot>(`/saved-lists/${encodeURIComponent(listId)}`);
    },
  };
}

export type CollectionsRequestApiClient = ReturnType<typeof createCollectionsRequestApiClient>;
