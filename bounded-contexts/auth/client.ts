import { attachResponseMetadata } from "@chase-sets/http/responses";

const DEFAULT_BASE_URL = "/api/auth";

function getApiErrorMessage(status: number, body: unknown) {
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error?: unknown }).error;
    if (error && typeof error === "object" && "message" in error) {
      return String((error as { message?: unknown }).message);
    }

    if (typeof error === "string") {
      return error;
    }
  }

  return `API error ${status}`;
}

export class AuthApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(getApiErrorMessage(status, body));
  }
}

export interface AuthApiClientOptions {
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
    throw new AuthApiError(response.status, errorBody);
  }

  return attachResponseMetadata(await response.json(), response) as T;
}

async function postJson<T>(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  body: Record<string, unknown>,
  headers?: HeadersInit,
) {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("Content-Type", "application/json");

  return parseJsonResponse<T>(
    await fetchImpl(url, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(body),
    }),
  );
}

async function putJson<T>(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  body: Record<string, unknown>,
  headers?: HeadersInit,
) {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("Content-Type", "application/json");

  return parseJsonResponse<T>(
    await fetchImpl(url, {
      method: "PUT",
      headers: requestHeaders,
      body: JSON.stringify(body),
    }),
  );
}

export function createAuthApiClient({
  baseUrl = DEFAULT_BASE_URL,
  fetch = globalThis.fetch,
  headers: initialHeaders,
  credentials = "include",
}: AuthApiClientOptions = {}) {
  const configuredFetch: typeof globalThis.fetch = (input, init = {}) =>
    fetch(input, {
      ...init,
      credentials: init.credentials ?? credentials,
    });
  const headers = resolveHeaders(initialHeaders);
  const buildUrl = (path: string) => new URL(path, `${baseUrl}/`).toString();

  return {
    async register<T>(body: Record<string, unknown>): Promise<T> {
      return postJson<T>(configuredFetch, buildUrl("register"), body, headers);
    },
    async signInWithPassword<T>(body: Record<string, unknown>): Promise<T> {
      return postJson<T>(configuredFetch, buildUrl("password-sign-in"), body, headers);
    },
    async requestMagicLink<T>(body: Record<string, unknown>): Promise<T> {
      return postJson<T>(configuredFetch, buildUrl("magic-link/request"), body, headers);
    },
    async consumeMagicLink<T>(body: Record<string, unknown>): Promise<T> {
      return postJson<T>(configuredFetch, buildUrl("magic-link/consume"), body, headers);
    },
    async requestPhoneCode<T>(body: Record<string, unknown>): Promise<T> {
      return postJson<T>(configuredFetch, buildUrl("phone-code/request"), body, headers);
    },
    async consumePhoneCode<T>(body: Record<string, unknown>): Promise<T> {
      return postJson<T>(configuredFetch, buildUrl("phone-code/consume"), body, headers);
    },
    async startGuestCheckout<T>(body: Record<string, unknown>): Promise<T> {
      return postJson<T>(configuredFetch, buildUrl("guest-checkout/start"), body, headers);
    },
    async exitGuestCheckout<T>(): Promise<T> {
      return postJson<T>(configuredFetch, buildUrl("guest-checkout/exit"), {}, headers);
    },
    async claimGuestCheckoutWithMagicLink<T>(body: Record<string, unknown>): Promise<T> {
      return postJson<T>(configuredFetch, buildUrl("guest-checkout/claim-with-magic-link"), body, headers);
    },
    async claimGuestCheckoutWithClaimContinuation<T>(body: Record<string, unknown>): Promise<T> {
      return postJson<T>(configuredFetch, buildUrl("guest-checkout/claim-with-continuation"), body, headers);
    },
    async requestGuestCheckoutClaimLink<T>(body: Record<string, unknown>): Promise<T> {
      return postJson<T>(configuredFetch, buildUrl("guest-checkout/claim-link/request"), body, headers);
    },
    async getGuestCheckoutClaimContext<T>(body: Record<string, unknown>): Promise<T> {
      return postJson<T>(configuredFetch, buildUrl("guest-checkout/claim-context"), body, headers);
    },
    async claimGuestCheckoutWithPasskey<T>(body: Record<string, unknown>): Promise<T> {
      return postJson<T>(configuredFetch, buildUrl("guest-checkout/claim-with-passkey"), body, headers);
    },
    async createPasskeyChallenge<T>(body: Record<string, unknown>): Promise<T> {
      return postJson<T>(configuredFetch, buildUrl("passkeys/challenge"), body, headers);
    },
    async registerPasskey<T>(body: Record<string, unknown>): Promise<T> {
      return postJson<T>(configuredFetch, buildUrl("passkeys/register"), body, headers);
    },
    async signInWithPasskey<T>(body: Record<string, unknown>): Promise<T> {
      return postJson<T>(configuredFetch, buildUrl("passkeys/sign-in"), body, headers);
    },
    async resolveAccountSelection<T>(body: Record<string, unknown>): Promise<T> {
      return postJson<T>(configuredFetch, buildUrl("account-selection/resolve"), body, headers);
    },
    async completeAccountSelection<T>(body: Record<string, unknown>): Promise<T> {
      return postJson<T>(configuredFetch, buildUrl("account-selection/complete"), body, headers);
    },
    async getCurrentActor<T>(): Promise<T> {
      return parseJsonResponse<T>(
        await configuredFetch(buildUrl("session"), {
          headers,
        }),
      );
    },
    async listSessions<T>(query = ""): Promise<T> {
      const search = new URLSearchParams(query).toString();
      return parseJsonResponse<T>(
        await configuredFetch(search ? `${buildUrl("sessions")}?${search}` : buildUrl("sessions"), {
          headers,
        }),
      );
    },
    async getSession<T>(id: string): Promise<T> {
      return parseJsonResponse<T>(
        await configuredFetch(buildUrl(`sessions/${id}`), {
          headers,
        }),
      );
    },
    async switchSessionAccount<T>(id: string, accountId: string): Promise<T> {
      return postJson<T>(configuredFetch, buildUrl(`sessions/${id}/switch-account`), { accountId }, headers);
    },
    async revokeSession<T>(id: string): Promise<T> {
      return postJson<T>(configuredFetch, buildUrl(`sessions/${id}/revoke`), {}, headers);
    },
    async signOutCurrentSession<T>(): Promise<T> {
      return parseJsonResponse<T>(
        await configuredFetch(buildUrl("sign-out"), {
          method: "POST",
          headers,
        }),
      );
    },
  };
}

