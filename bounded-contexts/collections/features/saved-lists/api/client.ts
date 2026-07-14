import { attachResponseMetadata, readApiErrorMessage } from "@chase-sets/http/responses";
import type {
  AddProductToSavedListRequest,
  AnonymousSavedListClaimPreparation,
  AnonymousSavedListIntent,
  CreateAnonymousSavedListIntentRequest,
  RecentSavedListsResponse,
  SavedListAdditionResponse,
  SavedListDestination,
  SavedListDiscoverySurface,
} from "./discovery-contracts";

const DEFAULT_BASE_URL = "/api/collections";

export class CollectionsApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(readApiErrorMessage(body, `Collections API error ${status}`));
    this.name = "CollectionsApiError";
  }
}

export type CollectionsApiClientOptions = Readonly<{
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit | (() => HeadersInit);
  credentials?: RequestCredentials;
}>;

export function createCollectionsApiClient({
  baseUrl = DEFAULT_BASE_URL,
  fetch = globalThis.fetch,
  headers: initialHeaders,
  credentials = "include",
}: CollectionsApiClientOptions = {}) {
  const configuredFetch: typeof globalThis.fetch = (input, init = {}) =>
    fetch(input, { ...init, credentials: init.credentials ?? credentials });
  const request = async <T>(path: string, init: RequestInit = {}) => {
    const response = await configuredFetch(joinPath(baseUrl, path), {
      ...init,
      headers: {
        ...headersToRecord(resolveHeaders(initialHeaders)),
        ...headersToRecord(init.headers),
      },
    });
    if (!response.ok) {
      throw new CollectionsApiError(response.status, await response.json().catch(() => null));
    }
    return attachResponseMetadata(await response.json(), response) as T;
  };
  const anonymousHeaders = (anonymousOwnerId: string) => ({
    "content-type": "application/json",
    "x-collections-anonymous-saved-list-id": anonymousOwnerId,
  });

  return {
    listRecentSavedLists: () => request<RecentSavedListsResponse>("/account/lists/recent"),
    addProductToSavedList: (body: AddProductToSavedListRequest) =>
      request<SavedListAdditionResponse>("/account/list-additions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    createAnonymousSavedListIntent: (anonymousOwnerId: string, body: CreateAnonymousSavedListIntentRequest) =>
      request<Readonly<{ intent: AnonymousSavedListIntent; analyticsLabel: "saved-list.guest-intent-created" }>>(
        "/guest/saved-list-intents",
        {
          method: "POST",
          headers: anonymousHeaders(anonymousOwnerId),
          body: JSON.stringify(body),
        },
      ),
    prepareAnonymousSavedListClaim: (anonymousOwnerId: string, intentId: string) =>
      request<AnonymousSavedListClaimPreparation>(`/account/saved-list-intents/${encodeURIComponent(intentId)}`, {
        headers: anonymousHeaders(anonymousOwnerId),
      }),
    claimAnonymousSavedListIntent: (
      anonymousOwnerId: string,
      intentId: string,
      body: Readonly<{
        destination: SavedListDestination;
        trackedQuantity: number;
        sourceSurface: SavedListDiscoverySurface;
      }>,
    ) =>
      request<SavedListAdditionResponse>(`/account/saved-list-intents/${encodeURIComponent(intentId)}/claim`, {
        method: "POST",
        headers: anonymousHeaders(anonymousOwnerId),
        body: JSON.stringify(body),
      }),
  };
}

function resolveHeaders(headers?: HeadersInit | (() => HeadersInit)) {
  return typeof headers === "function" ? headers() : headers;
}

function headersToRecord(headers?: HeadersInit) {
  return headers ? Object.fromEntries(new Headers(headers).entries()) : {};
}

function joinPath(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

export const collectionsApi = createCollectionsApiClient();
