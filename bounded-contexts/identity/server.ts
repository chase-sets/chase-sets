import {
  createActorEventStoreContext as createGenericActorEventStoreContext,
  hasPermission as hasActorPermission,
  type ResolvedActor,
} from "@chase-sets/platform-runtime/auth";
import {
  createPlatformInternalAuthHeaders,
  createForwardedAuthFetch,
  resolveRequestApiBaseUrl,
} from "@chase-sets/platform-runtime/http";
import { attachResponseMetadata } from "@chase-sets/http/responses";
import { createIdentityApiClient, IdentityApiError } from "./support/request-support/api-client";
import { hasPermission } from "./support/request-support/permissions";

export type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
export type { CurrentActorDisplay } from "./support/shell-support/current-actor-display";
export {
  displayActorAccountName,
  displayActorUserName,
  displayRole,
} from "./support/shell-support/current-actor-display";
export { resolveIdentityShellViewer } from "./support/shell-support/viewer";
export type { IdentityShellViewer, IdentityShellViewerPreferences } from "./support/shell-support/viewer";
export {
  USER_PREFERENCES_COLOR_MODE_COOKIE_NAME,
  appendUserPreferencesColorModeCookie,
  createUserPreferencesColorModeCookieSeedHeaders,
  isUserPreferencesColorMode,
  readUserPreferencesColorModeCookie,
  serializeUserPreferencesColorModeCookie,
} from "./features/preferences/api/color-mode-cookie";
export type { ShippingAddress } from "./features/shipping-addresses/api/contracts";
export {
  bootstrapPlatformAdminIdentity,
  type PlatformAdminBootstrapConfig,
  type PlatformAdminBootstrapResult,
} from "./support/runtime-support/production-bootstrap";
export {
  ADMIN_QA_ACTOR_FIXTURES,
  provisionAdminQaActorFixtures,
  type AdminQaActorFixtureDefinition,
  type AdminQaActorFixtureResult,
  type AdminQaActorFixtureSignInHost,
} from "./support/runtime-support/admin-qa-actor-fixtures";
export {
  createLinkedPlatformAuthorizationStore,
  type LinkedPlatformAuthorizationRow,
  type LinkedPlatformAuthorizationStore,
} from "./support/ucp-support/linked-platform-authorizations";
export {
  requestWithoutFreshWrite,
  requireActorFromIdentityApi,
  resolveActorFromIdentityApi,
} from "./support/route-support/identity-request";

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
    fetch: createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "identity" }),
  });
}

export type IdentityCommandSnapshot = Readonly<{
  aggregate: "account" | "api-key" | "consent" | "invitation" | "membership" | "user";
  id: string;
  version: number;
  status: string;
}>;

