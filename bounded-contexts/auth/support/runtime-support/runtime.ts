import { normalizeAgentOAuthScopes, type ResolvedActor } from "@chase-sets/auth-context";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { readAuthSessionToken, readCookie } from "../auth-support/http";
import { AUTH_GUEST_CHECKOUT_COOKIE_NAME } from "../request-support/cookies";
import type { AuthServices } from "./services";
import { createAuthBootstrapContext as createAuthBootstrapEventContext } from "../auth-support/identity-projection";
import { getGuestCheckoutTokenByHash, getSessionByTokenHash } from "../auth-support/store";
import { resolveActorFromSessionId } from "./services";
import { resolveUcpScopedPermissions } from "../ucp-support/oauth";
export { readAuthSessionToken } from "../auth-support/http";

export const AUTH_GUEST_CHECKOUT_USER_ID = "usr_guest_checkout" as const;
export const AUTH_GUEST_CHECKOUT_ROLE_KEY = "guest-buyer" as const;
export const AUTH_GUEST_CHECKOUT_PERMISSIONS = ["guest-checkout.manage"] as const;

const UCP_ACCESS_TOKEN_PREFIX = "ucp_at_";

export type AuthLinkedPlatformAuthorization = Readonly<{
  authorization_id: string;
  user_id: string;
  account_id: string;
  scopes: readonly string[];
}>;

export type AuthLinkedPlatformAuthorizationResolver = Readonly<{
  resolveAccessToken: (accessTokenHash: string) => Promise<AuthLinkedPlatformAuthorization | null>;
}>;

export type AuthRequestActorResolverOptions = Readonly<{
  linkedPlatformAuthorizations?: AuthLinkedPlatformAuthorizationResolver | null;
}>;

export function createAuthBootstrapContext(_services: AuthServices): EventStoreContext {
  return createAuthBootstrapEventContext();
}

export async function resolveActorFromSessionToken(
  services: AuthServices,
  sessionToken: string,
): Promise<ResolvedActor | null> {
  const tokenRecord = await getSessionByTokenHash(services.db, services.auth.hashSecret(sessionToken));

  if (!tokenRecord || new Date(tokenRecord.expires_at).getTime() <= Date.now()) {
    return null;
  }

  return resolveActorFromSessionId(services, tokenRecord.session_id);
}

export function isGuestCheckoutActor(actor: ResolvedActor | null | undefined): actor is ResolvedActor {
  return actor?.roleKey === AUTH_GUEST_CHECKOUT_ROLE_KEY;
}

export function createGuestCheckoutActor(
  services: AuthServices,
  tokenRecord: Readonly<{ token_id: string; account_id: string }>,
): ResolvedActor {
  return {
    sessionId: `guest:${tokenRecord.token_id}`,
    tenantId: services.identity.bootstrapTenantId,
    userId: AUTH_GUEST_CHECKOUT_USER_ID,
    accountId: tokenRecord.account_id,
    membershipId: `guest:${tokenRecord.token_id}`,
    roleKey: AUTH_GUEST_CHECKOUT_ROLE_KEY,
    permissions: AUTH_GUEST_CHECKOUT_PERMISSIONS,
  };
}

export async function resolveGuestCheckoutActor(
  services: AuthServices,
  request: Request,
): Promise<ResolvedActor | null> {
  const guestToken = readCookie(request, AUTH_GUEST_CHECKOUT_COOKIE_NAME);
  if (!guestToken) {
    return null;
  }

  const tokenRecord = await getGuestCheckoutTokenByHash(services.db, services.auth.hashSecret(guestToken));
  if (!tokenRecord || new Date(tokenRecord.expires_at).getTime() <= Date.now()) {
    return null;
  }

  return createGuestCheckoutActor(services, tokenRecord);
}

export async function resolveActorFromRequest(
  services: AuthServices,
  request: Request,
  options: AuthRequestActorResolverOptions = {},
): Promise<ResolvedActor | null> {
  const linkedActor = await resolveLinkedPlatformActor(services, request, options.linkedPlatformAuthorizations ?? null);
  if (linkedActor) {
    return linkedActor;
  }

  const sessionToken = readAuthSessionToken(request);
  if (!sessionToken) {
    return resolveGuestCheckoutActor(services, request);
  }

  return (
    (await resolveActorFromSessionToken(services, sessionToken)) ?? (await resolveGuestCheckoutActor(services, request))
  );
}

function readBearerToken(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  return authorization.slice("Bearer ".length).trim() || null;
}

async function resolveLinkedPlatformActor(
  services: AuthServices,
  request: Request,
  linkedPlatformAuthorizations: AuthLinkedPlatformAuthorizationResolver | null,
): Promise<ResolvedActor | null> {
  if (!linkedPlatformAuthorizations) {
    return null;
  }

  const token = readBearerToken(request);
  if (!token?.startsWith(UCP_ACCESS_TOKEN_PREFIX)) {
    return null;
  }

  const linked = await linkedPlatformAuthorizations.resolveAccessToken(services.auth.hashSecret(token));
  if (!linked) {
    return null;
  }

  const membership = await services.identity.getActiveMembershipForUserAccount(linked.user_id, linked.account_id);
  if (!membership) {
    return null;
  }

  const rolePermissions = membership.role_permissions as readonly string[];
  const scopes = normalizeAgentOAuthScopes(linked.scopes);

  return {
    sessionId: `ucp:${linked.authorization_id}`,
    tenantId: services.identity.bootstrapTenantId,
    userId: linked.user_id,
    accountId: linked.account_id,
    membershipId: membership.membership_id,
    roleKey: membership.role_key,
    permissions: resolveUcpScopedPermissions(scopes, rolePermissions),
    agentGrant: {
      grantId: linked.authorization_id,
      scopes,
      rolePermissions,
    },
  };
}
