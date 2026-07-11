import { attachResponseMetadata, type ListResponse } from "@chase-sets/http/responses";
import type {
  SubmitWaitlistSignupRequest,
  WaitlistCounter,
  WaitlistMetrics,
  WaitlistReferralSummary,
  WaitlistSignupListItem,
} from "./features/waitlist/api/contracts";
import type { PromoBarMessage, SavePromoBarMessageRequest } from "./features/promo-bar/api/contracts";

const DEFAULT_BASE_URL = "/api/public-presence";

export type {
  SubmitWaitlistSignupRequest,
  WaitlistCounter,
  WaitlistMetrics,
  WaitlistReferralSummary,
  WaitlistSignupListItem,
} from "./features/waitlist/api/contracts";
export type {
  PromoBarMessage,
  PromoBarMessageTone,
  SavePromoBarMessageRequest,
} from "./features/promo-bar/api/contracts";

export class PublicPresenceApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`API error ${status}`);
  }
}

export interface PublicPresenceApiClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit | (() => HeadersInit);
  credentials?: RequestCredentials;
}

function resolveHeaders(headers?: HeadersInit | (() => HeadersInit)) {
  return typeof headers === "function" ? headers() : headers;
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new PublicPresenceApiError(response.status, errorBody);
  }

  return attachResponseMetadata(await response.json(), response) as T;
}

export function createPublicPresenceApiClient({
  baseUrl = DEFAULT_BASE_URL,
  fetch = globalThis.fetch,
  headers: initialHeaders,
  credentials = "include",
}: PublicPresenceApiClientOptions = {}) {
  const configuredFetch: typeof globalThis.fetch = (input, init = {}) =>
    fetch(input, {
      ...init,
      credentials: init.credentials ?? credentials,
      headers: {
        "Content-Type": "application/json",
        ...resolveHeaders(initialHeaders),
        ...init.headers,
      },
    });

  return {
    async submitWaitlistSignup(body: SubmitWaitlistSignupRequest) {
      return parseJsonResponse<{ id: string; version: number; status: string }>(
        await configuredFetch(`${baseUrl}/waitlist`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
    },
    async listWaitlistSignups(query = ""): Promise<ListResponse<WaitlistSignupListItem>> {
      return parseJsonResponse(await configuredFetch(`${baseUrl}/admin/waitlist${query ? `?${query}` : ""}`));
    },
    async getWaitlistMetrics(): Promise<WaitlistMetrics> {
      return parseJsonResponse(await configuredFetch(`${baseUrl}/admin/waitlist/metrics`));
    },
    async getWaitlistReferralSummary(signupId: string): Promise<WaitlistReferralSummary> {
      return parseJsonResponse(
        await configuredFetch(`${baseUrl}/waitlist/${encodeURIComponent(signupId)}/referral-summary`),
      );
    },
    async getWaitlistCounter(): Promise<WaitlistCounter> {
      return parseJsonResponse(await configuredFetch(`${baseUrl}/waitlist/count`));
    },
    async listActivePromoBarMessages(): Promise<ListResponse<PromoBarMessage>> {
      return parseJsonResponse(await configuredFetch(`${baseUrl}/promo-bar-messages`));
    },
    async listPromoBarMessages(): Promise<ListResponse<PromoBarMessage>> {
      return parseJsonResponse(await configuredFetch(`${baseUrl}/admin/promo-bar-messages`));
    },
    async createPromoBarMessage(body: SavePromoBarMessageRequest): Promise<PromoBarMessage> {
      return parseJsonResponse(
        await configuredFetch(`${baseUrl}/admin/promo-bar-messages`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
    },
    async updatePromoBarMessage(id: string, body: SavePromoBarMessageRequest): Promise<PromoBarMessage> {
      return parseJsonResponse(
        await configuredFetch(`${baseUrl}/admin/promo-bar-messages/${encodeURIComponent(id)}`, {
          method: "PUT",
          body: JSON.stringify(body),
        }),
      );
    },
    async activatePromoBarMessage(id: string): Promise<PromoBarMessage> {
      return parseJsonResponse(
        await configuredFetch(`${baseUrl}/admin/promo-bar-messages/${encodeURIComponent(id)}/activate`, {
          method: "POST",
        }),
      );
    },
    async deactivatePromoBarMessage(id: string): Promise<PromoBarMessage> {
      return parseJsonResponse(
        await configuredFetch(`${baseUrl}/admin/promo-bar-messages/${encodeURIComponent(id)}/deactivate`, {
          method: "POST",
        }),
      );
    },
    async deletePromoBarMessage(id: string): Promise<{ id: string; status: string }> {
      return parseJsonResponse(
        await configuredFetch(`${baseUrl}/admin/promo-bar-messages/${encodeURIComponent(id)}`, {
          method: "DELETE",
        }),
      );
    },
  };
}

export const publicPresenceApi = createPublicPresenceApiClient();