export type IdentityAuthMutationClient = Readonly<{
  createGuestAccount: (
    params: Readonly<{
      email: string;
      displayName: string;
    }>,
  ) => Promise<Readonly<{ accountId: string; snapshots: readonly IdentityCommandSnapshot[] }>>;
  createUser: (
    params: Readonly<{
      email: string;
      displayName: string;
    }>,
  ) => Promise<Readonly<{ userId: string; snapshots: readonly IdentityCommandSnapshot[] }>>;
  createPersonalIdentity: (
    params: Readonly<{
      email?: string | null;
      phone?: string | null;
      displayName: string;
      givenName?: string;
      familyName?: string;
      consents?: readonly { policyKey: string; policyVersion: string }[];
      foundersBetaAccessStartedAt?: string;
    }>,
  ) => Promise<
    Readonly<{
      userId: string;
      accountId: string;
      membershipId: string;
      snapshots: readonly IdentityCommandSnapshot[];
    }>
  >;
  enablePasswordCredential: (
    params: Readonly<{
      userId: string;
      credentialId: string;
    }>,
  ) => Promise<Readonly<{ ok: true; userId: string; snapshots: readonly IdentityCommandSnapshot[] }>>;
  registerPasskeyCredential: (
    params: Readonly<{
      userId: string;
      credentialId: string;
    }>,
  ) => Promise<Readonly<{ ok: true; userId: string; snapshots: readonly IdentityCommandSnapshot[] }>>;
  enableSmsCode: (
    params: Readonly<{
      userId: string;
    }>,
  ) => Promise<Readonly<{ ok: true; userId: string; snapshots: readonly IdentityCommandSnapshot[] }>>;
  linkSocialLogin: (
    params: Readonly<{
      userId: string;
      providerName: "google" | "facebook";
      providerSubject: string;
      email: string;
    }>,
  ) => Promise<Readonly<{ ok: true; userId: string; snapshots: readonly IdentityCommandSnapshot[] }>>;
  claimGuestAccount: (
    params: Readonly<{
      accountId: string;
      userId: string;
      roleKey: string;
    }>,
  ) => Promise<Readonly<{ membershipId: string; snapshots: readonly IdentityCommandSnapshot[] }>>;
  acceptInvitationForUser: (
    params: Readonly<{
      invitationId: string;
      userId: string;
      acceptanceTokenHash: string;
    }>,
  ) => Promise<Readonly<{ membershipId: string; snapshots: readonly IdentityCommandSnapshot[] }>>;
  issueInvitationAcceptanceToken: (
    params: Readonly<{
      invitationId: string;
      tokenHash: string;
      expiresAt: string;
    }>,
  ) => Promise<
    Readonly<{
      invitationId: string;
      accountId: string;
      email: string;
      roleKey: string;
      expiresAt: string;
      snapshots: readonly IdentityCommandSnapshot[];
    }>
  >;
  verifyInvitationAcceptanceToken: (
    params: Readonly<{
      invitationId: string;
      acceptanceTokenHash: string;
    }>,
  ) => Promise<
    Readonly<{
      invitationId: string;
      accountId: string;
      email: string;
      roleKey: string;
      expiresAt: string;
    }>
  >;
  verifyEmailContactMethod: (
    params: Readonly<{
      userId: string;
      email: string;
    }>,
  ) => Promise<Readonly<{ ok: true; userId: string; snapshots: readonly IdentityCommandSnapshot[] }>>;
}>;

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new IdentityApiError(response.status, errorBody);
  }

  return attachResponseMetadata(await response.json(), response) as T;
}

export function createIdentityAuthRequestClient(request: Request): IdentityAuthMutationClient {
  const fetch = createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "identity" });
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
    enablePasswordCredential: ({ userId, credentialId }) =>
      postJson(`users/${userId}/password-credential`, { credentialId }),
    registerPasskeyCredential: ({ userId, credentialId }) =>
      postJson(`users/${userId}/passkey-credential`, { credentialId }),
    enableSmsCode: ({ userId }) => postJson(`users/${userId}/sms-code`, {}),
    linkSocialLogin: ({ userId, providerName, providerSubject, email }) =>
      postJson(`users/${userId}/social-login-link`, {
        providerName,
        providerSubject,
        email,
      }),
    claimGuestAccount: ({ accountId, userId, roleKey }) =>
      postJson(`guest-accounts/${accountId}/claim`, {
        userId,
        roleKey,
      }),
    acceptInvitationForUser: ({ invitationId, userId, acceptanceTokenHash }) =>
      postJson(`invitations/${invitationId}/accept`, {
        userId,
        acceptanceTokenHash,
      }),
    issueInvitationAcceptanceToken: ({ invitationId, tokenHash, expiresAt }) =>
      postJson(`invitations/${invitationId}/acceptance-token`, {
        tokenHash,
        expiresAt,
      }),
    verifyInvitationAcceptanceToken: ({ invitationId, acceptanceTokenHash }) =>
      postJson(`invitations/${invitationId}/verify-acceptance-token`, {
        acceptanceTokenHash,
      }),
    verifyEmailContactMethod: ({ userId, email }) => postJson(`users/${userId}/email-verification`, { email }),
  };
}

export function createActorEventStoreContext(actor: ResolvedActor) {
  return createGenericActorEventStoreContext(actor);
}
