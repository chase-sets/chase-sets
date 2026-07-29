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
  ADMIN_QA_ACTOR_FIXTURE_CAPABILITIES,
  provisionAdminQaActorFixtures,
  type AdminQaActorFixtureCapability,
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
export {
  createIdentityTermsAcceptanceResolver,
  type TermsAcceptanceStatus,
} from "./features/consents/api/terms-acceptance-resolver";
/**
 * The host port's resolver function itself, exported alongside the pool-bound
 * factory so a consuming context can drive Identity's real acceptance rule from
 * its own suite instead of asserting against a hand-written stand-in that cannot
 * disagree with it.
 */
export { resolveTermsAcceptanceStatus } from "./features/consents/read-model/terms-acceptance";
export {
  identityTermsOfServicePolicy,
  type TermsOfServicePolicyValue,
} from "./features/consents/domain/terms-of-service-policy";
export {
  isRegistrationConsentRejectionCode,
  REGISTRATION_CONSENT_AFFIRMATION_REQUIRED_CODE,
  REGISTRATION_CONSENT_BUNDLE_KEY,
  REGISTRATION_CONSENT_EXPIRED_CODE,
  REGISTRATION_CONSENT_NOT_SERVER_MINTED_CODE,
  REGISTRATION_CONSENT_REJECTION_CODES,
  type RegistrationConsentRejectionCode,
  type RegistrationConsentRequirement,
  type RegistrationConsentSubmission,
  type SignedRegistrationConsentResolution,
} from "./features/consents/domain/registration-consent";
import type { SignedRegistrationConsentResolution } from "./features/consents/domain/registration-consent";

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

export type {
  IdentityAuthMutationClient,
  IdentityCommandSnapshot,
} from "./support/request-support/auth-mutation-client";
import type { IdentityAuthMutationClient } from "./support/request-support/auth-mutation-client";

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

  const getJson = async <T>(path: string) =>
    parseJsonResponse<T>(
      await fetch(new URL(path, `${baseUrl}/`), {
        method: "GET",
        headers: createPlatformInternalAuthHeaders(),
      }),
    );

  return {
    resolveRegistrationConsent: () => getJson<SignedRegistrationConsentResolution>("registration-consent"),
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
export { identitySeedIds } from "./support/seed-support/ids";