export const authApi = createAuthApiClient();

const DEFAULT_UCP_OAUTH_BASE_URL = "/ucp/oauth";

// Client for the connected-agents self-service surface. The UCP OAuth grant,
// mandate, and activity routes are Auth-owned but mounted at /ucp/oauth rather than /api/auth
// (bounded-contexts/auth/support/ucp-support/oauth.ts), so this is a distinct base URL from
// createAuthApiClient rather than a second baseUrl on the same client instance.
export function createUcpOAuthApiClient({
  baseUrl = DEFAULT_UCP_OAUTH_BASE_URL,
  fetch = globalThis.fetch,
  headers: initialHeaders,
  credentials = "include",
}: AuthApiClientOptions = {}) {
  const configuredFetch: typeof globalThis.fetch = (input, init = {}) =>
    fetch(input, {
      ...init,
      credentials: init.credentials ?? credentials,
    });
  const headers = resolveHeaders(initialHeaders);
  const buildUrl = (path: string) => new URL(path, `${baseUrl}/`).toString();

  return {
    async listAgentGrants<T>(): Promise<T> {
      return parseJsonResponse<T>(await configuredFetch(buildUrl("authorizations"), { headers }));
    },
    async getAgentGrant<T>(id: string): Promise<T> {
      return parseJsonResponse<T>(await configuredFetch(buildUrl(`authorizations/${id}`), { headers }));
    },
    async listAgentGrantActivity<T>(id: string, query = ""): Promise<T> {
      const search = new URLSearchParams(query).toString();
      const path = `authorizations/${id}/activity`;
      return parseJsonResponse<T>(
        await configuredFetch(search ? `${buildUrl(path)}?${search}` : buildUrl(path), { headers }),
      );
    },
    async revokeAgentGrant<T>(id: string): Promise<T> {
      return postJson<T>(configuredFetch, buildUrl(`authorizations/${id}/revoke`), {}, headers);
    },
    async updateAgentGrantMandate<T>(id: string, mandate: Record<string, unknown>): Promise<T> {
      return putJson<T>(configuredFetch, buildUrl(`authorizations/${id}/mandate`), mandate, headers);
    },
  };
}
