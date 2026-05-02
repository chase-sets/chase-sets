const DEFAULT_BASE_URL = "/api/auth";

export class AuthApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(
      typeof body === "object" && body !== null && "error" in body
        ? String((body as Record<string, unknown>).error)
        : `API error ${status}`,
    );
  }
}

export interface AuthApiClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit | (() => HeadersInit);
  credentials?: RequestCredentials;
}

function resolveHeaders(
  headers?: HeadersInit | (() => HeadersInit),
) {
  return typeof headers === "function" ? headers() : headers;
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new AuthApiError(response.status, errorBody);
  }

  return response.json() as Promise<T>;
}

async function postJson<T>(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  body: Record<string, unknown>,
  headers?: HeadersInit,
) {
  return parseJsonResponse<T>(
    await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...new Headers(headers),
      },
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
      return postJson<T>(
        configuredFetch,
        buildUrl("password-sign-in"),
        body,
        headers,
      );
    },
    async requestMagicLink<T>(body: Record<string, unknown>): Promise<T> {
      return postJson<T>(
        configuredFetch,
        buildUrl("magic-link/request"),
        body,
        headers,
      );
    },
    async consumeMagicLink<T>(body: Record<string, unknown>): Promise<T> {
      return postJson<T>(
        configuredFetch,
        buildUrl("magic-link/consume"),
        body,
        headers,
      );
    },
    async createPasskeyChallenge<T>(body: Record<string, unknown>): Promise<T> {
      return postJson<T>(
        configuredFetch,
        buildUrl("passkeys/challenge"),
        body,
        headers,
      );
    },
    async registerPasskey<T>(body: Record<string, unknown>): Promise<T> {
      return postJson<T>(
        configuredFetch,
        buildUrl("passkeys/register"),
        body,
        headers,
      );
    },
    async signInWithPasskey<T>(body: Record<string, unknown>): Promise<T> {
      return postJson<T>(
        configuredFetch,
        buildUrl("passkeys/sign-in"),
        body,
        headers,
      );
    },
    async resolveAccountSelection<T>(body: Record<string, unknown>): Promise<T> {
      return postJson<T>(
        configuredFetch,
        buildUrl("account-selection/resolve"),
        body,
        headers,
      );
    },
    async completeAccountSelection<T>(body: Record<string, unknown>): Promise<T> {
      return postJson<T>(
        configuredFetch,
        buildUrl("account-selection/complete"),
        body,
        headers,
      );
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
        await configuredFetch(
          search ? `${buildUrl("sessions")}?${search}` : buildUrl("sessions"),
          {
            headers,
          },
        ),
      );
    },
    async getSession<T>(id: string): Promise<T> {
      return parseJsonResponse<T>(
        await configuredFetch(buildUrl(`sessions/${id}`), {
          headers,
        }),
      );
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
