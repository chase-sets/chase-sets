import {
  createActorEventStoreContext as createGenericActorEventStoreContext,
  hasPermission as hasActorPermission,
  requireActorFromAuthApi,
  resolveActorFromAuthApi,
  type ResolvedActor,
} from "@chase-sets/platform-runtime/auth";
import {
  createPlatformInternalAuthHeaders,
  createForwardedAuthFetch,
  resolveRequestApiBaseUrl,
} from "@chase-sets/platform-runtime/http";
import type { PermissionKey } from "./support/runtime-support/common";
import {
  createIdentityApiClient,
  IdentityApiError,
} from "./support/request-support/api-client";
import { hasPermission } from "./support/request-support/permissions";

export type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
export type { CurrentActorDisplay } from "./support/request-support/current-actor-display";
export type { ShippingAddress } from "./features/shipping-addresses/api/contracts";
export {
  bootstrapPlatformAdminIdentity,
  type PlatformAdminBootstrapConfig,
  type PlatformAdminBootstrapResult,
} from "./support/runtime-support/production-bootstrap";
export {
  createLinkedPlatformAuthorizationStore,
  type LinkedPlatformAuthorizationRow,
  type LinkedPlatformAuthorizationStore,
} from "./support/ucp-support/linked-platform-authorizations";

function isSafeReturnTo(value: string | null) {
  return Boolean(value && value.startsWith("/") && !value.startsWith("//"));
}

export function getSafeReturnTo(request: Request, fallback: string) {
  const returnTo = new URL(request.url).searchParams.get("returnTo");
  return isSafeReturnTo(returnTo) ? returnTo! : fallback;
}

export function createIdentityRequestApiClient(request: Request) {
  return createIdentityApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/identity"),
    fetch: createForwardedAuthFetch(request),
  });
}

export type IdentityAuthMutationClient = Readonly<{
  createGuestAccount: (params: Readonly<{
    email: string;
    displayName: string;
  }>) => Promise<Readonly<{ accountId: string }>>;
  createUser: (params: Readonly<{
    email: string;
    displayName: string;
  }>) => Promise<Readonly<{ userId: string }>>;
  createPersonalIdentity: (params: Readonly<{
    email?: string | null;
    phone?: string | null;
    displayName: string;
    givenName?: string;
    familyName?: string;
    consents?: readonly { policyKey: string; policyVersion: string }[];
  }>) => Promise<Readonly<{ userId: string; accountId: string; membershipId: string }>>;
  enablePasswordCredential: (params: Readonly<{
    userId: string;
    credentialId: string;
  }>) => Promise<void>;
  registerPasskeyCredential: (params: Readonly<{
    userId: string;
    credentialId: string;
  }>) => Promise<void>;
  enableSmsCode: (params: Readonly<{
    userId: string;
  }>) => Promise<void>;
  linkSocialLogin: (params: Readonly<{
    userId: string;
    providerName: "google" | "facebook";
    providerSubject: string;
    email: string;
  }>) => Promise<void>;
  claimGuestAccount: (params: Readonly<{
    accountId: string;
    userId: string;
    roleKey: string;
  }>) => Promise<Readonly<{ membershipId: string }>>;
  acceptInvitationForUser: (params: Readonly<{
    invitationId: string;
    userId: string;
    accountId: string;
    roleKey: string;
  }>) => Promise<Readonly<{ membershipId: string }>>;
}>;

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new IdentityApiError(response.status, errorBody);
  }

  return response.json() as Promise<T>;
}

export function createIdentityAuthRequestClient(
  request: Request,
): IdentityAuthMutationClient {
  const fetch = createForwardedAuthFetch(request);
  const baseUrl = resolveRequestApiBaseUrl(request, "/api/identity/internal/auth");
  const postJson = async <T>(path: string, body: Record<string, unknown>) =>
    parseJsonResponse<T>(
      await fetch(new URL(path, `${baseUrl}/`), {
        method: "POST",
        headers: createPlatformInternalAuthHeaders({
          "Content-Type": "application/json",
        }),
        body: JSON.stringify(body),
      }),
    );

  return {
    createGuestAccount: (params) => postJson("guest-accounts", params),
    createUser: (params) => postJson("users", params),
    createPersonalIdentity: (params) => postJson("personal-identities", params),
    enablePasswordCredential: async ({ userId, credentialId }) => {
      await postJson(`users/${userId}/password-credential`, { credentialId });
    },
    registerPasskeyCredential: async ({ userId, credentialId }) => {
      await postJson(`users/${userId}/passkey-credential`, { credentialId });
    },
    enableSmsCode: async ({ userId }) => {
      await postJson(`users/${userId}/sms-code`, {});
    },
    linkSocialLogin: async ({ userId, providerName, providerSubject, email }) => {
      await postJson(`users/${userId}/social-login-link`, {
        providerName,
        providerSubject,
        email,
      });
    },
    claimGuestAccount: ({ accountId, userId, roleKey }) =>
      postJson(`guest-accounts/${accountId}/claim`, {
        userId,
        roleKey,
      }),
    acceptInvitationForUser: ({ invitationId, userId, accountId, roleKey }) =>
      postJson(`invitations/${invitationId}/accept`, {
        userId,
        accountId,
        roleKey,
      }),
  };
}

export function createActorEventStoreContext(
  actor: ResolvedActor,
) {
  return createGenericActorEventStoreContext(actor);
}

export async function resolveActorFromIdentityApi(options: Readonly<{
  identityApiBaseUrl: string;
  request: Request;
  fetch?: typeof globalThis.fetch;
}>): Promise<ResolvedActor | null> {
  const authApiBaseUrl = new URL(options.identityApiBaseUrl);
  authApiBaseUrl.pathname = "/api/auth";
  return resolveActorFromAuthApi({
    authApiBaseUrl: authApiBaseUrl.toString().replace(/\/$/, ""),
    request: options.request,
    fetch: options.fetch,
  });
}

export async function requireActorFromIdentityApi(options: Readonly<{
  request: Request;
  permission?: PermissionKey;
  signInPath?: string;
  identityApiBaseUrl?: string;
  fetch?: typeof globalThis.fetch;
}>): Promise<ResolvedActor> {
  return requireActorFromAuthApi({
    request: options.request,
    permission: options.permission,
    signInPath: options.signInPath,
    authApiBaseUrl:
      options.identityApiBaseUrl
        ? new URL("/api/auth", `${options.identityApiBaseUrl}/`).toString().replace(/\/$/, "")
        : resolveRequestApiBaseUrl(options.request, "/api/auth"),
    fetch: options.fetch,
  });
}
