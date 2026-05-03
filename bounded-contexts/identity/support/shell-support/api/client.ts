import { hc } from "hono/client";
import type { HonoClientResource } from "@chase-sets/http/hono-client";
import type { ListResponse } from "@chase-sets/http/responses";
import type { buildIdentityApi } from "../../../api";

type IdentityApiApp = ReturnType<typeof buildIdentityApi>;

const DEFAULT_BASE_URL = "/api/identity";

export class IdentityApiError extends Error {
  constructor(
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

export interface IdentityApiClientOptions {
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
    throw new IdentityApiError(response.status, errorBody);
  }

  return response.json() as Promise<T>;
}

export function createIdentityApiClient({
  baseUrl = DEFAULT_BASE_URL,
  fetch = globalThis.fetch,
  headers: initialHeaders,
  credentials = "include",
}: IdentityApiClientOptions = {}) {
  const configuredFetch: typeof globalThis.fetch = (input, init = {}) =>
    fetch(input, {
      ...init,
      credentials: init.credentials ?? credentials,
    });
  const client = hc<IdentityApiApp>(baseUrl, {
    fetch: configuredFetch,
  }) as unknown as HonoClientResource;
  const headers = resolveHeaders(initialHeaders);

  return {
    async listAccounts<T>(query = ""): Promise<T> {
      return parseJsonResponse<T>(
        await client.accounts.$get({
          query: Object.fromEntries(new URLSearchParams(query)),
          header: headers,
        }),
      );
    },
    async getAccount<T>(id: string): Promise<T> {
      return parseJsonResponse<T>(
        await client.accounts[":id"].$get({ param: { id }, header: headers }),
      );
    },
    async listUsers<T>(query = ""): Promise<T> {
      return parseJsonResponse<T>(
        await client.users.$get({
          query: Object.fromEntries(new URLSearchParams(query)),
          header: headers,
        }),
      );
    },
    async getUser<T>(id: string): Promise<T> {
      return parseJsonResponse<T>(
        await client.users[":id"].$get({ param: { id }, header: headers }),
      );
    },
    async listMemberships<T>(query = ""): Promise<T> {
      return parseJsonResponse<T>(
        await client.memberships.$get({
          query: Object.fromEntries(new URLSearchParams(query)),
          header: headers,
        }),
      );
    },
    async getMembership<T>(id: string): Promise<T> {
      return parseJsonResponse<T>(
        await client.memberships[":id"].$get({ param: { id }, header: headers }),
      );
    },
    async listInvitations<T>(query = ""): Promise<T> {
      return parseJsonResponse<T>(
        await client.invitations.$get({
          query: Object.fromEntries(new URLSearchParams(query)),
          header: headers,
        }),
      );
    },
    async getInvitation<T>(id: string): Promise<T> {
      return parseJsonResponse<T>(
        await client.invitations[":id"].$get({ param: { id }, header: headers }),
      );
    },
    async listApiKeys<T>(query = ""): Promise<T> {
      return parseJsonResponse<T>(
        await client["api-keys"].$get({
          query: Object.fromEntries(new URLSearchParams(query)),
          header: headers,
        }),
      );
    },
    async getApiKey<T>(id: string): Promise<T> {
      return parseJsonResponse<T>(
        await client["api-keys"][":id"].$get({ param: { id }, header: headers }),
      );
    },
    async listConsents<T>(query = ""): Promise<T> {
      return parseJsonResponse<T>(
        await client.consents.$get({
          query: Object.fromEntries(new URLSearchParams(query)),
          header: headers,
        }),
      );
    },
  };
}

export const identityApi = createIdentityApiClient();

export type IdentityListResponse<T> = ListResponse<T>;
