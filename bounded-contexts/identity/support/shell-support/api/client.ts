import { hc } from "hono/client";
import { honoClientResource } from "@chase-sets/http/hono-client";
import { attachResponseMetadata, type ListResponse } from "@chase-sets/http/responses";
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

function resolveHeaders(headers?: HeadersInit | (() => HeadersInit)) {
  return typeof headers === "function" ? headers() : headers;
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new IdentityApiError(response.status, errorBody);
  }

  return attachResponseMetadata(await response.json(), response) as T;
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
  const client = honoClientResource(
    hc<IdentityApiApp>(baseUrl, {
      fetch: configuredFetch,
    }),
  );
  const headers = resolveHeaders(initialHeaders);

  return {
    async getAccessHome<T>(query = ""): Promise<T> {
      return parseJsonResponse<T>(
        await client["access-hub"].$get({
          query: Object.fromEntries(new URLSearchParams(query)),
          header: headers,
        }),
      );
    },
    async getAccountAccessHub<T>(accountId: string): Promise<T> {
      return parseJsonResponse<T>(
        await client["access-hub"].accounts[":accountId"].$get({ param: { accountId }, header: headers }),
      );
    },
    async getUserAccountLink<T>(userId: string): Promise<T> {
      return parseJsonResponse<T>(
        await client["access-hub"].users[":userId"].account.$get({ param: { userId }, header: headers }),
      );
    },
    async listAccounts<T>(query = ""): Promise<T> {
      return parseJsonResponse<T>(
        await client.accounts.$get({
          query: Object.fromEntries(new URLSearchParams(query)),
          header: headers,
        }),
      );
    },
    async getAccount<T>(id: string): Promise<T> {
      return parseJsonResponse<T>(await client.accounts[":id"].$get({ param: { id }, header: headers }));
    },
    async updateAccount<T>(id: string, body: Record<string, unknown>): Promise<T> {
      return parseJsonResponse<T>(await client.accounts[":id"].$put({ param: { id }, json: body, header: headers }));
    },
    async suspendAccount<T>(id: string): Promise<T> {
      return parseJsonResponse<T>(
        await client.accounts[":id"].suspend.$post({ param: { id }, json: {}, header: headers }),
      );
    },
    async reactivateAccount<T>(id: string): Promise<T> {
      return parseJsonResponse<T>(
        await client.accounts[":id"].reactivate.$post({ param: { id }, json: {}, header: headers }),
      );
    },
    async closeAccount<T>(id: string): Promise<T> {
      return parseJsonResponse<T>(
        await client.accounts[":id"].close.$post({ param: { id }, json: {}, header: headers }),
      );
    },
    async assignAccountBadge<T = { badges: readonly string[] }>(id: string, badgeKey: string): Promise<T> {
      return parseJsonResponse<T>(
        await client.accounts[":id"].badges.$post({
          param: { id },
          json: { badgeKey },
          header: headers,
        }),
      );
    },
    async removeAccountBadge<T = { badges: readonly string[] }>(id: string, badgeKey: string): Promise<T> {
      return parseJsonResponse<T>(
        await client.accounts[":id"].badges[":badgeKey"].$delete({
          param: { id, badgeKey },
          header: headers,
        }),
      );
    },
    async listShippingAddresses<T>(accountId: string): Promise<T> {
      return parseJsonResponse<T>(
        await client.accounts[":accountId"]["shipping-addresses"].$get({
          param: { accountId },
          header: headers,
        }),
      );
    },
    async createShippingAddress<T>(accountId: string, body: Record<string, unknown>): Promise<T> {
      return parseJsonResponse<T>(
        await client.accounts[":accountId"]["shipping-addresses"].$post({
          param: { accountId },
          json: body,
          header: headers,
        }),
      );
    },
    async updateShippingAddress<T>(
      accountId: string,
      shippingAddressId: string,
      body: Record<string, unknown>,
    ): Promise<T> {
      return parseJsonResponse<T>(
        await client.accounts[":accountId"]["shipping-addresses"][":shippingAddressId"].$put({
          param: { accountId, shippingAddressId },
          json: body,
          header: headers,
        }),
      );
    },
    async setDefaultShippingAddress<T>(accountId: string, shippingAddressId: string): Promise<T> {
      return parseJsonResponse<T>(
        await client.accounts[":accountId"]["shipping-addresses"][":shippingAddressId"].default.$post({
          param: { accountId, shippingAddressId },
          json: {},
          header: headers,
        }),
      );
    },
    async archiveShippingAddress<T>(accountId: string, shippingAddressId: string): Promise<T> {
      return parseJsonResponse<T>(
        await client.accounts[":accountId"]["shipping-addresses"][":shippingAddressId"].archive.$post({
          param: { accountId, shippingAddressId },
          json: {},
          header: headers,
        }),
      );
    },
    async getCurrentActorDisplay<T>(): Promise<T> {
      return parseJsonResponse<T>(await client["current-actor-display"].$get({ header: headers }));
    },
    async getUserPreferences<T>(): Promise<T> {
      return parseJsonResponse<T>(await client.preferences.$get({ header: headers }));
    },
    async updateUserPreferences<T>(body: Record<string, unknown>): Promise<T> {
      return parseJsonResponse<T>(await client.preferences.$put({ json: body, header: headers }));
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
      return parseJsonResponse<T>(await client.users[":id"].$get({ param: { id }, header: headers }));
    },
    async updateUser<T>(id: string, body: Record<string, unknown>): Promise<T> {
      return parseJsonResponse<T>(await client.users[":id"].$put({ param: { id }, json: body, header: headers }));
    },
    async suspendUser<T>(id: string): Promise<T> {
      return parseJsonResponse<T>(
        await client.users[":id"].suspend.$post({ param: { id }, json: {}, header: headers }),
      );
    },
    async reactivateUser<T>(id: string): Promise<T> {
      return parseJsonResponse<T>(
        await client.users[":id"].reactivate.$post({ param: { id }, json: {}, header: headers }),
      );
    },
    async addUserContactMethod<T>(id: string, body: Record<string, unknown>): Promise<T> {
      return parseJsonResponse<T>(
        await client.users[":id"]["contact-methods"].$post({ param: { id }, json: body, header: headers }),
      );
    },
    async verifyUserContactMethod<T>(id: string, contactMethodId: string): Promise<T> {
      return parseJsonResponse<T>(
        await client.users[":id"]["contact-methods"][":contactMethodId"].verify.$post({
          param: { id, contactMethodId },
          json: {},
          header: headers,
        }),
      );
    },
    async enableUserAuthMethod<T>(id: string, authMethod: string): Promise<T> {
      return parseJsonResponse<T>(
        await client.users[":id"]["auth-methods"].$post({
          param: { id },
          json: { authMethod },
          header: headers,
        }),
      );
    },
    async disableUserAuthMethod<T>(id: string, authMethod: string): Promise<T> {
      return parseJsonResponse<T>(
        await client.users[":id"]["auth-methods"][":authMethod"].$delete({
          param: { id, authMethod },
          header: headers,
        }),
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
      return parseJsonResponse<T>(await client.memberships[":id"].$get({ param: { id }, header: headers }));
    },
    async createMembership<T>(body: Record<string, unknown>): Promise<T> {
      return parseJsonResponse<T>(await client.memberships.$post({ json: body, header: headers }));
    },
    async changeMembershipRole<T>(id: string, roleKey: string): Promise<T> {
      return parseJsonResponse<T>(
        await client.memberships[":id"].role.$put({ param: { id }, json: { roleKey }, header: headers }),
      );
    },
    async revokeMembership<T>(id: string): Promise<T> {
      return parseJsonResponse<T>(
        await client.memberships[":id"].revoke.$post({ param: { id }, json: {}, header: headers }),
      );
    },
    async reinstateMembership<T>(id: string): Promise<T> {
      return parseJsonResponse<T>(
        await client.memberships[":id"].reinstate.$post({ param: { id }, json: {}, header: headers }),
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
      return parseJsonResponse<T>(await client.invitations[":id"].$get({ param: { id }, header: headers }));
    },
    async createInvitation<T>(body: Record<string, unknown>): Promise<T> {
      return parseJsonResponse<T>(await client.invitations.$post({ json: body, header: headers }));
    },
    async resendInvitation<T>(id: string, expiresAt: string): Promise<T> {
      return parseJsonResponse<T>(
        await client.invitations[":id"].resend.$post({ param: { id }, json: { expiresAt }, header: headers }),
      );
    },
    async cancelInvitation<T>(id: string): Promise<T> {
      return parseJsonResponse<T>(
        await client.invitations[":id"].cancel.$post({ param: { id }, json: {}, header: headers }),
      );
    },
    async declineInvitation<T>(id: string): Promise<T> {
      return parseJsonResponse<T>(
        await client.invitations[":id"].decline.$post({ param: { id }, json: {}, header: headers }),
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
      return parseJsonResponse<T>(await client["api-keys"][":id"].$get({ param: { id }, header: headers }));
    },
    async createApiKey<T>(body: Record<string, unknown>): Promise<T> {
      return parseJsonResponse<T>(await client["api-keys"].$post({ json: body, header: headers }));
    },
    async revokeApiKey<T>(id: string): Promise<T> {
      return parseJsonResponse<T>(
        await client["api-keys"][":id"].revoke.$post({ param: { id }, json: {}, header: headers }),
      );
    },
    async rotateApiKey<T>(id: string): Promise<T> {
      return parseJsonResponse<T>(
        await client["api-keys"][":id"].rotate.$post({ param: { id }, json: {}, header: headers }),
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
    async withdrawConsent<T>(id: string): Promise<T> {
      return parseJsonResponse<T>(
        await client.consents[":id"].withdraw.$post({ param: { id }, json: {}, header: headers }),
      );
    },
  };
}

export const identityApi = createIdentityApiClient();

export type IdentityListResponse<T> = ListResponse<T>;
